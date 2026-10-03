import type { Firestore, Timestamp } from "firebase-admin/firestore";
import { addDays, localDateOf, type LocalDate } from "@/lib/dates/school-time";
import { notFound } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { averageUnitMicros, grossProfitCents, type Micros } from "./cost";
import {
  allocateFefo,
  availableAt,
  checkStock,
  eligibleOn,
  parseBalance,
  parseCapacity,
  parseLot,
  parseReservation,
  remainingOf,
  reservedTotal,
  sumFrom,
  type Capacity,
  type Lot,
  type StockBalance,
  type StockMode,
} from "./model";

const EXPIRING_DAYS = 3;
const iso = (value: unknown) => (value && typeof (value as Timestamp).toDate === "function" ? (value as Timestamp).toDate().toISOString() : null);

export type OverviewItem = {
  productId: string;
  name: string;
  status: "active" | "inactive";
  mode: StockMode;
  onHand: number;
  reservedUnits: number;
  /** Unidades que ainda podem ser comprometidas hoje: físico vendável (não vencido) − reservas. */
  availableUnits: number;
  minStock: number | null;
  lowStock: boolean;
  /** Unidades em estoque já vencidas (precisam de perda explícita) e as que vencem nos próximos dias. */
  expiredUnits: number;
  expiringUnits: number;
  /** Planejado: unidades reservadas para hoje sem entrada física correspondente (o que registrar antes de entregar). */
  missingEntryUnits: number;
  movementSeq: number;
  /** Só com `costs.read`. */
  valueMicros?: Micros;
  averageUnitMicros?: Micros;
};
export type Overview = { today: LocalDate; canSeeCosts: boolean; items: OverviewItem[] };

async function eligibleToday(db: Firestore, productId: string, today: LocalDate): Promise<number> {
  const snap = await db.collection(`stockBalances/${productId}/lots`).orderBy("openKey").startAt(today).limit(60).get();
  const lots = snap.docs.map((d) => parseLot(d.id, d.data()));
  const covered = allocateFefo(lots, Number.MAX_SAFE_INTEGER, eligibleOn(today));
  return Number.MAX_SAFE_INTEGER - covered.unmet;
}

/** Visão geral para a tela de estoque (cantina e administração). Custos só para quem tem `costs.read`. */
export async function readOverview(db: Firestore, actor: Actor): Promise<Overview> {
  authorize(actor, "inventory.read");
  const withCosts = can(actor, "costs.read");
  const today = localDateOf(new Date());
  const [products, balances, costs] = await Promise.all([
    db.collection("products").get(),
    db.collection("stockBalances").get(),
    withCosts ? db.collection("stockCosts").get() : Promise.resolve(null),
  ]);
  const balanceById = new Map(balances.docs.map((d) => [d.id, d.data()]));
  const costById = new Map((costs?.docs ?? []).map((d) => [d.id, Number(d.get("valueMicros") ?? 0)]));
  const items: OverviewItem[] = [];
  for (const doc of products.docs) {
    const mode: StockMode = doc.get("availabilityMode") === "planned" ? "planned" : "physical";
    const balance: StockBalance = parseBalance(doc.id, mode, balanceById.get(doc.id));
    const reserved = reservedTotal(balance);
    let available: number;
    let missing = 0;
    if (mode === "physical") {
      available = availableAt(balance.supplyByValidity, balance.reservedByDate, today);
    } else {
      const eligible = balance.onHand > 0 ? await eligibleToday(db, doc.id, today) : 0;
      const reservedToday = balance.reservedByDate[today] ?? 0;
      available = Math.max(0, eligible - reservedToday);
      missing = Math.max(0, reservedToday - eligible);
    }
    const expired = balance.onHand - sumFrom(balance.supplyByValidity, today);
    const expiring = sumFrom(balance.supplyByValidity, today) - sumFrom(balance.supplyByValidity, addDays(today, EXPIRING_DAYS + 1));
    const item: OverviewItem = {
      productId: doc.id,
      name: String(doc.get("name") ?? doc.id),
      status: doc.get("status") === "inactive" ? "inactive" : "active",
      mode,
      onHand: balance.onHand,
      reservedUnits: reserved,
      availableUnits: available,
      minStock: balance.minStock,
      lowStock: balance.minStock !== null && available <= balance.minStock,
      expiredUnits: Math.max(0, expired),
      expiringUnits: Math.max(0, expiring),
      missingEntryUnits: missing,
      movementSeq: balance.movementSeq,
    };
    if (withCosts) {
      const value = costById.get(doc.id) ?? 0;
      item.valueMicros = value;
      item.averageUnitMicros = averageUnitMicros(value, balance.onHand);
    }
    items.push(item);
  }
  items.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return { today, canSeeCosts: withCosts, items };
}

