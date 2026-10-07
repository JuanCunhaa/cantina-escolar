import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { conflict, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { isSafeLabel } from "@/modules/students/normalize";
import { applyDelta, parseWalletState, pendingReversalOf } from "@/modules/wallet/model";
import { REVIEW_LABEL, type ReviewReason } from "./confirmation-model";
import type { IntentDoc } from "./intent-doc";

/**
 * Revisão administrativa dos pagamentos online (F19): pendências de reembolso/chargeback e pagamentos em divergência.
 * Só administração (`payments.review`), sempre pelo servidor. Pendência = parte de uma reversão externa que a carteira não
 * cobriu (crédito já consumido); enquanto aberta, a carteira fica bloqueada para novas despesas (`pendingReversalCents`).
 * Saldo negativo nunca existe: a regularização debita no máximo o saldo atual.
 */

export type PendencyView = {
  pendencyId: string;
  intentId: string;
  studentId: string;
  studentName: string;
  cause: "refund" | "chargeback";
  status: "open" | "resolved";
  openedCents: number;
  outstandingCents: number;
  recoveredCents: number;
  writtenOffCents: number;
  walletBalanceCents: number;
  createdAt: string | null;
};
export type ReviewItemView = { intentId: string; studentId: string; studentName: string; amountCents: number; channel: "pix" | "card"; reason: ReviewReason; label: string; providerStatus: string | null; createdAt: string | null };

const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null);

export type DisputeItemView = { intentId: string; studentId: string; studentName: string; amountCents: number; dispute: "open" | "won_after_reversal"; label: string; since: string | null };
export type OrphanItemView = { eventId: string; orderId: string; reference: string; amountCents: number; receivedAt: string | null };

const DISPUTE_LABEL = {
  open: "Contestação em andamento no provedor: nada foi retirado da carteira até a decisão",
  won_after_reversal: "Contestação ganha DEPOIS de a carteira já ter sido debitada: decidir se o valor volta (nenhuma devolução é automática)",
} as const;

export async function listPaymentReview(db: Firestore, actor: Actor): Promise<{ pendencies: PendencyView[]; reviews: ReviewItemView[]; disputes: DisputeItemView[]; orphans: OrphanItemView[] }> {
  authorize(actor, "payments.review");
  const [pendencySnap, reviewSnap, disputeSnap, orphanSnap] = await Promise.all([
    db.collection("paymentPendencies").where("status", "==", "open").limit(100).get(),
    db.collection("topupIntents").where("status", "==", "in_review").limit(100).get(),
    db.collection("topupIntents").where("dispute.status", "in", ["open", "won_after_reversal"]).limit(100).get(),
    db.collection("paymentEvents").where("outcome", "==", "orphan_payment").limit(50).get(),
  ]);
  const wallets = pendencySnap.docs.length ? await db.getAll(...pendencySnap.docs.map((d) => db.doc(`wallets/${d.get("studentId")}`))) : [];
  const pendencies = pendencySnap.docs
    .map((d, i): PendencyView => {
      const x = d.data();
      return {
        pendencyId: d.id,
        intentId: String(x.intentId),
        studentId: String(x.studentId),
        studentName: String(x.studentName ?? ""),
        cause: x.cause === "chargeback" ? "chargeback" : "refund",
        status: "open",
        openedCents: Number(x.openedCents),
        outstandingCents: Number(x.outstandingCents),
        recoveredCents: Number(x.recoveredCents),
        writtenOffCents: Number(x.writtenOffCents),
        walletBalanceCents: parseWalletState(wallets[i]?.data()).balanceCents,
        createdAt: iso(x.createdAt),
      };
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const reviews = reviewSnap.docs
    .map((d): ReviewItemView => {
      const x = d.data() as IntentDoc;
      const reason = (x.review?.reason ?? "amount_mismatch") as ReviewReason;
      return { intentId: x.intentId, studentId: x.studentId, studentName: x.studentName, amountCents: x.amountCents, channel: x.channel, reason, label: REVIEW_LABEL[reason], providerStatus: x.charge?.providerStatus ?? null, createdAt: iso(x.createdAt) };
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const disputes = disputeSnap.docs
    .map((d): DisputeItemView => {
      const x = d.data() as IntentDoc;
      const status = x.dispute!.status === "won_after_reversal" ? "won_after_reversal" : "open";
      return { intentId: x.intentId, studentId: x.studentId, studentName: x.studentName, amountCents: x.amountCents, dispute: status, label: DISPUTE_LABEL[status], since: iso(x.dispute!.at) };
    })
    .sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""));
  const orphans = orphanSnap.docs
    .map((d): OrphanItemView => ({ eventId: d.id, orderId: String(d.get("orderId") ?? ""), reference: String(d.get("reference") ?? ""), amountCents: Number(d.get("amountCents") ?? 0), receivedAt: iso(d.get("receivedAt")) }))
    .sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));
  return { pendencies, reviews, disputes, orphans };
}

