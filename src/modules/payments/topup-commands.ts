import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { localDateOf } from "@/lib/dates/school-time";
import { conflict, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { assertTerminalFor, feeApplicationOf, feeRefs, refsToRead } from "@/modules/fees/fee-store";
import { applyDelta, parseWalletState } from "@/modules/wallet/model";
import {
  amountsOf,
  checkSettlementDate,
  familyOf,
  normalizeReference,
  planReversal,
  reversalEntryReason,
  reversalSchema,
  settlementOf,
  topupEntryReason,
  topupSchema,
  type ReversalReason,
} from "./topup-model";
import { referenceKeyId } from "./topup-keys";
import { parseTopup, topupView, type TopupView } from "./topup-queries";

/**
 * Comandos da recarga manual (F17). Ambos: servidor autenticado, perfil ATUAL relido na transação (`runIdempotentCommand`
 * com a capacidade exigida — rebaixado, desativado ou sem a permissão extra = 403, inclusive na repetição), idempotentes por
 * chave + payload, leituras antes das escritas, SEM chamada externa no callback. Recebimento, carteira, livro, unicidade da
 * referência e auditoria são gravados juntos ou nada é gravado.
 */
const allowRegister = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "topup.register");
const allowReverse = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "topup.reverse");

/**
 * Registra recebimento confirmado e credita o valor BRUTO na carteira do aluno ativo, numa transação:
 *   1. aluno ativo; 2. referência normalizada livre (uniquenessKeys) — ocupada = 409 `duplicate_reference`, nada gravado;
 *   3. carteira (teto de saldo); 4. gravações: `topups/{id}`, lançamento `topup` (+bruto), carteira, chave de unicidade e
 *   auditoria `topup.manual.register`.
 * A taxa é registrada como despesa (líquido = bruto − taxa) e nunca reduz o crédito.
 */