export type LotView = { id: string; lotCode: string | null; availableOn: LocalDate; expiresOn: LocalDate | null; validThrough: LocalDate; quantity: number; remaining: number; expired: boolean };
export type ReservationView = { id: string; orderRef: string; consumptionDate: LocalDate; shiftId: string; quantity: number; remaining: number; deliveredQty: number };
export type MovementView = {
  id: string;
  seq: number;
  type: string;
  quantity: number;
  onHandAfter: number;
  reason: string | null;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  consumptionDate: LocalDate | null;
  createdAt: string | null;
  // custos: só com `costs.read`
  unitCostMicros?: Micros;
  totalCostMicros?: Micros;
  valueAfterMicros?: Micros;
  revenueCents?: number | null;
  grossProfitCents?: number | null;
};
export type ReceiptView = {
  id: string;
  kind: string;
  quantity: number;
  unitCostMicros: Micros;
  totalCostMicros: Micros;
  availableOn: LocalDate;
  expiresOn: LocalDate | null;
  lotCode: string | null;
  supplier: string | null;
  documentRef: string | null;
  note: string | null;
  status: string;
  createdAt: string | null;
};
export type ProductStockView = {
  today: LocalDate;
  canSeeCosts: boolean;
  productId: string;
  name: string;
  mode: StockMode;
  onHand: number;
  reservedUnits: number;
  minStock: number | null;
  movementSeq: number;
  lots: LotView[];
  reservations: ReservationView[];
  capacities: (Capacity & { available: number })[];
  movements: MovementView[];
  valueMicros?: Micros;
  averageUnitMicros?: Micros;
  /** Entradas com custo/fornecedor: só administração. */
  receipts?: ReceiptView[];
};

/** Detalhe de um produto: lotes, reservas ativas, cotas, últimos movimentos (sem custo para a cantina) e, para a administração, entradas e valor. */
export async function readProductStock(db: Firestore, actor: Actor, productId: string): Promise<ProductStockView> {
  authorize(actor, "inventory.read");
  const withCosts = can(actor, "costs.read");
  const today = localDateOf(new Date());
  const [product, balanceSnap, costSnap] = await db.getAll(db.doc(`products/${productId}`), db.doc(`stockBalances/${productId}`), db.doc(`stockCosts/${productId}`));
  if (!product?.exists) throw notFound("product_not_found", "Produto não encontrado.");
  const mode: StockMode = product.get("availabilityMode") === "planned" ? "planned" : "physical";
  const balance = parseBalance(productId, mode, balanceSnap?.data());
  const [lots, reservations, capacities, movements, receipts] = await Promise.all([
    db.collection(`stockBalances/${productId}/lots`).orderBy("openKey").limit(60).get(),
    db.collection(`stockBalances/${productId}/reservations`).where("status", "==", "active").limit(100).get(),
    db.collection("dailyCapacity").where("productId", "==", productId).get(),
    db.collection(`stockCosts/${productId}/movements`).orderBy("seq", "desc").limit(50).get(),
    withCosts ? db.collection("stockReceipts").where("productId", "==", productId).limit(100).get() : Promise.resolve(null),
  ]);
  const view: ProductStockView = {
    today,
    canSeeCosts: withCosts,
    productId,
    name: String(product.get("name") ?? productId),
    mode,
    onHand: balance.onHand,
    reservedUnits: reservedTotal(balance),
    minStock: balance.minStock,
    movementSeq: balance.movementSeq,
    lots: lots.docs.map((d) => {
      const lot = parseLot(d.id, d.data());
      return { id: lot.id, lotCode: lot.lotCode, availableOn: lot.availableOn, expiresOn: lot.expiresOn, validThrough: lot.validThrough, quantity: lot.quantity, remaining: lot.remaining, expired: lot.validThrough < today };
    }),
    reservations: reservations.docs
      .map((d) => parseReservation(d.id, d.data()))
      .sort((a, b) => a.consumptionDate.localeCompare(b.consumptionDate) || a.id.localeCompare(b.id))
      .map((r) => ({ id: r.id, orderRef: r.orderRef, consumptionDate: r.consumptionDate, shiftId: r.shiftId, quantity: r.quantity, remaining: remainingOf(r), deliveredQty: r.deliveredQty })),
    capacities: capacities.docs
      .map((d) => parseCapacity(productId, String(d.get("date")), String(d.get("shiftId")), d.data()))
      .filter((c) => c.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date) || a.shiftId.localeCompare(b.shiftId))
      .map((c) => ({ ...c, available: c.capacity === null ? 0 : Math.max(0, c.capacity - c.reserved - c.delivered) })),
    movements: movements.docs.map((d) => {
      const m = d.data();
      const row: MovementView = {
        id: d.id,
        seq: Number(m.seq),
        type: String(m.type),
        quantity: Number(m.quantity),
        onHandAfter: Number(m.onHandAfter),
        reason: typeof m.reason === "string" ? m.reason : null,
        reasonCode: typeof m.reasonCode === "string" ? m.reasonCode : null,
        referenceType: typeof m.referenceType === "string" ? m.referenceType : null,
        referenceId: typeof m.referenceId === "string" ? m.referenceId : null,
        consumptionDate: typeof m.consumptionDate === "string" ? m.consumptionDate : null,
        createdAt: iso(m.createdAt),
      };
      if (withCosts) {
        row.unitCostMicros = Number(m.unitCostMicros);
        row.totalCostMicros = Number(m.totalCostMicros);
        row.valueAfterMicros = Number(m.valueAfterMicros);
        row.revenueCents = typeof m.revenueCents === "number" ? m.revenueCents : null;
        row.grossProfitCents = row.revenueCents !== null && row.type === "sale_exit" ? grossProfitCents(row.revenueCents, -row.totalCostMicros) : null;
      }
      return row;
    }),
  };
  if (withCosts) {
    const value = costSnap?.exists ? Number(costSnap.get("valueMicros")) : 0;
    view.valueMicros = value;
    view.averageUnitMicros = averageUnitMicros(value, balance.onHand);
    view.receipts = (receipts?.docs ?? [])
      .map((d) => ({ doc: d, at: (d.get("createdAt") as Timestamp | undefined)?.toMillis() ?? 0 }))
      .sort((a, b) => b.at - a.at)
      .map(({ doc }) => ({
        id: doc.id,
        kind: String(doc.get("kind")),
        quantity: Number(doc.get("quantity")),
        unitCostMicros: Number(doc.get("unitCostMicros")),
        totalCostMicros: Number(doc.get("totalCostMicros")),
        availableOn: String(doc.get("availableOn")),
        expiresOn: typeof doc.get("expiresOn") === "string" ? String(doc.get("expiresOn")) : null,
        lotCode: typeof doc.get("lotCode") === "string" ? String(doc.get("lotCode")) : null,
        supplier: typeof doc.get("supplier") === "string" ? String(doc.get("supplier")) : null,
        documentRef: typeof doc.get("documentRef") === "string" ? String(doc.get("documentRef")) : null,
        note: typeof doc.get("note") === "string" ? String(doc.get("note")) : null,
        status: String(doc.get("status")),
        createdAt: iso(doc.get("createdAt")),
      }));
  }
  return view;
}

