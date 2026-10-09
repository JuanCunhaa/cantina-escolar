import { Timestamp, type DocumentData, type DocumentReference, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { addDays, localInstant, type LocalDate } from "@/lib/dates/school-time";
import type { DayFacts } from "./sales-days";
import { emptyDayFacts } from "./sales-days";
import type { AdjustmentFact, CancellationFact, LedgerFact, LossFact, PurchaseFact, PurchaseReversalFact, RetainedFact, SaleFact } from "./sales-model";
import {
  adjustmentFactOf,
  cancellationFactOf,
  ledgerFactOf,
  lossFactOf,
  originKey,
  originOfDirectSale,
  originOfOrder,
  orderOfCancellationPath,
  productOfMovementPath,
  purchaseFactOf,
  purchaseReversalFactOf,
  retainedFactOf,
  saleFactOf,
  type OriginInfo,
  type ProductInfo,
} from "./sales-sources";

/**
 * Leitura dos documentos de origem de um INTERVALO de dias (F21): produz os fatos tipados (`DayFacts`). É a única porta de
 * entrada dos fatos — o dia corrente é lido assim ao vivo e cada dia fechado é lido assim UMA vez para ser materializado
 * (`sales-days.ts`). Consultas por intervalo de campo único; o grupo de coleções tem `fieldOverrides` em firestore.indexes.json.
 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export async function getMany(db: Firestore, refs: readonly DocumentReference[]) {
  const parts = await Promise.all(chunks(refs, 300).map((c) => db.getAll(...c)));
  return parts.flat();
}

const dataOf = (d: QueryDocumentSnapshot): DocumentData => d.data();

/**
 * Nome/categoria dos produtos: carrega só os ATIVOS de uma vez (rankings de baixo giro) e busca por ID, sob demanda, os que
 * aparecem nos fatos e não estão ativos (produto retirado do catálogo continua nos movimentos antigos).
 */
export class ProductDirectory {
  readonly map = new Map<string, ProductInfo>();
  readonly active: { productId: string; name: string; categoryId: string | null }[] = [];
  private constructor(private readonly db: Firestore) {}

  static async load(db: Firestore): Promise<ProductDirectory> {
    const dir = new ProductDirectory(db);
    const snap = await db.collection("products").where("status", "==", "active").limit(5000).get();
    for (const d of snap.docs) {
      const info = ProductDirectory.infoOf(d.id, d.data());
      dir.map.set(d.id, info);
      dir.active.push({ productId: d.id, ...info });
    }
    return dir;
  }

  private static infoOf(id: string, x: DocumentData): ProductInfo {
    return { name: typeof x.name === "string" ? x.name : id, categoryId: typeof x.categoryId === "string" ? x.categoryId : null };
  }

  /** Garante no mapa os produtos citados (inclusive inativos). */
  async ensure(ids: Iterable<string>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => ID.test(id) && !this.map.has(id));
    for (const snap of await getMany(this.db, missing.map((id) => this.db.doc(`products/${id}`)))) if (snap.exists) this.map.set(snap.id, ProductDirectory.infoOf(snap.id, snap.data()!));
  }
}

export type ReadOptions = { cap: number; products: ProductDirectory };

