import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { addDays, isLocalDate, localDateOf, type LocalDate } from "@/lib/dates/school-time";
import { conflict, notFound } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { can } from "@/modules/access/permissions";
import { ALERT_WINDOW_DAYS, CASH_POINTS, expectedCashOf, methodTotals, movementsAfterClose, pointAllowed, sessionIdOf, type AfterClose, type CashAlert, type CashLineReceipt, type CashPoint, type MethodTotals } from "./cash-model";
import { parseSession, type SessionDoc } from "./cash-session";
import { lineOf, readOperatorReceipts, readReceiptsByScope, readWalletConsumption, scopeKeyOf, type ScopeKey, type WalletConsumption } from "./cash-store";

/**
 * Leituras do caixa (F20), sempre pelo servidor. O operador lê só o PRÓPRIO caixa; a administração (`finance.manage`) lê todos.
 * Nada aqui expõe custo, lucro, regra de taxa nem recebimento de outro operador a quem não é administração.
 */
export type LiveSummary = { receiptCount: number; byMethod: MethodTotals[]; expectedCashCents: number; walletConsumption: WalletConsumption };
export type SessionView = {
  sessionId: string;
  date: LocalDate;
  point: CashPoint;
  operatorName: string;
  operatorUid?: string;
  status: SessionDoc["status"];
  openingCents: number;
  openedAt: string | null;
  closureNo: number;
  reopenCount: number;
  closure: SessionDoc["closure"];
  review: SessionDoc["review"];
  /** Resumo AO VIVO enquanto o caixa não está fechado (o que os recebimentos mostram agora). */
  live: LiveSummary | null;
  /** Movimentos que chegaram DEPOIS do último fechamento (só em caixa fechado). O fechamento em si nunca é reescrito. */
  afterClose: AfterClose | null;
  history: { no: number; closedAt: string | null; expectedCashCents: number; countedCashCents: number; cashDifferenceCents: number; hasDivergence: boolean }[];
  events: { type: string; closureNo: number | null; reason: string | null; byName: string; at: string | null }[];
};

const iso = (v: unknown): string | null => (v && typeof (v as { toDate?: () => Date }).toDate === "function" ? (v as { toDate: () => Date }).toDate().toISOString() : null);
const pointsOf = (role: Actor["role"]): CashPoint[] => CASH_POINTS.filter((p) => pointAllowed(role, p));

function liveOf(openingCents: number, lines: readonly CashLineReceipt[], walletConsumption: WalletConsumption): LiveSummary {
  const byMethod = methodTotals(lines);
  return { receiptCount: lines.length, byMethod, expectedCashCents: expectedCashOf(openingCents, byMethod), walletConsumption };
}

async function viewOf(db: Firestore, session: SessionDoc, opts: { includeUid: boolean }): Promise<SessionView> {
  const scope = { uid: session.operator.uid, point: session.point, date: session.date };
  const [receipts, walletConsumption, closuresSnap, eventsSnap] = await Promise.all([
    readOperatorReceipts(db, null, scope),
    readWalletConsumption(db, null, scope),
    db.collection(`cashSessions/${session.sessionId}/closures`).get(),
    db.collection(`cashSessions/${session.sessionId}/events`).limit(200).get(),
  ]);
  const lines = receipts.map(lineOf);
  const history = closuresSnap.docs
    .map((d) => ({ no: Number(d.get("no")), closedAt: iso(d.get("closedAt")), expectedCashCents: Number(d.get("expectedCashCents")), countedCashCents: Number(d.get("countedCashCents")), cashDifferenceCents: Number(d.get("cashDifferenceCents")), hasDivergence: d.get("hasDivergence") === true, lines: (d.get("lines") as CashLineReceipt[]) ?? [] }))
    .sort((a, b) => a.no - b.no);
  const last = history.find((h) => h.no === session.closureNo);
  const closed = session.status === "closed" && last;
  return {
    sessionId: session.sessionId,
    date: session.date,
    point: session.point,
    operatorName: session.operator.name,
    ...(opts.includeUid ? { operatorUid: session.operator.uid } : {}),
    status: session.status,
    openingCents: session.openingCents,
    openedAt: session.openedAtIso,
    closureNo: session.closureNo,
    reopenCount: session.reopenCount,
    closure: session.closure,
    review: session.review,
    live: session.status === "closed" ? null : liveOf(session.openingCents, lines, walletConsumption),
    afterClose: closed ? movementsAfterClose(last.lines, lines) : null,
    history: history.map((h) => ({ no: h.no, closedAt: h.closedAt, expectedCashCents: h.expectedCashCents, countedCashCents: h.countedCashCents, cashDifferenceCents: h.cashDifferenceCents, hasDivergence: h.hasDivergence })),
    events: eventsSnap.docs
      .map((d) => ({ type: String(d.get("type")), closureNo: d.get("closureNo") ?? null, reason: (d.get("reason") as string | undefined) ?? null, byName: String(d.get("byName") ?? ""), at: iso(d.get("createdAt")) }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at))),
  };
}

