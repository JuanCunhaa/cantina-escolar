import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { isLocalDate, localDateOf } from "@/lib/dates/school-time";
import { conflict, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import type { FeeRecord } from "@/modules/payments/methods";
import type { Settlement } from "@/modules/payments/topup-model";
import { isSafeLabel } from "@/modules/students/normalize";
import { effectiveFee } from "./fee-model";
import { RECEIPT_KINDS, parseReceipt, receiptDocRef, receiptPath, type ReceiptKind } from "./receipts";

/**
 * Conferência do valor REAL da taxa e da liquidação de um recebimento (F20, docs/domains/payments.md §6.5). Só a administração
 * (`finance.manage`). Um recebimento tem UMA taxa efetiva: conferir substitui a estimada/informada (o relatório usa o real e nunca
 * soma os dois); corrigir um valor já conferido exige motivo e deixa o evento anterior preservado em `reconciliations`. Não toca a
 * carteira, o livro nem o crédito (sempre o valor bruto). `expectedVersion` impede que duas telas conferam o mesmo recebimento.
 */
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const REF = /^(topup|online_topup|direct_sale):([A-Za-z0-9_-]{1,128})$/;
const allowFinance = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "finance.manage");

export const reconcileSchema = z
  .object({
    key: z.string().regex(KEY),
    ref: z.string().regex(REF),
    expectedVersion: z.number().int().min(0).max(10_000),
    /** Taxa real em centavos OU o líquido realmente recebido (bruto − líquido = taxa). Nunca os dois. */
    actualFeeCents: z.number().int().min(0).max(1_000_000).optional(),
    netReceivedCents: z.number().int().min(0).max(1_000_000).optional(),
    settledOn: z.string().refine(isLocalDate, "Data inválida.").optional(),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(200)
      .refine(isSafeLabel, "Texto inválido.")
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.actualFeeCents !== undefined && v.netReceivedCents !== undefined) ctx.addIssue({ code: "custom", path: ["netReceivedCents"], message: "Informe a taxa OU o líquido recebido." });
    if (v.actualFeeCents === undefined && v.netReceivedCents === undefined && v.settledOn === undefined) ctx.addIssue({ code: "custom", path: ["actualFeeCents"], message: "Nada a conferir." });
  });

export type ReconcileResult = {
  ref: string;
  financeVersion: number;
  fee: FeeRecord;
  settlement: Settlement;
  effective: { basis: string; cents: number | null; estimatedCents: number | null; differenceCents: number | null };
  eventId: string;
};

export async function reconcileReceipt(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<ReconcileResult & { replayed: boolean }> {
  authorize(actor, "finance.manage");
  const input = reconcileSchema.parse(raw);
  const [, kindRaw, id] = REF.exec(input.ref) as unknown as [string, ReceiptKind, string];
  if (!RECEIPT_KINDS.includes(kindRaw)) throw notFound("receipt_not_found", "Recebimento não encontrado.");
  const kind = kindRaw;
  const eventId = deterministicId("rcn", actor.uid, input.key);

  return runIdempotentCommand(db, actor, { scope: "finance.reconcile", key: input.key, payload: input, allow: allowFinance }, async ({ tx, actor: current, profile, auditId }) => {
    const today = localDateOf(clock());
    const ref = receiptDocRef(db, kind, id);
    const snap = await tx.get(ref);
    const receipt = snap.exists ? parseReceipt(kind, id, snap.data()!) : null;
    if (!receipt) throw notFound("receipt_not_found", "Recebimento não encontrado.");
    if (receipt.method === "cash") throw conflict("not_applicable", "Dinheiro não tem taxa nem liquidação bancária a conferir.");
    if (input.expectedVersion !== receipt.financeVersion) throw conflict("stale_receipt", "O recebimento foi conferido por outra operação: confira os valores atuais.", { financeVersion: receipt.financeVersion });

    const before = { fee: receipt.fee, settlement: receipt.settlement };
    let fee = receipt.fee;
    let settlement = receipt.settlement;
    let correction = false;

    const actual = input.actualFeeCents ?? (input.netReceivedCents !== undefined ? receipt.grossCents - input.netReceivedCents : undefined);
    if (actual !== undefined && !(receipt.fee.status === "confirmed" && receipt.fee.cents === actual)) {
      if (actual < 0 || actual > receipt.grossCents) throw conflict("invalid_fee", "A taxa precisa estar entre zero e o valor recebido.", { grossCents: receipt.grossCents });
      if (receipt.fee.status === "confirmed") correction = true; // trocar um valor já conferido
      fee = { status: "confirmed", cents: actual, source: "operator" };
    }
    if (input.settledOn !== undefined && !(receipt.settlement.status === "settled" && receipt.settlement.settledOn === input.settledOn)) {
      if (input.settledOn < receipt.receivedOn || input.settledOn > today) throw conflict("invalid_settlement_date", "A liquidação real fica entre a data do recebimento e hoje.", { min: receipt.receivedOn, max: today });
      if (receipt.settlement.status === "settled") correction = true;
      settlement = { ...receipt.settlement, status: "settled", settledOn: input.settledOn };
    }
    if (fee === receipt.fee && settlement === receipt.settlement) throw conflict("nothing_to_change", "Nada mudou em relação ao que já está registrado.");
    if (correction && !input.reason) throw conflict("correction_requires_reason", "Corrigir um valor já conferido exige motivo.");

    const stamp = FieldValue.serverTimestamp();
    const financeVersion = receipt.financeVersion + 1;
    const netCents = fee.cents === null ? null : receipt.grossCents - fee.cents;
    tx.update(ref, {
      [receiptPath(kind, "fee")]: fee,
      [receiptPath(kind, "settlement")]: settlement,
      ...(kind === "online_topup" ? {} : { [receiptPath(kind, "netCents")]: netCents }),
      [receiptPath(kind, "financeVersion")]: financeVersion,
    });
    tx.create(db.doc(`${ref.path}/reconciliations/${eventId}`), {
      eventId,
      ref: input.ref,
      seq: financeVersion,
      before,
      after: { fee, settlement },
      correction,
      reason: input.reason ?? null,
      operator: { uid: current.uid, name: profile.displayName },
      createdOn: today,
      createdAt: stamp,
    });
    auditInTransaction(db, tx, auditId, {
      action: "finance.reconcile",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: kind, id },
      ...(input.reason ? { reason: input.reason } : {}),
      before: { feeStatus: before.fee.status, feeCents: before.fee.cents, settlement: before.settlement.status, settledOn: before.settlement.settledOn },
      after: { feeStatus: fee.status, feeCents: fee.cents, settlement: settlement.status, settledOn: settlement.settledOn, correction, financeVersion },
    });
    const eff = effectiveFee(fee, receipt.feeEstimate);
    return { ref: input.ref, financeVersion, fee, settlement, effective: { basis: eff.basis, cents: eff.cents, estimatedCents: eff.estimatedCents, differenceCents: eff.differenceCents }, eventId };
  });
}
