import type { Firestore, Query, QuerySnapshot, Transaction } from "firebase-admin/firestore";
import { addDays } from "@/lib/dates/school-time";
import { conflict } from "@/lib/domain-error";
import type { LocalDate } from "@/lib/dates/school-time";
import { receiptOfDirectSale, receiptOfTopup, type Receipt } from "@/modules/fees/receipts";
import { MAX_RECEIPTS_PER_SESSION, type CashLineReceipt, type CashPoint } from "./cash-model";

/**
 * Leituras do caixa (F20). Os recebimentos do operador no dia vêm dos próprios documentos de recarga manual (`topups`) e venda
 * direta (`directSales`) — o fechamento é uma projeção reconstruível, nunca a fonte do dinheiro. Compra com saldo da carteira
 * (`orders` de balcão) só aparece como consumo informativo: não é dinheiro novo.
 */
export const lineOf = (r: Receipt): CashLineReceipt => ({ ref: r.ref, kind: r.kind, method: r.method, grossCents: r.grossCents, reversedCents: r.reversedCents });

type Reader = (query: Query) => Promise<QuerySnapshot>;
const readerOf = (tx: Transaction | null): Reader => (query) => (tx ? tx.get(query) : query.get());

/** Recebimentos do operador no ponto/data. Passou do teto = 409 (o fechamento nunca é parcial). */
export async function readOperatorReceipts(db: Firestore, tx: Transaction | null, scope: { uid: string; point: CashPoint; date: LocalDate }): Promise<Receipt[]> {
  const read = readerOf(tx);
  const snap =
    scope.point === "secretaria"
      ? await read(db.collection("topups").where("operator.uid", "==", scope.uid).where("receivedOn", "==", scope.date).limit(MAX_RECEIPTS_PER_SESSION + 1))
      : await read(db.collection("directSales").where("createdByUid", "==", scope.uid).where("consumptionDate", "==", scope.date).limit(MAX_RECEIPTS_PER_SESSION + 1));
  if (snap.size > MAX_RECEIPTS_PER_SESSION) throw conflict("too_many_receipts", "Há recebimentos demais neste caixa para um único fechamento.", { max: MAX_RECEIPTS_PER_SESSION });
  return snap.docs.map((d) => (scope.point === "secretaria" ? receiptOfTopup(d.id, d.data()) : receiptOfDirectSale(d.id, d.data())));
}

export type WalletConsumption = { orderCount: number; totalCents: number };

/** Consumo com carteira no balcão do operador (informativo): NÃO é dinheiro recebido e nunca entra no esperado do caixa. */
export async function readWalletConsumption(db: Firestore, tx: Transaction | null, scope: { uid: string; point: CashPoint; date: LocalDate }): Promise<WalletConsumption> {
  if (scope.point !== "counter") return { orderCount: 0, totalCents: 0 };
  const snap = await readerOf(tx)(db.collection("orders").where("channel", "==", "counter").where("createdByUid", "==", scope.uid).where("consumptionDate", "==", scope.date).limit(2000));
  let totalCents = 0;
  let orderCount = 0;
  for (const d of snap.docs) {
    if (d.get("status") === "cancelled") continue;
    orderCount += 1;
    totalCents += Number.isSafeInteger(d.get("totalCents")) ? (d.get("totalCents") as number) : 0;
  }
  return { orderCount, totalCents };
}

export type ScopeKey = `${string}__${CashPoint}__${string}`;
export const scopeKeyOf = (date: LocalDate, point: CashPoint, uid: string): ScopeKey => `${date}__${point}__${uid}`;

/**
 * Visão PRÓPRIA do operador: uma consulta por dia da janela com igualdades (operador + data), então só os documentos DELE são lidos
 * (nenhum recebimento de outro operador sai do banco) e não precisa de índice composto.
 */
async function readOwnDocs(db: Firestore, range: { from: LocalDate; to: LocalDate }, uid: string): Promise<[QuerySnapshotLike, QuerySnapshotLike]> {
  const days: LocalDate[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);
  const [topupSnaps, saleSnaps] = await Promise.all([
    Promise.all(days.map((d) => db.collection("topups").where("operator.uid", "==", uid).where("receivedOn", "==", d).limit(MAX_RECEIPTS_PER_SESSION + 1).get())),
    Promise.all(days.map((d) => db.collection("directSales").where("createdByUid", "==", uid).where("consumptionDate", "==", d).limit(MAX_RECEIPTS_PER_SESSION + 1).get())),
  ]);
  const join = (snaps: QuerySnapshot[]): QuerySnapshotLike => ({ docs: snaps.flatMap((x) => x.docs), size: snaps.reduce((n, x) => n + x.size, 0) });
  return [join(topupSnaps), join(saleSnaps)];
}
type QuerySnapshotLike = { docs: QuerySnapshot["docs"]; size: number };

/** Todos os recebimentos de caixa físico no intervalo (secretaria + balcão), agrupados por operador/ponto/data. Filtro por UID em memória. */
export async function readReceiptsByScope(db: Firestore, range: { from: LocalDate; to: LocalDate }, uid?: string): Promise<{ groups: Map<ScopeKey, Receipt[]>; truncated: boolean }> {
  const CAP = 3000;
  const [topups, sales] = uid ? await readOwnDocs(db, range, uid) : await Promise.all([
    db.collection("topups").where("receivedOn", ">=", range.from).where("receivedOn", "<=", range.to).limit(CAP + 1).get(),
    db.collection("directSales").where("consumptionDate", ">=", range.from).where("consumptionDate", "<=", range.to).limit(CAP + 1).get(),
  ]);
  const groups = new Map<ScopeKey, Receipt[]>();
  const add = (r: Receipt) => {
    if (!r.operatorUid || (uid && r.operatorUid !== uid)) return;
    const key = scopeKeyOf(r.receivedOn, r.point as CashPoint, r.operatorUid);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  };
  for (const d of topups.docs.slice(0, CAP)) add(receiptOfTopup(d.id, d.data()));
  for (const d of sales.docs.slice(0, CAP)) add(receiptOfDirectSale(d.id, d.data()));
  return { groups, truncated: topups.size > CAP || sales.size > CAP };
}