/* ----------------------------------------------------------------------------------------------- alertas */

async function namesOf(db: Firestore, uids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(uids)].slice(0, 100);
  if (unique.length === 0) return new Map();
  const snaps = await db.getAll(...unique.map((u): DocumentReference => db.doc(`users/${u}`)));
  return new Map(snaps.map((s) => [s.id, String(s.get("displayName") ?? "")]));
}

/** Alertas da janela [hoje − 14 dias, hoje]: nunca bloqueiam o dia seguinte. `uid` restringe ao operador (visão própria). */
export async function cashAlerts(db: Firestore, now: Date, uid?: string): Promise<CashAlert[]> {
  const today = localDateOf(now);
  const from = addDays(today, -ALERT_WINDOW_DAYS);
  const [{ groups }, sessionSnap] = await Promise.all([readReceiptsByScope(db, { from, to: today }, uid), db.collection("cashSessions").where("date", ">=", from).where("date", "<=", today).limit(1000).get()]);
  const sessions = sessionSnap.docs.map((d) => parseSession(d.id, d.data())).filter((s) => !uid || s.operator.uid === uid);
  const closed = sessions.filter((s) => s.status === "closed" && s.closureNo > 0);
  const closureSnaps = closed.length ? await db.getAll(...closed.map((s) => db.doc(`cashSessions/${s.sessionId}/closures/${s.closureNo}`))) : [];
  const lastLines = new Map(closed.map((s, i) => [s.sessionId, (closureSnaps[i]?.get("lines") as CashLineReceipt[] | undefined) ?? []]));

  const alerts: CashAlert[] = [];
  const known = new Set<string>();
  for (const s of sessions) {
    known.add(s.sessionId);
    const base = { date: s.date, point: s.point, operatorUid: s.operator.uid, operatorName: s.operator.name, sessionId: s.sessionId };
    if ((s.status === "open" || s.status === "reopened") && s.date < today) alerts.push({ ...base, kind: "open_not_closed", detail: s.status === "reopened" ? "reaberto" : null });
    if (s.status === "closed" && s.review?.status === "pending") alerts.push({ ...base, kind: "divergence_pending", detail: null });
    if (s.status === "closed") {
      const current = (groups.get(scopeKeyOf(s.date, s.point, s.operator.uid)) ?? []).map(lineOf);
      const after = movementsAfterClose(lastLines.get(s.sessionId) ?? [], current);
      if (after.count > 0) alerts.push({ ...base, kind: "movements_after_close", detail: `${after.count}` });
    }
  }
  const orphan: { key: ScopeKey; date: LocalDate; point: CashPoint; uid: string; count: number }[] = [];
  for (const [key, list] of groups) {
    const [date, point, groupUid] = key.split("__") as [LocalDate, CashPoint, string];
    if (date >= today || known.has(sessionIdOf(date, point, groupUid))) continue;
    orphan.push({ key, date, point, uid: groupUid, count: list.length });
  }
  const names = await namesOf(db, orphan.map((o) => o.uid));
  for (const o of orphan) alerts.push({ kind: "receipts_without_session", date: o.date, point: o.point, operatorUid: o.uid, operatorName: names.get(o.uid) ?? null, sessionId: null, detail: `${o.count}` });
  return alerts.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));
}

/* ----------------------------------------------------------------------------------------- leituras do operador */

export type MyCash = { date: LocalDate; points: { point: CashPoint; sessionId: string; session: SessionView | null; live: LiveSummary | null }[]; alerts: CashAlert[]; recent: { sessionId: string; date: LocalDate; point: CashPoint; status: SessionDoc["status"]; cashDifferenceCents: number | null; reviewStatus: string | null }[] };

/** Janela dos últimos caixas do operador (consulta por data, campo único e já ordenada; o filtro por UID é em memória). */
const RECENT_DAYS = 45;
const dateQuery = z.object({ date: z.string().refine(isLocalDate).optional() }).strict();

