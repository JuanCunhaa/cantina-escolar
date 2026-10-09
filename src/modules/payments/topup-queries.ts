import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { addDays, isLocalDate, localDateOf, localInstant, type LocalDate } from "@/lib/dates/school-time";
import { notFound } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { ForbiddenError } from "@/modules/access/errors";
import { can } from "@/modules/access/permissions";
import { readActiveRoster, type PosRoster, type PosStudentRow } from "@/modules/pos/queries";
import { parseWalletState } from "@/modules/wallet/model";
import type { FeeRecord, PaymentMethod } from "./methods";
import type { ReferenceFamily, ReversalReason, Settlement, TopupStatus } from "./topup-model";

/**
 * Leituras da secretaria (F17), sempre pelo servidor: `topups` é fechado ao cliente (default-deny nas Rules). Quem registra
 * (`topup.register`) ou estorna (`topup.reverse`) consulta as recargas para conferência e o comprovante interno. Nenhuma
 * leitura aqui expõe custo, lucro, dados de responsável ou gestão de usuários.
 */
export function assertTopupReader(actor: Actor): void {
  if (!can(actor, "topup.register") && !can(actor, "topup.reverse")) throw new ForbiddenError("Sem permissão: recargas.");
}

type Operator = { uid: string; role: string | null; name: string };

export type TopupRecord = {
  topupId: string;
  kind: "manual";
  status: TopupStatus;
  studentId: string;
  studentName: string;
  studentEnrollment: string;
  classId: string;
  shiftId: string;
  amountCents: number;
  creditedCents: number;
  method: PaymentMethod;
  fee: FeeRecord;
  netCents: number | null;
  settlement: Settlement;
  reference: { raw: string; normalized: string; family: ReferenceFamily; keyId: string } | null;
  verification: { receivedConfirmed: true; payerName: string | null; note: string | null };
  receivedOn: LocalDate;
  receivedAt: string | null;
  operator: Operator;
  walletEntryId: string;
  walletSeq: number;
  balanceAfterCents: number;
  reversedCents: number;
  reversalCount: number;
  version: number;
};

const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null);
const int = (value: unknown): number => (Number.isSafeInteger(value) ? (value as number) : 0);

export function parseTopup(id: string, d: Record<string, unknown>): TopupRecord {
  const operator = (d.operator ?? {}) as Partial<Operator>;
  return {
    topupId: id,
    kind: "manual",
    status: (d.status as TopupStatus) ?? "confirmed",
    studentId: String(d.studentId ?? ""),
    studentName: String(d.studentName ?? ""),
    studentEnrollment: String(d.studentEnrollment ?? ""),
    classId: String(d.classId ?? ""),
    shiftId: String(d.shiftId ?? ""),
    amountCents: int(d.amountCents),
    creditedCents: int(d.creditedCents),
    method: d.method as PaymentMethod,
    fee: d.fee as FeeRecord,
    netCents: d.netCents === null || d.netCents === undefined ? null : int(d.netCents),
    settlement: d.settlement as Settlement,
    reference: (d.reference as TopupRecord["reference"]) ?? null,
    verification: d.verification as TopupRecord["verification"],
    receivedOn: String(d.receivedOn ?? ""),
    receivedAt: iso(d.receivedAt),
    operator: { uid: String(operator.uid ?? ""), role: operator.role ?? null, name: String(operator.name ?? "") },
    walletEntryId: String(d.walletEntryId ?? ""),
    walletSeq: int(d.walletSeq),
    balanceAfterCents: int(d.balanceAfterCents),
    reversedCents: int(d.reversedCents),
    reversalCount: int(d.reversalCount),
    version: int(d.version),
  };
}

export type ReversalView = { reversalId: string; seq: number; amountCents: number; reasonCode: ReversalReason; reason: string; balanceAfterCents: number; referenceReleased: boolean; operatorName: string; createdOn: string; createdAt: string | null };

