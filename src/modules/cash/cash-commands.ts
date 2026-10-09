import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { localDateOf } from "@/lib/dates/school-time";
import { conflict, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { backfillRange, closeSchema, computeClosing, openSchema, pointAllowed, reopenSchema, reviewSchema, sessionIdOf } from "./cash-model";
import { parseSession } from "./cash-session";
import { lineOf, readOperatorReceipts, readWalletConsumption } from "./cash-store";

/**
 * Comandos do caixa (F20). Todos: servidor autenticado, perfil ATUAL relido na transação (rebaixado/desativado = 403, inclusive na
 * repetição), idempotentes por chave + payload, leituras antes das escritas, nenhuma chamada externa. Princípios:
 *  - o operador age só sobre o PRÓPRIO caixa: o UID entra no ID da sessão e é conferido (outro operador = 403);
 *  - o fechamento NUNCA é reescrito: cada fechamento é uma versão imutável (`closures/{n}`); reabrir (só administração, com motivo)
 *    abre uma nova rodada e preserva as anteriores; o que veio depois do fechamento é identificado na leitura;
 *  - registrar ou aprovar uma diferença NÃO cria lançamento em carteira, recebimento, estoque ou livro (o comando só escreve
 *    `cashSessions` e a auditoria).
 */
const allowOperate = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "cash.operate");
const allowFinance = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "finance.manage");

export type OpenResult = { sessionId: string; date: string; point: string; status: "open"; openingCents: number };