export async function registerManualTopup(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<TopupView & { replayed: boolean }> {
  authorize(actor, "topup.register");
  const input = topupSchema.parse(raw);
  const topupId = deterministicId("tpm", actor.uid, input.key);
  const entryId = `${topupId}_credit`;
  const normalized = input.reference ? normalizeReference(input.reference) : "";
  const family = familyOf(input.method);
  const keyRef = normalized ? db.doc(`uniquenessKeys/${referenceKeyId(family, normalized)}`) : null;

  return runIdempotentCommand(db, actor, { scope: "topup.manual", key: input.key, payload: input, allow: allowRegister }, async ({ tx, actor: current, profile, auditId }) => {
    const now = clock();
    const today = localDateOf(now);
    checkSettlementDate(today, input.expectedSettlementOn);

    const walletRef = db.doc(`wallets/${input.studentId}`);
    const refs = feeRefs(db, input.method, input.sourceId);
    const [student, walletSnap, ...rest] = await tx.getAll(db.doc(`students/${input.studentId}`), walletRef, ...(keyRef ? [keyRef] : []), ...refsToRead(refs));
    const keySnap = keyRef ? rest[0] : undefined;
    const feeSnaps = keyRef ? rest.slice(1) : rest;
    if (!student?.exists) throw notFound("student_not_found", "Aluno não encontrado.");
    if (student.get("status") !== "active") throw conflict("student_inactive", "Aluno inativo.");
    if (keySnap?.exists && keySnap.get("status") === "active") {
      throw conflict("duplicate_reference", "Este recebimento já foi lançado (mesma referência).", { topupId: String(keySnap.get("topupId") ?? "") });
    }
    const before = parseWalletState(walletSnap!.data());
    if (refs) assertTerminalFor(refs, feeSnaps[1]);
    const amounts = amountsOf(input);
    const rule = feeApplicationOf(refs, feeSnaps[0], { grossCents: amounts.grossCents, receivedOn: today });
    const wallet = applyDelta(before, amounts.creditedCents); // teto de saldo

    const stamp = FieldValue.serverTimestamp();
    const operator = { uid: current.uid, role: current.role ?? null, name: profile.displayName };
    const reference = normalized && keyRef ? { raw: input.reference!.trim(), normalized, family, keyId: keyRef.id } : null;
    const record = {
      topupId,
      kind: "manual" as const,
      status: "confirmed" as const,
      studentId: input.studentId,
      studentName: String(student.get("name") ?? ""),
      studentEnrollment: String(student.get("enrollment") ?? ""),
      classId: String(student.get("classId") ?? ""),
      shiftId: String(student.get("shiftId") ?? ""),
      currency: "BRL" as const,
      amountCents: amounts.grossCents,
      creditedCents: amounts.creditedCents,
      method: input.method,
      fee: amounts.fee,
      netCents: amounts.netCents,
      // Estimativa pela regra em vigor, CONGELADA com a versão usada (F20); a taxa efetiva continua sendo `fee`.
      feeEstimate: rule.estimate,
      sourceId: refs?.sourceId ?? null,
      financeVersion: 0,
      settlement: settlementOf(input.method, today, input.expectedSettlementOn, rule.expectedSettlement),
      reference,
      verification: { receivedConfirmed: true as const, payerName: input.payerName || null, note: input.note || null },
      receivedOn: today,
      operator,
      walletEntryId: entryId,
      walletSeq: wallet.version,
      balanceAfterCents: wallet.balanceCents,
      reversedCents: 0,
      reversalCount: 0,
      lastReversalId: null,
      version: 1,
    };

    tx.create(db.doc(`topups/${topupId}`), { ...record, receivedAt: stamp, createdAt: stamp, updatedAt: stamp });
    tx.create(db.doc(`wallets/${input.studentId}/entries/${entryId}`), {
      type: "topup",
      seq: wallet.version,
      amountCents: amounts.creditedCents,
      balanceAfterCents: wallet.balanceCents,
      reason: topupEntryReason(input.method),
      topupId,
      method: input.method,
      actorUid: current.uid,
      actorRole: current.role ?? null,
      referenceType: "topup",
      referenceId: topupId,
      createdAt: stamp,
    });
    tx.set(walletRef, { studentId: input.studentId, currency: "BRL", balanceCents: wallet.balanceCents, version: wallet.version, updatedAt: stamp, ...(walletSnap!.exists ? {} : { createdAt: stamp }) }, { merge: true });
    if (keyRef && reference) {
      // Referência liberada por estorno total de lançamento incorreto pode ser reutilizada; a cadeia fica registrada.
      tx.set(keyRef, { kind: "topupReference", family, topupId, studentId: input.studentId, status: "active", previousTopupId: keySnap?.exists ? String(keySnap.get("topupId") ?? "") : null, createdAt: stamp });
    }
    auditInTransaction(db, tx, auditId, {
      action: "topup.manual.register",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "topup", id: topupId },
      before: { balanceCents: before.balanceCents },
      after: {
        balanceCents: wallet.balanceCents,
        studentId: input.studentId,
        amountCents: amounts.grossCents,
        creditedCents: amounts.creditedCents,
        method: input.method,
        fee: amounts.fee,
        netCents: amounts.netCents,
        reference: reference?.normalized ?? null,
        settlement: record.settlement.status,
        reusedReferenceOf: keySnap?.exists ? String(keySnap.get("topupId") ?? "") : null,
      },
    });
    return topupView(parseTopup(topupId, { ...record, receivedAt: now, createdAt: now }), []);
  });
}

export type ReversalResult = {
  reversalId: string;
  topupId: string;
  studentId: string;
  amountCents: number;
  reasonCode: ReversalReason;
  walletEntryId: string;
  walletSeq: number;
  /** Carteira DEPOIS do estorno (a tela reconcilia pela `version`). */
  wallet: { studentId: string; balanceCents: number; version: number };
  topup: { status: string; reversedCents: number; reversibleCents: number; referenceReleased: boolean };
};

/**
 * Estorno de recarga manual: permissão SEPARADA `topup.reverse` (administração; secretaria só com a permissão extra
 * individual), motivo e vínculo ao lançamento original. NOVO movimento `topup_reversal` (negativo) na carteira ORIGINAL; o
 * lançamento e o registro da recarga NÃO são alterados além do acumulado estornado/situação. Limitado ao restante
 * estornável e ao saldo atual (sem saldo negativo); `expectedReversedCents` impede que duas telas estornem o mesmo valor.
 */