/** Lê e tipa os fatos de `[from, to]` (datas locais, fim inclusivo). Estouro de `cap` em qualquer fonte = `truncated`. */
export async function readFacts(db: Firestore, range: { from: LocalDate; to: LocalDate }, opts: ReadOptions): Promise<DayFacts> {
  const { cap, products } = opts;
  const start = Timestamp.fromDate(localInstant(range.from, "00:00"));
  const end = Timestamp.fromDate(localInstant(addDays(range.to, 1), "00:00"));
  const group = (name: string, fields: string[]) =>
    db
      .collectionGroup(name)
      .where("createdAt", ">=", start)
      .where("createdAt", "<", end)
      .select(...fields)
      .limit(cap + 1)
      .get();

  const [movements, cancellations, entries, receiptDocs, resolved] = await Promise.all([
    group("movements", ["type", "quantity", "totalCostMicros", "revenueCents", "referenceType", "referenceId", "reasonCode", "createdAt"]),
    group("cancellations", ["kind", "lines", "createdAt"]),
    group("entries", ["type", "amountCents", "createdAt"]),
    db.collection("stockReceipts").where("createdAt", ">=", start).where("createdAt", "<", end).limit(cap + 1).get(),
    // Só as resoluções do PERÍODO (intervalo em campo único), nunca o histórico inteiro de não retirados encerrados.
    db.collection("orders").where("nonPickup.resolution.resolvedAt", ">=", start).where("nonPickup.resolution.resolvedAt", "<", end).limit(cap + 1).get(),
  ]);

  const facts = emptyDayFacts();
  const bad = (source: string) => (facts.unreadable[source] = (facts.unreadable[source] ?? 0) + 1);
  if (movements.size > cap) facts.truncated.push("movimentos de estoque");
  if (cancellations.size > cap) facts.truncated.push("cancelamentos");
  if (entries.size > cap) facts.truncated.push("lançamentos das carteiras");
  if (receiptDocs.size > cap) facts.truncated.push("entradas de estoque");
  if (resolved.size > cap) facts.truncated.push("não retirados encerrados");

  const moves = movements.docs.slice(0, cap).filter((d) => productOfMovementPath(d.ref.path) !== null);
  const cancelDocs = cancellations.docs.slice(0, cap).filter((d) => orderOfCancellationPath(d.ref.path) !== null);
  const receipts = receiptDocs.docs.slice(0, cap);

  // Nome/categoria dos produtos citados (só os que faltam), e o pedido/venda de origem (canal, turno, snapshot da época).
  await products.ensure([
    ...moves.map((d) => productOfMovementPath(d.ref.path)!),
    ...receipts.map((d) => String(d.get("productId") ?? "")),
    ...cancelDocs.flatMap((d) => ((d.get("lines") as { productId?: unknown }[] | undefined) ?? []).map((l) => String(l.productId ?? ""))),
  ]);
  const productMap = products.map;

  const wanted = new Map<string, DocumentReference>();
  for (const d of moves) {
    if (d.get("type") !== "sale_exit") continue;
    const type = d.get("referenceType");
    const id = d.get("referenceId");
    if ((type === "order" || type === "directSale") && typeof id === "string" && ID.test(id)) wanted.set(originKey(dataOf(d)), db.doc(`${type === "order" ? "orders" : "directSales"}/${id}`));
  }
  const origins = new Map<string, OriginInfo>();
  for (const snap of await getMany(db, [...wanted.values()])) {
    if (!snap.exists) continue;
    const isOrder = snap.ref.parent.id === "orders";
    origins.set(`${isOrder ? "order" : "directSale"}:${snap.id}`, isOrder ? originOfOrder(snap.data()!) : originOfDirectSale(snap.data()!));
  }

  const sales: SaleFact[] = facts.sales;
  const losses: LossFact[] = facts.losses;
  const adjustments: AdjustmentFact[] = facts.adjustments;
  const purchaseReversals: PurchaseReversalFact[] = facts.purchaseReversals;
  for (const d of moves) {
    const type = d.get("type");
    if (type === "sale_exit") {
      const f = saleFactOf(d.ref.path, dataOf(d), origins, productMap);
      if (f) sales.push(f);
      else bad("baixas de venda");
    } else if (type === "loss") {
      const f = lossFactOf(d.ref.path, dataOf(d), productMap);
      if (f) losses.push(f);
      else bad("perdas");
    } else if (type === "receipt_reversal") {
      const f = purchaseReversalFactOf(d.ref.path, dataOf(d), productMap);
      if (f) purchaseReversals.push(f);
      else bad("estornos de entrada");
    } else if (type === "count_adjustment" || type === "adjustment") {
      const f = adjustmentFactOf(d.ref.path, dataOf(d), productMap);
      if (f) adjustments.push(f);
      else bad("ajustes de estoque");
    }
  }

  // Cancelamentos: turno, canal e categoria da época vêm do PEDIDO (o cancelamento não os guarda).
  const cancelledOrders = new Map<string, OriginInfo>();
  const orderRefs = [...new Set(cancelDocs.map((d) => orderOfCancellationPath(d.ref.path)!))].map((id) => db.doc(`orders/${id}`));
  for (const snap of await getMany(db, orderRefs)) if (snap.exists) cancelledOrders.set(snap.id, originOfOrder(snap.data()!));
  const cancellationFacts: CancellationFact[] = facts.cancellations;
  for (const d of cancelDocs) {
    const f = cancellationFactOf(d.ref.path, dataOf(d), cancelledOrders, productMap);
    if (f) cancellationFacts.push(f);
    else bad("cancelamentos");
  }

  const retained: RetainedFact[] = facts.retained;
  for (const d of resolved.docs.slice(0, cap)) {
    const res = (d.get("nonPickup") as { resolution?: { kind?: string } } | undefined)?.resolution;
    if (res?.kind !== "close_charged") continue;
    const f = retainedFactOf(d.id, dataOf(d));
    if (f) retained.push(f);
    else bad("não retirados encerrados");
  }

  const purchases: PurchaseFact[] = facts.purchases;
  for (const d of receipts) {
    const f = purchaseFactOf(d.id, dataOf(d), productMap);
    if (f) purchases.push(f);
    else bad("entradas de estoque");
  }
  const ledger: LedgerFact[] = facts.ledger;
  for (const d of entries.docs.slice(0, cap)) {
    if (!/^wallets\/[^/]+\/entries\/[^/]+$/.test(d.ref.path)) continue;
    const f = ledgerFactOf(d.ref.path, dataOf(d));
    if (f) ledger.push(f);
    else bad("lançamentos das carteiras");
  }
  return facts;
}