/** Caixa do PRÓPRIO operador: a sessão do dia em cada ponto permitido ao papel, o que já foi recebido, alertas próprios e os últimos fechamentos. */
export async function getMyCash(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<MyCash> {
  authorize(actor, "cash.operate");
  const now = clock();
  const today = localDateOf(now);
  const date = dateQuery.parse(raw ?? {}).date ?? today;
  const points = await Promise.all(
    pointsOf(actor.role).map(async (point) => {
      const sessionId = sessionIdOf(date, point, actor.uid);
      const snap = await db.doc(`cashSessions/${sessionId}`).get();
      if (snap.exists) {
        const view = await viewOf(db, parseSession(snap.id, snap.data()!), { includeUid: false });
        return { point, sessionId, session: view, live: view.live };
      }
      // Ainda sem caixa: mostra o que já foi recebido no dia (o operador pode abrir o caixa depois, até 7 dias).
      const scope = { uid: actor.uid, point, date };
      const [receipts, walletConsumption] = await Promise.all([readOperatorReceipts(db, null, scope), readWalletConsumption(db, null, scope)]);
      return { point, sessionId, session: null, live: liveOf(0, receipts.map(lineOf), walletConsumption) };
    }),
  );
  const [alerts, recentSnap] = await Promise.all([cashAlerts(db, now, actor.uid), db.collection("cashSessions").where("date", ">=", addDays(today, -RECENT_DAYS)).orderBy("date", "desc").limit(400).get()]);
  const recent = recentSnap.docs
    .map((d) => parseSession(d.id, d.data()))
    .filter((s) => s.operator.uid === actor.uid)
    .slice(0, 15)
    .map((s) => ({ sessionId: s.sessionId, date: s.date, point: s.point, status: s.status, cashDifferenceCents: s.closure?.cashDifferenceCents ?? null, reviewStatus: s.review?.status ?? null }));
  return { date, points, alerts, recent };
}

/** Uma sessão: o dono (`cash.operate`) ou a administração (`finance.manage`). Outro operador = 403. */
export async function getCashSession(db: Firestore, actor: Actor, sessionId: string): Promise<SessionView> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw notFound("session_not_found", "Caixa não encontrado.");
  const admin = can(actor, "finance.manage");
  if (!admin && !can(actor, "cash.operate")) throw new ForbiddenError("Sem permissão: caixa.");
  if (!admin && !sessionId.endsWith(`__${actor.uid}`)) throw new ForbiddenError("O caixa é de outro operador.");
  const snap = await db.doc(`cashSessions/${sessionId}`).get();
  if (!snap.exists) throw notFound("session_not_found", "Caixa não encontrado.");
  return viewOf(db, parseSession(snap.id, snap.data()!), { includeUid: admin });
}

/* ------------------------------------------------------------------------------------- leituras da administração */

const rangeQuery = z.object({ from: z.string().refine(isLocalDate).optional(), to: z.string().refine(isLocalDate).optional() }).strict();
export type CashAdminList = {
  from: LocalDate;
  to: LocalDate;
  sessions: { sessionId: string; date: LocalDate; point: CashPoint; operatorName: string; operatorUid: string; status: SessionDoc["status"]; openingCents: number; expectedCashCents: number | null; countedCashCents: number | null; cashDifferenceCents: number | null; hasDivergence: boolean; reviewStatus: string | null; closureNo: number; reopenCount: number }[];
  alerts: CashAlert[];
  truncated: boolean;
};

/** Todos os caixas do período (padrão: 7 dias) e os alertas da janela. Só administração. */
export async function listCashAdmin(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<CashAdminList> {
  authorize(actor, "finance.manage");
  const now = clock();
  const today = localDateOf(now);
  const q = rangeQuery.parse(raw ?? {});
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -6);
  if (from > to) throw conflict("invalid_range", "Período invertido.");
  if (from < addDays(to, -92)) throw conflict("range_too_long", "Período máximo de ~3 meses.");
  const snap = await db.collection("cashSessions").where("date", ">=", from).where("date", "<=", to).limit(1001).get();
  const sessions = snap.docs.slice(0, 1000).map((d) => parseSession(d.id, d.data()));
  return {
    from,
    to,
    sessions: sessions
      .sort((a, b) => b.date.localeCompare(a.date) || a.point.localeCompare(b.point) || a.operator.name.localeCompare(b.operator.name))
      .map((s) => ({
        sessionId: s.sessionId,
        date: s.date,
        point: s.point,
        operatorName: s.operator.name,
        operatorUid: s.operator.uid,
        status: s.status,
        openingCents: s.openingCents,
        expectedCashCents: s.closure?.expectedCashCents ?? null,
        countedCashCents: s.closure?.countedCashCents ?? null,
        cashDifferenceCents: s.closure?.cashDifferenceCents ?? null,
        hasDivergence: s.closure?.hasDivergence ?? false,
        reviewStatus: s.review?.status ?? null,
        closureNo: s.closureNo,
        reopenCount: s.reopenCount,
      })),
    alerts: await cashAlerts(db, now),
    truncated: snap.size > 1000,
  };
}
