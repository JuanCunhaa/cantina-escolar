import { FieldValue, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import { weekStartOf, type LocalDate } from "@/lib/dates/school-time";
import type { UsageView } from "./evaluate";

/**
 * Comprometimento de consumo por DATA DO CONSUMO (docs/domains/policies.md §9; schema `studentUsage`):
 * `studentUsage/{studentId}/days/{YYYY-MM-DD}` e `weeks/{segunda}` guardam `committedCents` (pedidos antecipados
 * ativos + entregues + balcão do dia − reembolsos). São lidos e escritos na MESMA transação do comando que cria,
 * reagenda, cancela ou reembolsa o pedido: sem documento de uso atualizado atomicamente, dois checkouts simultâneos
 * poderiam estourar o teto. Transferência/recarga não é consumo.
 */
export class UsageInvariantError extends Error {}

export type UsageDelta = { date: LocalDate; amountCents: number };

export const dayRef = (db: Firestore, studentId: string, date: LocalDate) => db.doc(`studentUsage/${studentId}/days/${date}`);
export const weekRef = (db: Firestore, studentId: string, weekStart: LocalDate) => db.doc(`studentUsage/${studentId}/weeks/${weekStart}`);

export type UsageSnapshot = UsageView & { dayRefs: Map<LocalDate, DocumentReference>; weekRefs: Map<LocalDate, DocumentReference> };

const committedOf = (data: Record<string, unknown> | undefined) => (typeof data?.committedCents === "number" ? data.committedCents : 0);

/** Lê (dentro da transação) os documentos de uso das datas/semanas tocadas. Ausente = 0. */
export async function readUsage(db: Firestore, tx: Transaction, studentId: string, dates: readonly LocalDate[]): Promise<UsageSnapshot> {
  const uniqueDays = [...new Set(dates)].sort();
  const uniqueWeeks = [...new Set(uniqueDays.map(weekStartOf))].sort();
  const dayRefs = new Map(uniqueDays.map((d) => [d, dayRef(db, studentId, d)] as const));
  const weekRefs = new Map(uniqueWeeks.map((w) => [w, weekRef(db, studentId, w)] as const));
  const all = [...dayRefs.values(), ...weekRefs.values()];
  const snaps = all.length > 0 ? await tx.getAll(...all) : [];
  const days: Record<LocalDate, number> = {};
  const weeks: Record<LocalDate, number> = {};
  let i = 0;
  for (const d of uniqueDays) days[d] = committedOf(snaps[i++]?.data());
  for (const w of uniqueWeeks) weeks[w] = committedOf(snaps[i++]?.data());
  return { days, weeks, dayRefs, weekRefs };
}

function group(deltas: readonly UsageDelta[]) {
  const perDay = new Map<LocalDate, number>();
  const perWeek = new Map<LocalDate, number>();
  for (const { date, amountCents } of deltas) {
    perDay.set(date, (perDay.get(date) ?? 0) + amountCents);
    perWeek.set(weekStartOf(date), (perWeek.get(weekStartOf(date)) ?? 0) + amountCents);
  }
  return { perDay, perWeek };
}

/**
 * Soma (`sign` = +1) ou libera (`sign` = −1) o comprometimento. Usa o snapshot lido na transação (valor novo = lido +
 * delta; o Firestore serializa transações concorrentes no mesmo documento). Liberar além do comprometido é violação
 * de invariante (reembolso/cancelamento sem a reserva correspondente), nunca é truncado em silêncio.
 */
export function writeUsage(tx: Transaction, db: Firestore, studentId: string, snapshot: UsageSnapshot, deltas: readonly UsageDelta[], sign: 1 | -1): void {
  const { perDay, perWeek } = group(deltas);
  const next = (current: number, amount: number, label: string) => {
    const value = current + sign * amount;
    if (value < 0) throw new UsageInvariantError(`Uso comprometido ficaria negativo (${label}).`);
    return value;
  };
  const writes = [
    ...[...perDay].map(([d, a]) => ({ ref: snapshot.dayRefs.get(d) ?? dayRef(db, studentId, d), id: { date: d }, value: next(snapshot.days[d] ?? 0, a, d) })),
    ...[...perWeek].map(([w, a]) => ({ ref: snapshot.weekRefs.get(w) ?? weekRef(db, studentId, w), id: { weekStart: w }, value: next(snapshot.weeks[w] ?? 0, a, w) })),
  ];
  for (const { ref, id, value } of writes) {
    tx.set(ref, { studentId, ...id, committedCents: value, version: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
}

/**
 * Move comprometimento num só passo (reagendamento/troca, F16): `deltas` com sinal (+ destino/produto novo, − origem/produto
 * trocado), somados POR documento antes de gravar — origem e destino na mesma semana (ou a mesma data) viram UMA gravação
 * com o saldo líquido, nunca duas gravações em que a segunda apagaria a primeira. Documento com líquido zero não é regravado.
 */
export function applyUsageDeltas(tx: Transaction, db: Firestore, studentId: string, snapshot: UsageSnapshot, deltas: readonly UsageDelta[]): void {
  const { perDay, perWeek } = group(deltas);
  const writes = [
    ...[...perDay].map(([d, a]) => ({ ref: snapshot.dayRefs.get(d) ?? dayRef(db, studentId, d), id: { date: d }, current: snapshot.days[d] ?? 0, amount: a, label: d })),
    ...[...perWeek].map(([w, a]) => ({ ref: snapshot.weekRefs.get(w) ?? weekRef(db, studentId, w), id: { weekStart: w }, current: snapshot.weeks[w] ?? 0, amount: a, label: w })),
  ];
  for (const { ref, id, current, amount, label } of writes) {
    if (amount === 0) continue;
    const value = current + amount;
    if (value < 0) throw new UsageInvariantError(`Uso comprometido ficaria negativo (${label}).`);
    tx.set(ref, { studentId, ...id, committedCents: value, version: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
}

/** Visão do uso como se os `deltas` já tivessem sido aplicados (para avaliar o destino sem contar a origem que sai). */
export function usageAfter(snapshot: UsageView, deltas: readonly UsageDelta[]): UsageView {
  const { perDay, perWeek } = group(deltas);
  const days = { ...snapshot.days };
  const weeks = { ...snapshot.weeks };
  for (const [d, a] of perDay) days[d] = (days[d] ?? 0) + a;
  for (const [w, a] of perWeek) weeks[w] = (weeks[w] ?? 0) + a;
  return { days, weeks };
}

/** Compromissos futuros (dia/semana a partir de `fromDate`), lidos na transação, para mostrar ao reduzir limites. */
export async function readCommitmentsFrom(db: Firestore, tx: Transaction, studentId: string, fromDate: LocalDate) {
  const fromWeek = weekStartOf(fromDate);
  const [days, weeks] = await Promise.all([
    tx.get(db.collection(`studentUsage/${studentId}/days`).where("date", ">=", fromDate).orderBy("date").limit(120)),
    tx.get(db.collection(`studentUsage/${studentId}/weeks`).where("weekStart", ">=", fromWeek).orderBy("weekStart").limit(30)),
  ]);
  return {
    days: days.docs.map((d) => ({ key: String(d.data().date), committedCents: committedOf(d.data()) })),
    weeks: weeks.docs.map((d) => ({ key: String(d.data().weekStart), committedCents: committedOf(d.data()) })),
  };
}