export async function reverseManualTopup(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<ReversalResult & { replayed: boolean }> {
  authorize(actor, "topup.reverse");
  const input = reversalSchema.parse(raw);
  const reversalId = deterministicId("rvt", actor.uid, input.key);
  const entryId = `${reversalId}_reversal`;

  return runIdempotentCommand(db, actor, { scope: "topup.reverse", key: input.key, payload: input, allow: allowReverse }, async ({ tx, actor: current, profile, auditId }) => {
    const today = localDateOf(clock());
    const topupRef = db.doc(`topups/${input.topupId}`);
    const topupSnap = await tx.get(topupRef);
    if (!topupSnap.exists) throw notFound("topup_not_found", "Recarga não encontrada.");
    const topup = parseTopup(topupSnap.id, topupSnap.data()!);
    if (topup.kind !== "manual") throw conflict("topup_not_manual", "Esta recarga não é manual.");
    const walletRef = db.doc(`wallets/${topup.studentId}`);
    const keyRef = topup.reference ? db.doc(`uniquenessKeys/${topup.reference.keyId}`) : null;
    const [walletSnap, keySnap] = await tx.getAll(walletRef, ...(keyRef ? [keyRef] : []));
    const before = parseWalletState(walletSnap!.data());
    const plan = planReversal({ amountCents: topup.amountCents, reversedCents: topup.reversedCents, hasReference: topup.reference !== null }, before.balanceCents, input);
    const wallet = applyDelta(before, -input.amountCents);
    const releaseReference = plan.releaseReference && keySnap?.exists === true && keySnap.get("topupId") === topup.topupId;

    const stamp = FieldValue.serverTimestamp();
    const seq = topup.reversalCount + 1;
    const operator = { uid: current.uid, role: current.role ?? null, name: profile.displayName };
    tx.create(db.doc(`topups/${topup.topupId}/reversals/${reversalId}`), {
      reversalId,
      topupId: topup.topupId,
      studentId: topup.studentId,
      seq,
      amountCents: input.amountCents,
      reasonCode: input.reasonCode,
      reason: input.reason,
      walletEntryId: entryId,
      walletSeq: wallet.version,
      balanceAfterCents: wallet.balanceCents,
      reversedAfterCents: plan.reversedAfterCents,
      referenceReleased: releaseReference,
      operator,
      createdOn: today,
      createdAt: stamp,
    });
    tx.create(db.doc(`wallets/${topup.studentId}/entries/${entryId}`), {
      type: "topup_reversal",
      seq: wallet.version,
      amountCents: -input.amountCents,
      balanceAfterCents: wallet.balanceCents,
      reason: reversalEntryReason(topup.receivedOn),
      topupId: topup.topupId,
      reversalId,
      actorUid: current.uid,
      actorRole: current.role ?? null,
      referenceType: "topup",
      referenceId: topup.topupId,
      createdAt: stamp,
    });
    tx.set(walletRef, { balanceCents: wallet.balanceCents, version: wallet.version, updatedAt: stamp }, { merge: true });
    tx.update(topupRef, { reversedCents: plan.reversedAfterCents, reversalCount: seq, lastReversalId: reversalId, status: plan.status, version: topup.version + 1, updatedAt: stamp });
    if (releaseReference && keyRef) tx.update(keyRef, { status: "released", releasedBy: reversalId, releasedAt: stamp });
    auditInTransaction(db, tx, auditId, {
      action: "topup.manual.reverse",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "topup", id: topup.topupId },
      reason: input.reason,
      before: { balanceCents: before.balanceCents, reversedCents: topup.reversedCents, status: topup.status },
      after: { balanceCents: wallet.balanceCents, reversedCents: plan.reversedAfterCents, status: plan.status, amountCents: input.amountCents, reasonCode: input.reasonCode, reversalId, referenceReleased: releaseReference },
    });
    return {
      reversalId,
      topupId: topup.topupId,
      studentId: topup.studentId,
      amountCents: input.amountCents,
      reasonCode: input.reasonCode,
      walletEntryId: entryId,
      walletSeq: wallet.version,
      wallet: { studentId: topup.studentId, balanceCents: wallet.balanceCents, version: wallet.version },
      topup: { status: plan.status, reversedCents: plan.reversedAfterCents, reversibleCents: plan.reversibleAfterCents, referenceReleased: releaseReference },
    };
  });
}