/** Comprovante interno / linha de conferência. Sem UID do operador (só o nome), sem custo nem dado de responsável. */
export type TopupView = {
  topupId: string;
  status: TopupStatus;
  student: { id: string; name: string; enrollment: string; classId: string; shiftId: string };
  amountCents: number;
  creditedCents: number;
  method: PaymentMethod;
  fee: FeeRecord;
  netCents: number | null;
  settlement: Settlement;
  reference: string | null;
  payerName: string | null;
  note: string | null;
  receivedOn: LocalDate;
  receivedAt: string | null;
  operatorName: string;
  walletSeq: number;
  balanceAfterCents: number;
  reversedCents: number;
  reversibleCents: number;
  reversals: ReversalView[];
};

/** O operador vê a previsão com a base e o prazo (para entender a data), mas não a VERSÃO da regra nem a regra em si (F20). */
function forOperator(s: Settlement): Settlement {
  const visible: Settlement = { ...s };
  delete visible.expectedRuleVersion;
  return visible;
}

export function topupView(t: TopupRecord, reversals: ReversalView[]): TopupView {
  return {
    topupId: t.topupId,
    status: t.status,
    student: { id: t.studentId, name: t.studentName, enrollment: t.studentEnrollment, classId: t.classId, shiftId: t.shiftId },
    amountCents: t.amountCents,
    creditedCents: t.creditedCents,
    method: t.method,
    fee: t.fee,
    netCents: t.netCents,
    settlement: forOperator(t.settlement),
    reference: t.reference?.raw ?? null,
    payerName: t.verification?.payerName ?? null,
    note: t.verification?.note ?? null,
    receivedOn: t.receivedOn,
    receivedAt: t.receivedAt,
    operatorName: t.operator.name,
    walletSeq: t.walletSeq,
    balanceAfterCents: t.balanceAfterCents,
    reversedCents: t.reversedCents,
    reversibleCents: t.amountCents - t.reversedCents,
    reversals,
  };
}