export type StockReconciliation = { productId: string; ok: boolean; onHand: number; valueMicros: Micros; movementCount: number; problems: string[] };

async function reconcileOne(db: Firestore, productId: string): Promise<StockReconciliation> {
  return db.runTransaction(async (tx) => {
    const [product, balanceSnap, costSnap] = await tx.getAll(db.doc(`products/${productId}`), db.doc(`stockBalances/${productId}`), db.doc(`stockCosts/${productId}`));
    const mode: StockMode = product?.get("availabilityMode") === "planned" ? "planned" : "physical";
    const [movements, lots, reservations, capacities] = await Promise.all([
      tx.get(db.collection(`stockCosts/${productId}/movements`).orderBy("seq", "asc")),
      tx.get(db.collection(`stockBalances/${productId}/lots`)),
      tx.get(db.collection(`stockBalances/${productId}/reservations`)),
      tx.get(db.collection("dailyCapacity").where("productId", "==", productId)),
    ]);
    const balance = parseBalance(productId, mode, balanceSnap?.data());
    const valueMicros = costSnap?.exists ? Number(costSnap.get("valueMicros")) : 0;
    const problems = checkStock({
      balance,
      valueMicros,
      movements: movements.docs.map((d) => ({ seq: Number(d.get("seq")), type: String(d.get("type")), quantity: Number(d.get("quantity")), totalCostMicros: Number(d.get("totalCostMicros")), onHandAfter: Number(d.get("onHandAfter")), valueAfterMicros: Number(d.get("valueAfterMicros")) })),
      lots: lots.docs.map((d): Lot & { hasOpenKey: boolean } => ({ ...parseLot(d.id, d.data()), hasOpenKey: typeof d.get("openKey") === "string" })),
      reservations: reservations.docs.map((d) => parseReservation(d.id, d.data())),
      capacities: capacities.docs.map((d) => parseCapacity(productId, String(d.get("date")), String(d.get("shiftId")), d.data())),
    });
    return { productId, ok: problems.length === 0, onHand: balance.onHand, valueMicros, movementCount: movements.size, problems };
  });
}

/**
 * Reconciliação saldo × livro × lotes × reservas × cotas (O(n) em movimentos; operação/auditoria, não tela de família).
 * Sem `productId` reconcilia todos os produtos com saldo. Só administração (`audit.read`).
 */
export async function reconcileStock(db: Firestore, actor: Actor, productId?: string): Promise<{ ok: boolean; products: StockReconciliation[] }> {
  authorize(actor, "audit.read");
  const ids = productId ? [productId] : (await db.collection("stockBalances").get()).docs.map((d) => d.id).slice(0, 300);
  const products: StockReconciliation[] = [];
  for (const id of ids) products.push(await reconcileOne(db, id));
  return { ok: products.every((p) => p.ok), products };
}