export const resolvePendencySchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    pendencyId: z.string().regex(/^tpi_[a-f0-9]{20}$/),
    /** recover: debita o saldo atual (até o pendente) — NOVO lançamento no livro; write_off: a escola absorve o valor (sem lançamento). */
    action: z.enum(["recover", "write_off"]),
    /** Opcional: parte do pendente a tratar; padrão = o máximo possível (recover: até o saldo; write_off: todo o pendente). */
    amountCents: z.number().int().min(1).max(200_000).optional(),
    /** O pendente que a tela viu: outra operação no meio = 409 `stale_pendency`. */
    expectedOutstandingCents: z.number().int().min(1).max(200_000),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(200)
      .refine(isSafeLabel, "Texto inválido."),
  })
  .strict();

export type ResolveResult = {
  pendencyId: string;
  action: "recover" | "write_off";
  appliedCents: number;
  outstandingCents: number;
  status: "open" | "resolved";
  wallet: { studentId: string; balanceCents: number; version: number; pendingReversalCents: number };
};

export async function resolvePendency(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<ResolveResult & { replayed: boolean }> {
  authorize(actor, "payments.review");
  const input = resolvePendencySchema.parse(raw);
  const resolutionId = deterministicId("prr", actor.uid, input.key);

  return runIdempotentCommand(db, actor, { scope: "payments.pendency.resolve", key: input.key, payload: input, allow: (p) => can(p, "payments.review") }, async ({ tx, actor: current, profile, auditId }) => {
    const pendencyRef = db.doc(`paymentPendencies/${input.pendencyId}`);
    const intentRef = db.doc(`topupIntents/${input.pendencyId}`);
    const pendencySnap = await tx.get(pendencyRef);
    if (!pendencySnap.exists) throw notFound("pendency_not_found", "Pendência não encontrada.");
    const p = pendencySnap.data() as { studentId: string; outstandingCents: number; recoveredCents: number; writtenOffCents: number; status: string; version: number };
    const walletRef = db.doc(`wallets/${p.studentId}`);
    const [intentSnap, walletSnap] = await tx.getAll(intentRef, walletRef);
    if (p.status !== "open") throw conflict("pendency_closed", "Esta pendência já foi regularizada.");
    if (input.expectedOutstandingCents !== p.outstandingCents) throw conflict("stale_pendency", "A pendência mudou: confira o valor atual.", { outstandingCents: p.outstandingCents });

    const before = parseWalletState(walletSnap!.data());
    const maxCents = input.action === "recover" ? Math.min(p.outstandingCents, before.balanceCents) : p.outstandingCents;
    const applied = input.amountCents ?? maxCents;
    if (applied <= 0) throw conflict("nothing_to_recover", "A carteira não tem saldo para regularizar agora.", { balanceCents: before.balanceCents, outstandingCents: p.outstandingCents });
    if (applied > maxCents) throw conflict("exceeds_available", "O valor passa do que pode ser tratado agora.", { maxCents });

    const now = Timestamp.fromDate(clock());
    const stamp = FieldValue.serverTimestamp();
    const outstanding = p.outstandingCents - applied;
    const status = outstanding === 0 ? "resolved" : "open";
    let wallet = before;
    if (input.action === "recover") {
      wallet = applyDelta(before, -applied);
      tx.create(db.doc(`wallets/${p.studentId}/entries/${resolutionId}_recovery`), {
        type: "topup_reversal",
        seq: wallet.version,
        amountCents: -applied,
        balanceAfterCents: wallet.balanceCents,
        reason: "Regularização de pendência de recarga online",
        topupId: input.pendencyId,
        source: "online",
        externalCause: "pendency_recovery",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        referenceType: "topup",
        referenceId: input.pendencyId,
        createdAt: stamp,
      });
    }
    const pendingReversalCents = Math.max(0, pendingReversalOf(walletSnap!.data()) - applied);
    tx.set(walletRef, { balanceCents: wallet.balanceCents, version: wallet.version, pendingReversalCents, updatedAt: stamp }, { merge: true });
    tx.update(pendencyRef, {
      status,
      outstandingCents: outstanding,
      recoveredCents: p.recoveredCents + (input.action === "recover" ? applied : 0),
      writtenOffCents: p.writtenOffCents + (input.action === "write_off" ? applied : 0),
      resolution: { action: input.action, appliedCents: applied, reason: input.reason, by: { uid: current.uid, name: profile.displayName }, at: now },
      version: p.version + 1,
      updatedAt: now,
    });
    if (intentSnap!.exists) {
      const r = (intentSnap!.data() as IntentDoc).reversal;
      if (r) tx.update(intentRef, { "reversal.pendingCents": Math.max(0, r.pendingCents - applied), "reversal.recoveredCents": r.recoveredCents + (input.action === "recover" ? applied : 0), updatedAt: now });
    }
    auditInTransaction(db, tx, auditId, {
      action: `payments.pendency.${input.action}`,
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "paymentPendency", id: input.pendencyId },
      reason: input.reason,
      before: { outstandingCents: p.outstandingCents, balanceCents: before.balanceCents },
      after: { outstandingCents: outstanding, balanceCents: wallet.balanceCents, appliedCents: applied, status, resolutionId },
    });
    return { pendencyId: input.pendencyId, action: input.action, appliedCents: applied, outstandingCents: outstanding, status: status as "open" | "resolved", wallet: { studentId: p.studentId, balanceCents: wallet.balanceCents, version: wallet.version, pendingReversalCents } };
  });
}
