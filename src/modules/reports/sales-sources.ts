import { localDateOf, type LocalDate } from "@/lib/dates/school-time";
import { remainingOf, remainingValueOf } from "@/modules/orders/fulfillment-model";
import type { AdjustmentFact, CancellationFact, LedgerFact, LossFact, PendingOrderFact, PurchaseFact, PurchaseReversalFact, RetainedFact, ReversalFact, SaleChannel, SaleFact } from "./sales-model";

/**
 * Leitura PURA dos documentos de origem (F21): transforma o que o Firestore devolve em fatos tipados. Nada aqui acessa a rede.
 * Regra de ouro: campo ausente ou inválido vira `null` (pendência visível), NUNCA zero. IDs de fato = caminho do documento de origem.
 */
type Data = Record<string, unknown>;
type Stamp = { toDate(): Date };

const isStamp = (v: unknown): v is Stamp => typeof v === "object" && v !== null && typeof (v as Stamp).toDate === "function";
export const dateOfStamp = (v: unknown): LocalDate | null => (isStamp(v) ? localDateOf(v.toDate()) : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

export type ProductInfo = { name: string; categoryId: string | null };

/** Dados do pedido/venda direta de origem usados para canal, turno e o snapshot de nome/categoria da época da venda. */
export type OriginInfo = { channel: SaleChannel; shiftId: string | null; items: Map<string, ProductInfo>; paidCents: number | null };

function snapshotItems(items: unknown): Map<string, ProductInfo> {
  const map = new Map<string, ProductInfo>();
  if (!Array.isArray(items)) return map;
  for (const it of items as Data[]) {
    const id = text(it.productId);
    if (id && !map.has(id)) map.set(id, { name: text(it.name, id), categoryId: typeof it.categoryId === "string" ? it.categoryId : null });
  }
  return map;
}

export function originOfOrder(d: Data): OriginInfo {
  const channel: SaleChannel = d.channel === "advance" ? "advance" : d.channel === "counter" ? "counter" : "unknown";
  return { channel, shiftId: typeof d.shiftId === "string" ? d.shiftId : null, items: snapshotItems(d.items), paidCents: int(d.totalCents) };
}
export const originOfDirectSale = (d: Data): OriginInfo => ({ channel: "direct", shiftId: typeof d.shiftId === "string" ? d.shiftId : null, items: snapshotItems(d.items), paidCents: int(d.totalCents) });

const MOVEMENT_PATH = /^stockCosts\/([^/]+)\/movements\/([^/]+)$/;
export const productOfMovementPath = (path: string): string | null => MOVEMENT_PATH.exec(path)?.[1] ?? null;

/** Chave do documento de origem de uma baixa: `order:ID` / `directSale:ID` (ou a referência bruta, sem origem conhecida). */
export function originKey(d: Data): string {
  return `${text(d.referenceType, "?")}:${text(d.referenceId, "?")}`;
}

export function saleFactOf(path: string, d: Data, origins: ReadonlyMap<string, OriginInfo>, products: ReadonlyMap<string, ProductInfo>): SaleFact | null {
  const productId = productOfMovementPath(path);
  const date = dateOfStamp(d.createdAt);
  const qty = int(d.quantity);
  if (!productId || !date || qty === null || qty === 0) return null;
  const key = originKey(d);
  const origin = origins.get(key);
  const info = origin?.items.get(productId) ?? products.get(productId) ?? { name: productId, categoryId: null };
  const cost = int(d.totalCostMicros);
  const revenue = int(d.revenueCents);
  return {
    id: path,
    date,
    productId,
    productName: info.name,
    categoryId: info.categoryId,
    channel: origin?.channel ?? "unknown",
    shiftId: origin?.shiftId ?? null,
    units: Math.abs(qty),
    revenueCents: revenue !== null && revenue >= 0 ? revenue : null,
    costMicros: cost === null ? null : Math.abs(cost),
    origin: key,
    originFound: origin !== undefined,
  };
}

export function lossFactOf(path: string, d: Data, products: ReadonlyMap<string, ProductInfo>): LossFact | null {
  const productId = productOfMovementPath(path);
  const date = dateOfStamp(d.createdAt);
  const qty = int(d.quantity);
  if (!productId || !date || qty === null || qty === 0) return null;
  const info = products.get(productId) ?? { name: productId, categoryId: null };
  const cost = int(d.totalCostMicros);
  return { id: path, date, productId, productName: info.name, categoryId: info.categoryId, reasonCode: text(d.reasonCode, "unknown") || "unknown", units: Math.abs(qty), costMicros: cost === null ? null : Math.abs(cost), origin: originKey(d) };
}

export function adjustmentFactOf(path: string, d: Data, products: ReadonlyMap<string, ProductInfo>): AdjustmentFact | null {
  const productId = productOfMovementPath(path);
  const date = dateOfStamp(d.createdAt);
  const qty = int(d.quantity);
  const cost = int(d.totalCostMicros);
  if (!productId || !date || qty === null || cost === null) return null;
  const info = products.get(productId) ?? { name: productId, categoryId: null };
  return { id: path, date, productId, productName: info.name, categoryId: info.categoryId, type: text(d.type, "adjustment"), units: qty, costMicros: cost };
}

export function purchaseFactOf(id: string, d: Data, products: ReadonlyMap<string, ProductInfo>): PurchaseFact | null {
  const productId = text(d.productId);
  const date = dateOfStamp(d.createdAt);
  const qty = int(d.quantity);
  const cost = int(d.totalCostMicros);
  if (!productId || !date || qty === null || cost === null) return null;
  const info = products.get(productId) ?? { name: productId, categoryId: null };
  return { id: `stockReceipts/${id}`, date, productId, productName: info.name, categoryId: info.categoryId, kind: text(d.kind, "purchase"), units: qty, costMicros: cost };
}

/** Estorno de entrada: movimento `receipt_reversal` (quantidade e custo negativos), na data em que o estorno aconteceu. */
export function purchaseReversalFactOf(path: string, d: Data, products: ReadonlyMap<string, ProductInfo>): PurchaseReversalFact | null {
  const productId = productOfMovementPath(path);
  const date = dateOfStamp(d.createdAt);
  const qty = int(d.quantity);
  const cost = int(d.totalCostMicros);
  if (!productId || !date || qty === null || cost === null) return null;
  const info = products.get(productId) ?? { name: productId, categoryId: null };
  return { id: path, date, productId, productName: info.name, categoryId: info.categoryId, units: Math.abs(qty), costMicros: Math.abs(cost) };
}

/** Pedido aberto (ou não retirado a resolver): restante a entregar e seu valor PAGO (rateio por acumulado, nunca o preço atual). */
export function pendingOrderOf(id: string, d: Data, products: ReadonlyMap<string, ProductInfo>): PendingOrderFact | null {
  const consumptionDate = text(d.consumptionDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(consumptionDate) || !Array.isArray(d.items)) return null;
  const lines = (d.items as Data[]).flatMap((it) => {
    const quantity = int(it.quantity);
    const subtotal = int(it.subtotalCents);
    if (quantity === null || subtotal === null) return [];
    const progress = { quantity, subtotalCents: subtotal, deliveredQty: int(it.deliveredQty) ?? 0, canceledQty: int(it.canceledQty) ?? 0, exchangedQty: int(it.exchangedQty) ?? 0 };
    const units = remainingOf(progress);
    if (units === 0) return [];
    const productId = text(it.productId);
    return [{ productId, name: text(it.name, productId), categoryId: typeof it.categoryId === "string" ? it.categoryId : (products.get(productId)?.categoryId ?? null), units, valueCents: remainingValueOf(progress) }];
  });
  return { id: `orders/${id}`, consumptionDate, shiftId: typeof d.shiftId === "string" ? d.shiftId : null, channel: originOfOrder(d).channel, status: text(d.status), lines };
}

/** Não retirado encerrado COM cobrança mantida (`close_charged`): linha própria, não é venda entregue nem reembolso. */
export function retainedFactOf(id: string, d: Data): RetainedFact | null {
  const np = d.nonPickup as Data | undefined;
  const res = np?.resolution as Data | undefined;
  if (!res || res.kind !== "close_charged") return null;
  const date = dateOfStamp(res.resolvedAt);
  const amount = int(res.amountCents);
  if (!date || amount === null) return null;
  return { id: `orders/${id}`, date, shiftId: typeof d.shiftId === "string" ? d.shiftId : null, channel: originOfOrder(d).channel, amountCents: amount, units: (int(res.returnedUnits) ?? 0) + (int(res.discardedUnits) ?? 0) };
}

const CANCELLATION_PATH = /^orders\/([^/]+)\/cancellations\/([^/]+)$/;
export const orderOfCancellationPath = (path: string): string | null => CANCELLATION_PATH.exec(path)?.[1] ?? null;

/** Turno e categoria vêm do PEDIDO de origem (snapshot da compra); sem ele, o cadastro atual do produto. */
export function cancellationFactOf(path: string, d: Data, orders: ReadonlyMap<string, OriginInfo>, products: ReadonlyMap<string, ProductInfo>): CancellationFact | null {
  const orderId = orderOfCancellationPath(path);
  const date = dateOfStamp(d.createdAt);
  if (!orderId || !date || !Array.isArray(d.lines)) return null;
  const lines = (d.lines as Data[]).flatMap((l) => {
    const units = int(l.quantity);
    const refund = int(l.refundCents);
    if (units === null || refund === null) return [];
    const productId = text(l.productId);
    const snapshot = orders.get(orderId)?.items.get(productId);
    return [{ productId, name: text(l.name, productId), categoryId: snapshot ? snapshot.categoryId : (products.get(productId)?.categoryId ?? null), units, refundCents: refund }];
  });
  return { id: path, date, orderId, kind: text(d.kind, "unknown"), shiftId: orders.get(orderId)?.shiftId ?? null, channel: orders.get(orderId)?.channel ?? "unknown", lines };
}

export function reversalFactOf(id: string, d: Data): ReversalFact | null {
  const outstanding = int(d.outstandingCents);
  const opened = int(d.openedCents);
  if (outstanding === null || opened === null || typeof d.status !== "string") return null;
  return { id: `paymentPendencies/${id}`, status: d.status, openedCents: opened, outstandingCents: outstanding, recoveredCents: int(d.recoveredCents) ?? 0, writtenOffCents: int(d.writtenOffCents) ?? 0 };
}

export function ledgerFactOf(path: string, d: Data): LedgerFact | null {
  const date = dateOfStamp(d.createdAt);
  const amount = int(d.amountCents);
  if (!date || amount === null || typeof d.type !== "string") return null;
  return { id: path, date, type: d.type, amountCents: amount };
}