export async function openCashSession(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<OpenResult & { replayed: boolean }> {
  authorize(actor, "cash.operate");
  const input = openSchema.parse(raw);
  if (!pointAllowed(actor.role, input.point)) throw new ForbiddenError("Ponto de recebimento não permitido ao seu perfil.");
  return runIdempotentCommand(
    db,
    actor,
    { scope: "cash.open", key: input.key, payload: input, allow: (p) => allowOperate(p) && pointAllowed(p.role, input.point) },
    async ({ tx, actor: current, profile, auditId }) => {
      const today = localDateOf(clock());
      const date = input.date ?? today;
      const range = backfillRange(today);
      if (date < range.min || date > range.max) throw conflict("invalid_date", "Data fora do intervalo permitido para abrir o caixa.", range);
      const sessionId = sessionIdOf(date, input.point, current.uid);
      const ref = db.doc(`cashSessions/${sessionId}`);
      const snap = await tx.get(ref);
      if (snap.exists) throw conflict("session_exists", "Já existe caixa deste operador neste ponto e data.", { sessionId, status: String(snap.get("status")) });
      const stamp = FieldValue.serverTimestamp();
      tx.create(ref, {
        sessionId,
        date,
        point: input.point,
        operator: { uid: current.uid, role: current.role ?? null, name: profile.displayName },
        status: "open",
        opening: { cents: input.openingCents, confirmed: true, confirmedAt: stamp },
        closureNo: 0,
        reopenCount: 0,
        closure: null,
        review: null,
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
      });
      tx.create(db.doc(`cashSessions/${sessionId}/events/${deterministicId("cev", current.uid, input.key)}`), { type: "opened", openingCents: input.openingCents, byUid: current.uid, byName: profile.displayName, createdAt: stamp });
      auditInTransaction(db, tx, auditId, { action: "cash.open", actorUid: current.uid, actorRole: current.role ?? null, target: { type: "cashSession", id: sessionId }, after: { date, point: input.point, openingCents: input.openingCents, backfilled: date !== today } });
      return { sessionId, date, point: input.point, status: "open" as const, openingCents: input.openingCents };
    },
  );
}

export type CloseResult = {
  sessionId: string;
  closureNo: number;
  status: "closed";
  expectedCashCents: number;
  countedCashCents: number;
  cashDifferenceCents: number;
  hasDivergence: boolean;
  reviewStatus: "pending" | "not_required";
  receiptCount: number;
};

/** Fecha o PRÓPRIO caixa: totais vêm dos recebimentos lidos na transação (nada é confiado ao cliente além da contagem e das conferências). */
export async function closeCashSession(db: Firestore, actor: Actor, raw: unknown): Promise<CloseResult & { replayed: boolean }> {
  authorize(actor, "cash.operate");
  const input = closeSchema.parse(raw);
  if (!input.sessionId.endsWith(`__${actor.uid}`)) throw new ForbiddenError("O caixa é de outro operador.");
  return runIdempotentCommand(db, actor, { scope: "cash.close", key: input.key, payload: input, allow: allowOperate }, async ({ tx, actor: current, profile, auditId }) => {
    const ref = db.doc(`cashSessions/${input.sessionId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("session_not_found", "Caixa não encontrado.");
    const session = parseSession(snap.id, snap.data()!);
    if (session.operator.uid !== current.uid || !pointAllowed(current.role, session.point)) throw new ForbiddenError("O caixa é de outro operador.");
    if (session.status === "closed") throw conflict("already_closed", "Este caixa já está fechado.", { closureNo: session.closureNo });
    const scope = { uid: current.uid, point: session.point, date: session.date };
    const receipts = await readOperatorReceipts(db, tx, scope);
    const walletConsumption = await readWalletConsumption(db, tx, scope);
    if (input.expectedReceiptCount !== undefined && input.expectedReceiptCount !== receipts.length) {
      throw conflict("stale_summary", "Houve novos recebimentos desde que você viu o resumo: confira de novo.", { receiptCount: receipts.length });
    }
    const lines = receipts.map(lineOf);
    const closing = computeClosing({ openingCents: session.openingCents, receipts: lines, countedCashCents: input.countedCashCents, declared: input.declared });
    const no = session.closureNo + 1;
    const stamp = FieldValue.serverTimestamp();
    const closure = {
      no,
      closedAt: stamp,
      byMethod: closing.byMethod,
      expectedCashCents: closing.expectedCashCents,
      countedCashCents: closing.countedCashCents,
      cashDifferenceCents: closing.cashDifferenceCents,
      declared: closing.declared,
      largestDifferenceCents: closing.largestDifferenceCents,
      hasDivergence: closing.hasDivergence,
      receiptCount: closing.receiptCount,
      walletConsumption,
      note: input.note || null,
      closedBy: { uid: current.uid, name: profile.displayName },
    };
    const reviewStatus = closing.hasDivergence ? ("pending" as const) : ("not_required" as const);
    tx.update(ref, { status: "closed", closureNo: no, closure, review: { status: reviewStatus, closureNo: no, note: null, byName: null, at: null, selfReview: false }, version: session.version + 1, updatedAt: stamp });
    tx.create(db.doc(`cashSessions/${input.sessionId}/closures/${no}`), { ...closure, sessionId: input.sessionId, openingCents: session.openingCents, lines });
    tx.create(db.doc(`cashSessions/${input.sessionId}/events/${deterministicId("cev", current.uid, input.key)}`), { type: "closed", closureNo: no, hasDivergence: closing.hasDivergence, byUid: current.uid, byName: profile.displayName, createdAt: stamp });
    auditInTransaction(db, tx, auditId, {
      action: "cash.close",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "cashSession", id: input.sessionId },
      before: { status: session.status, closureNo: session.closureNo },
      after: { closureNo: no, expectedCashCents: closing.expectedCashCents, countedCashCents: closing.countedCashCents, cashDifferenceCents: closing.cashDifferenceCents, hasDivergence: closing.hasDivergence, receiptCount: closing.receiptCount },
    });
    return { sessionId: input.sessionId, closureNo: no, status: "closed" as const, expectedCashCents: closing.expectedCashCents, countedCashCents: closing.countedCashCents, cashDifferenceCents: closing.cashDifferenceCents, hasDivergence: closing.hasDivergence, reviewStatus, receiptCount: closing.receiptCount };
  });
}

export type ReopenResult = { sessionId: string; status: "reopened"; reopenCount: number; closureNo: number };

/** Só a administração reabre, com motivo; as versões anteriores permanecem e o caixa volta ao operador DONO para novo fechamento. */
export async function reopenCashSession(db: Firestore, actor: Actor, raw: unknown): Promise<ReopenResult & { replayed: boolean }> {
  authorize(actor, "finance.manage");
  const input = reopenSchema.parse(raw);
  return runIdempotentCommand(db, actor, { scope: "cash.reopen", key: input.key, payload: input, allow: allowFinance }, async ({ tx, actor: current, profile, auditId }) => {
    const ref = db.doc(`cashSessions/${input.sessionId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("session_not_found", "Caixa não encontrado.");
    const session = parseSession(snap.id, snap.data()!);
    if (session.status !== "closed") throw conflict("not_closed", "Só um caixa fechado pode ser reaberto.", { status: session.status });
    const stamp = FieldValue.serverTimestamp();
    const reopenCount = session.reopenCount + 1;
    tx.update(ref, { status: "reopened", reopenCount, review: { ...(snap.get("review") as object), superseded: true }, version: session.version + 1, updatedAt: stamp });
    tx.create(db.doc(`cashSessions/${input.sessionId}/events/${deterministicId("cev", current.uid, input.key)}`), { type: "reopened", closureNo: session.closureNo, reason: input.reason, byUid: current.uid, byName: profile.displayName, createdAt: stamp });
    auditInTransaction(db, tx, auditId, { action: "cash.reopen", actorUid: current.uid, actorRole: current.role ?? null, target: { type: "cashSession", id: input.sessionId }, reason: input.reason, before: { status: "closed", closureNo: session.closureNo }, after: { status: "reopened", reopenCount } });
    return { sessionId: input.sessionId, status: "reopened" as const, reopenCount, closureNo: session.closureNo };
  });
}

export type ReviewResult = { sessionId: string; closureNo: number; decision: string; adjustment: "none" };

/**
 * Revisão administrativa da divergência do fechamento atual: aprovar ou manter em apuração, sempre com nota. NÃO gera ajuste
 * automático (carteira, recebimento, estoque e livro ficam como estão): lançamento compensatório depende de decisão própria.
 */
export async function reviewCashDivergence(db: Firestore, actor: Actor, raw: unknown): Promise<ReviewResult & { replayed: boolean }> {
  authorize(actor, "finance.manage");
  const input = reviewSchema.parse(raw);
  return runIdempotentCommand(db, actor, { scope: "cash.review", key: input.key, payload: input, allow: allowFinance }, async ({ tx, actor: current, profile, auditId }) => {
    const ref = db.doc(`cashSessions/${input.sessionId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("session_not_found", "Caixa não encontrado.");
    const session = parseSession(snap.id, snap.data()!);
    if (session.status !== "closed") throw conflict("not_closed", "O caixa foi reaberto: revise depois do novo fechamento.", { status: session.status });
    if (session.closureNo !== input.closureNo) throw conflict("stale_closure", "Existe um fechamento mais novo: confira a versão atual.", { closureNo: session.closureNo });
    if (!session.closure?.hasDivergence) throw conflict("no_divergence", "Este fechamento não tem divergência a revisar.");
    const stamp = FieldValue.serverTimestamp();
    tx.update(ref, { review: { status: input.decision, closureNo: session.closureNo, note: input.note, byName: profile.displayName, at: stamp, selfReview: session.operator.uid === current.uid }, version: session.version + 1, updatedAt: stamp });
    tx.create(db.doc(`cashSessions/${input.sessionId}/events/${deterministicId("cev", current.uid, input.key)}`), { type: "reviewed", closureNo: session.closureNo, decision: input.decision, reason: input.note, byUid: current.uid, byName: profile.displayName, selfReview: session.operator.uid === current.uid, createdAt: stamp });
    auditInTransaction(db, tx, auditId, {
      action: "cash.review",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "cashSession", id: input.sessionId },
      reason: input.note,
      before: { reviewStatus: session.review?.status ?? null },
      after: { reviewStatus: input.decision, closureNo: session.closureNo, cashDifferenceCents: session.closure.cashDifferenceCents, adjustment: "none", selfReview: session.operator.uid === current.uid },
    });
    return { sessionId: input.sessionId, closureNo: session.closureNo, decision: input.decision, adjustment: "none" as const };
  });
}