function reversalOf(d: FirebaseFirestore.DocumentData): ReversalView {
  return {
    reversalId: String(d.reversalId ?? ""),
    seq: int(d.seq),
    amountCents: int(d.amountCents),
    reasonCode: d.reasonCode as ReversalReason,
    reason: String(d.reason ?? ""),
    balanceAfterCents: int(d.balanceAfterCents),
    referenceReleased: d.referenceReleased === true,
    operatorName: String((d.operator as Operator | undefined)?.name ?? ""),
    createdOn: String(d.createdOn ?? ""),
    createdAt: iso(d.createdAt),
  };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Comprovante: recarga + estornos (≤ 50, em ordem). */
export async function readTopup(db: Firestore, actor: Actor, rawId: unknown): Promise<TopupView> {
  assertTopupReader(actor);
  const id = z.string().regex(ID).parse(rawId);
  const [snap, reversals] = await Promise.all([db.doc(`topups/${id}`).get(), db.collection(`topups/${id}/reversals`).orderBy("seq").limit(50).get()]);
  if (!snap.exists) throw notFound("topup_not_found", "Recarga não encontrada.");
  return topupView(parseTopup(snap.id, snap.data()!), reversals.docs.map((d) => reversalOf(d.data())));
}

export const MAX_DAY_TOPUPS = 300;
const listSchema = z
  .object({
    date: z.string().refine(isLocalDate).optional(),
    studentId: z.string().regex(ID).optional(),
    mine: z.enum(["1", "0"]).optional(),
  })
  .strict();

export type TopupList = { date: LocalDate | null; studentId: string | null; topups: TopupView[]; truncated: boolean; totals: { count: number; creditedCents: number; reversedCents: number; feeInformedCents: number; feePendingCount: number; byMethod: Record<PaymentMethod, number> } };

/**
 * Conferência: recargas de UM dia local (padrão hoje; consulta por intervalo em `createdAt`, sem índice composto) ou de UM
 * aluno (índice `topups (studentId, createdAt desc)`, 50 mais novas). `mine=1` restringe ao operador. Totais por meio e
 * taxa informada × pendente (sem somar estimativa com valor real: aqui só existe taxa informada).
 */
export async function listTopups(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<TopupList> {
  assertTopupReader(actor);
  const f = listSchema.parse(raw);
  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  let truncated = false;
  let date: LocalDate | null = null;
  if (f.studentId) {
    docs = (await db.collection("topups").where("studentId", "==", f.studentId).orderBy("createdAt", "desc").limit(50).get()).docs;
  } else {
    date = f.date ?? localDateOf(clock());
    const snap = await db
      .collection("topups")
      .where("createdAt", ">=", Timestamp.fromDate(localInstant(date, "00:00")))
      .where("createdAt", "<", Timestamp.fromDate(localInstant(addDays(date, 1), "00:00")))
      .orderBy("createdAt", "desc")
      .limit(MAX_DAY_TOPUPS + 1)
      .get();
    truncated = snap.size > MAX_DAY_TOPUPS;
    docs = snap.docs.slice(0, MAX_DAY_TOPUPS);
  }
  let rows = docs.map((d) => parseTopup(d.id, d.data()));
  if (f.mine === "1") rows = rows.filter((t) => t.operator.uid === actor.uid);
  const topups = rows.map((t) => topupView(t, []));
  const byMethod: Record<PaymentMethod, number> = { cash: 0, pix: 0, card_debit: 0, card_credit: 0 };
  for (const t of topups) byMethod[t.method] += t.creditedCents;
  return {
    date,
    studentId: f.studentId ?? null,
    topups,
    truncated,
    totals: {
      count: topups.length,
      creditedCents: topups.reduce((n, t) => n + t.creditedCents, 0),
      reversedCents: topups.reduce((n, t) => n + t.reversedCents, 0),
      feeInformedCents: topups.reduce((n, t) => n + ((t.fee.status === "informed" || t.fee.status === "confirmed") ? (t.fee.cents ?? 0) : 0), 0),
      feePendingCount: topups.filter((t) => t.fee.status === "pending").length,
      byMethod,
    },
  };
}

/** Alunos ATIVOS (turma/turno para homônimos) para a busca nominal da secretaria. */
export async function topupRoster(db: Firestore, actor: Actor, clock: () => Date = () => new Date()): Promise<PosRoster> {
  assertTopupReader(actor);
  return readActiveRoster(db, clock);
}

export type TopupStudent = { student: PosStudentRow & { status: string }; wallet: { balanceCents: number; version: number }; recent: TopupView[] };

/** Aluno escolhido: identificação, saldo atual (`version` para a tela não regredir) e as últimas recargas dele. */
export async function topupStudent(db: Firestore, actor: Actor, rawId: unknown): Promise<TopupStudent> {
  assertTopupReader(actor);
  const studentId = z.string().regex(ID).parse(rawId);
  const [student, wallet, recent] = await Promise.all([
    db.doc(`students/${studentId}`).get(),
    db.doc(`wallets/${studentId}`).get(),
    db.collection("topups").where("studentId", "==", studentId).orderBy("createdAt", "desc").limit(10).get(),
  ]);
  if (!student.exists) throw notFound("student_not_found", "Aluno não encontrado.");
  const [className, shiftName] = await Promise.all([
    student.get("classId") ? db.doc(`classes/${String(student.get("classId"))}`).get() : null,
    student.get("shiftId") ? db.doc(`shifts/${String(student.get("shiftId"))}`).get() : null,
  ]);
  return {
    student: {
      id: student.id,
      name: String(student.get("name") ?? ""),
      enrollment: String(student.get("enrollment") ?? ""),
      classId: String(student.get("classId") ?? ""),
      className: className?.exists ? String(className.get("name") ?? "") : null,
      shiftId: String(student.get("shiftId") ?? ""),
      shiftName: shiftName?.exists ? String(shiftName.get("name") ?? "") : null,
      status: String(student.get("status") ?? ""),
    },
    wallet: parseWalletState(wallet.data()),
    recent: recent.docs.map((d) => topupView(parseTopup(d.id, d.data()), [])),
  };
}
