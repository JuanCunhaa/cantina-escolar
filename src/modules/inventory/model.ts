import { z } from "zod";
import { isLocalDate, type LocalDate } from "@/lib/dates/school-time";

/**
 * Estoque de produto acabado (F10, docs/domains/inventory.md §15). Regras puras, sem Firebase.
 *
 * Dois modos por produto (`products.availabilityMode`):
 *  - `physical`: estoque físico; reserva do pedido antecipado NÃO baixa o físico. Disponível = físico vendável − reservas
 *    ativas, calculado com a validade dos lotes (`availableAt`);
 *  - `planned`: disponibilidade por data/turno (cota em `dailyCapacity`); a reserva consome cota, não estoque; a entrega
 *    exige entrada física (lote com `availableOn`) e baixa cota e unidade física sem duplo desconto.
 *
 * Quantidades são unidades inteiras. Custos ficam em outro documento (`stockCosts`), só da administração.
 */
export type StockMode = "physical" | "planned";

export const NO_EXPIRY: LocalDate = "9999-12-31"; // validade "infinita" (ordena por último no FEFO)
export const MAX_RECEIPT_UNITS = 10_000;
export const MAX_ON_HAND = 1_000_000;
export const MAX_LINE_UNITS = 500; // unidades por linha de reserva/saída (também limita as leituras de lotes na transação)
export const MAX_RESERVATION_DATES = 450; // datas distintas com reserva por produto (cabe no documento de saldo)
export const MAX_VALIDITY_KEYS = 120; // validades distintas em estoque por produto
export const LOT_PAGE = 10;
export const MAX_LOT_PAGES = 6; // no máximo 60 lotes abertos lidos por operação

export const RECEIPT_KINDS = ["purchase", "production", "opening"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];
export const LOSS_REASONS = ["expiry", "breakage", "discard", "internal_use"] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

export const MOVEMENT_TYPES = ["receipt", "receipt_reversal", "sale_exit", "loss", "count_adjustment", "adjustment"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/* ---------------------------------------------------------------------------------------------- documentos */

export type StockBalance = {
  productId: string;
  mode: StockMode;
  onHand: number;
  /** Reservas ativas (não entregues nem liberadas) por data de consumo. */
  reservedByDate: Record<LocalDate, number>;
  /** Unidades em estoque agrupadas pela validade do lote (`validThrough`); soma = onHand. */
  supplyByValidity: Record<LocalDate, number>;
  minStock: number | null;
  /** Último movimento do livro (contíguo 1..n). */
  movementSeq: number;
  /** Seq do último movimento que tirou unidades pelo CUSTO MÉDIO (saída, perda, ajuste negativo): trava estorno de entrada. */
  lastExitSeq: number;
  /** +1 a cada escrita do documento (inclui reservas): ordem monotônica para a tela. */
  version: number;
};

const num = (v: unknown, fallback = 0) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fallback);

function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
      if (Number.isSafeInteger(amount) && (amount as number) > 0) out[key] = amount as number;
    }
  }
  return out;
}

/** Documento ausente = produto sem movimento. Valor corrompido nunca é "corrigido" em silêncio. */
export function parseBalance(productId: string, mode: StockMode, data: Record<string, unknown> | undefined): StockBalance {
  if (!data) return { productId, mode, onHand: 0, reservedByDate: {}, supplyByValidity: {}, minStock: null, movementSeq: 0, lastExitSeq: 0, version: 0 };
  const onHand = data.onHand;
  if (!Number.isSafeInteger(onHand) || (onHand as number) < 0) throw new Error("Saldo de estoque corrompido.");
  return {
    productId,
    mode,
    onHand: onHand as number,
    reservedByDate: numberMap(data.reservedByDate),
    supplyByValidity: numberMap(data.supplyByValidity),
    minStock: Number.isSafeInteger(data.minStock) ? (data.minStock as number) : null,
    movementSeq: num(data.movementSeq),
    lastExitSeq: num(data.lastExitSeq),
    version: num(data.version),
  };
}

export const reservedTotal = (b: Pick<StockBalance, "reservedByDate">) => Object.values(b.reservedByDate).reduce((a, n) => a + n, 0);

export type Lot = {
  id: string;
  productId: string;
  receiptId: string | null;
  lotCode: string | null;
  /** Quando as unidades passam a poder ser entregues (produto planejado: a data de produção; físico: a de recebimento). */
  availableOn: LocalDate;
  /** Vencimento informado; null = sem validade. */
  expiresOn: LocalDate | null;
  /** Último dia em que pode ser consumida: expiresOn; sem validade, físico = infinito e planejado = o próprio dia. */
  validThrough: LocalDate;
  quantity: number;
  remaining: number;
};

export const openKeyOf = (lot: Pick<Lot, "validThrough" | "availableOn" | "id">) => `${lot.validThrough}|${lot.availableOn}|${lot.id}`;

export function parseLot(id: string, data: Record<string, unknown>): Lot {
  const { productId, availableOn, validThrough, quantity, remaining } = data;
  if (typeof productId !== "string" || !isLocalDate(availableOn) || !isLocalDate(validThrough) || !Number.isSafeInteger(quantity) || !Number.isSafeInteger(remaining) || (remaining as number) < 0) {
    throw new Error("Lote corrompido.");
  }
  return {
    id,
    productId,
    receiptId: typeof data.receiptId === "string" ? data.receiptId : null,
    lotCode: typeof data.lotCode === "string" ? data.lotCode : null,
    availableOn,
    expiresOn: isLocalDate(data.expiresOn) ? data.expiresOn : null,
    validThrough,
    quantity: quantity as number,
    remaining: remaining as number,
  };
}

export type ReservationStatus = "active" | "fulfilled" | "released";
export type Reservation = {
  id: string;
  productId: string;
  orderRef: string;
  consumptionDate: LocalDate;
  shiftId: string;
  quantity: number;
  deliveredQty: number;
  releasedQty: number;
};
export const remainingOf = (r: Pick<Reservation, "quantity" | "deliveredQty" | "releasedQty">) => r.quantity - r.deliveredQty - r.releasedQty;
export const statusOf = (r: Reservation): ReservationStatus => (remainingOf(r) > 0 ? "active" : r.deliveredQty > 0 ? "fulfilled" : "released");

export function parseReservation(id: string, data: Record<string, unknown>): Reservation {
  const { productId, orderRef, consumptionDate, shiftId, quantity, deliveredQty, releasedQty } = data;
  if (typeof productId !== "string" || typeof orderRef !== "string" || !isLocalDate(consumptionDate) || typeof shiftId !== "string" || !Number.isSafeInteger(quantity) || !Number.isSafeInteger(deliveredQty) || !Number.isSafeInteger(releasedQty)) {
    throw new Error("Reserva corrompida.");
  }
  return { id, productId, orderRef, consumptionDate, shiftId, quantity: quantity as number, deliveredQty: deliveredQty as number, releasedQty: releasedQty as number };
}

export type Capacity = { productId: string; date: LocalDate; shiftId: string; capacity: number | null; reserved: number; delivered: number; version: number };
export const capacityId = (productId: string, date: LocalDate, shiftId: string) => `${productId}_${date}_${shiftId}`;

export function parseCapacity(productId: string, date: LocalDate, shiftId: string, data: Record<string, unknown> | undefined): Capacity {
  return {
    productId,
    date,
    shiftId,
    capacity: Number.isSafeInteger(data?.capacity) ? (data!.capacity as number) : null,
    reserved: num(data?.reserved),
    delivered: num(data?.delivered),
    version: num(data?.version),
  };
}

/* ----------------------------------------------------------------------------- disponibilidade e viabilidade */

/** Soma das entradas do mapa com chave ≥ `from` (datas YYYY-MM-DD comparam como texto). */
export function sumFrom(map: Record<string, number>, from: string): number {
  let total = 0;
  for (const [key, amount] of Object.entries(map)) if (key >= from) total += amount;
  return total;
}

/**
 * Déficit de viabilidade das reservas: cada reserva de data D só pode usar lotes com validade ≥ D, então, para toda data
 * de reserva t, as reservas com data ≥ t precisam caber no estoque com validade ≥ t (conjuntos aninhados: a condição é
 * necessária e suficiente). Retorna o maior déficit (0 = todas as reservas físicas são atendíveis).
 */
export function deficitOf(supply: Record<string, number>, reserved: Record<string, number>): number {
  let worst = 0;
  for (const t of Object.keys(reserved)) worst = Math.max(worst, sumFrom(reserved, t) - sumFrom(supply, t));
  return worst;
}

/**
 * Quantas unidades FÍSICAS ainda podem ser comprometidas (nova reserva ou venda de balcão) para consumo em `date`
 * sem tirar o que está reservado para outros pedidos: mínimo, nas datas ≤ `date` (e na própria `date`), da folga
 * "estoque com validade ≥ t − reservas com data ≥ t". Lote vencido para `date` não conta.
 */
export function availableAt(supply: Record<string, number>, reserved: Record<string, number>, date: LocalDate): number {
  const thresholds = new Set<string>([date, ...Object.keys(reserved).filter((d) => d <= date)]);
  let slack = Infinity;
  for (const t of thresholds) slack = Math.min(slack, sumFrom(supply, t) - sumFrom(reserved, t));
  return Math.max(0, slack === Infinity ? 0 : slack);
}

/** Aloca unidades dos lotes por validade mais próxima (FEFO), depois disponibilidade e ID. `accept` filtra os elegíveis. */
export function allocateFefo(lots: readonly Lot[], quantity: number, accept: (lot: Lot) => boolean): { allocations: { lotId: string; quantity: number }[]; unmet: number } {
  const sorted = lots.filter((l) => l.remaining > 0 && accept(l)).sort((a, b) => a.validThrough.localeCompare(b.validThrough) || a.availableOn.localeCompare(b.availableOn) || a.id.localeCompare(b.id));
  const allocations: { lotId: string; quantity: number }[] = [];
  let left = quantity;
  for (const lot of sorted) {
    if (left <= 0) break;
    const take = Math.min(left, lot.remaining);
    allocations.push({ lotId: lot.id, quantity: take });
    left -= take;
  }
  return { allocations, unmet: left };
}

/** Lote utilizável para consumo em `date`: já disponível e dentro da validade. */
export const eligibleOn = (date: LocalDate) => (lot: Lot) => lot.availableOn <= date && date <= lot.validThrough;

/* ------------------------------------------------------------------------------------------- reconciliação */

export type MovementRow = { seq: number; type: string; quantity: number; totalCostMicros: number; onHandAfter: number; valueAfterMicros: number };
export type ReservationRow = Reservation;

/**
 * Reconcilia saldo × livro × lotes × reservas × cotas de UM produto. `movements` em ordem crescente de seq. Devolve os
 * problemas encontrados (vazio = reconciliado). Reservas não são saídas contábeis: nunca entram na soma do livro.
 */
export function checkStock(input: {
  balance: StockBalance;
  valueMicros: number;
  movements: readonly MovementRow[];
  lots: readonly (Lot & { hasOpenKey: boolean })[];
  reservations: readonly Reservation[];
  capacities: readonly Capacity[];
}): string[] {
  const { balance, valueMicros, movements, lots, reservations, capacities } = input;
  const problems: string[] = [];
  let onHand = 0;
  let value = 0;
  movements.forEach((m, index) => {
    if (m.seq !== index + 1) problems.push(`movimento ${m.seq} fora de ordem (esperado ${index + 1})`);
    onHand += m.quantity;
    value += m.totalCostMicros;
    if (onHand < 0) problems.push(`movimento ${m.seq}: estoque físico negativo`);
    if (m.onHandAfter !== onHand) problems.push(`movimento ${m.seq}: saldo após ${m.onHandAfter} ≠ acumulado ${onHand}`);
    if (m.valueAfterMicros !== value) problems.push(`movimento ${m.seq}: valor após ${m.valueAfterMicros} ≠ acumulado ${value}`);
  });
  if (balance.movementSeq !== movements.length) problems.push(`movementSeq ${balance.movementSeq} ≠ ${movements.length} movimentos`);
  if (balance.onHand !== onHand) problems.push(`físico ${balance.onHand} ≠ soma do livro ${onHand}`);
  if (valueMicros !== value) problems.push(`valor ${valueMicros} ≠ soma do livro ${value}`);
  if (balance.onHand === 0 && valueMicros !== 0) problems.push("sem unidades, mas com valor residual");

  const lotSum = lots.reduce((a, l) => a + l.remaining, 0);
  if (lotSum !== balance.onHand) problems.push(`lotes somam ${lotSum} ≠ físico ${balance.onHand}`);
  const supply: Record<string, number> = {};
  for (const lot of lots) {
    if (lot.remaining < 0 || lot.remaining > lot.quantity) problems.push(`lote ${lot.id}: restante ${lot.remaining} fora de 0..${lot.quantity}`);
    if (lot.hasOpenKey !== lot.remaining > 0) problems.push(`lote ${lot.id}: chave de abertura inconsistente`);
    if (lot.remaining > 0) supply[lot.validThrough] = (supply[lot.validThrough] ?? 0) + lot.remaining;
  }
  const keys = new Set([...Object.keys(supply), ...Object.keys(balance.supplyByValidity)]);
  for (const key of keys) if ((supply[key] ?? 0) !== (balance.supplyByValidity[key] ?? 0)) problems.push(`validade ${key}: lotes ${supply[key] ?? 0} ≠ mapa ${balance.supplyByValidity[key] ?? 0}`);

  const reserved: Record<string, number> = {};
  const perCapacity = new Map<string, { reserved: number; delivered: number }>();
  for (const r of reservations) {
    const remaining = remainingOf(r);
    if (remaining < 0) problems.push(`reserva ${r.id}: entregue + liberado excede a quantidade`);
    if (remaining > 0) reserved[r.consumptionDate] = (reserved[r.consumptionDate] ?? 0) + remaining;
    const cap = perCapacity.get(capacityId(r.productId, r.consumptionDate, r.shiftId)) ?? { reserved: 0, delivered: 0 };
    cap.reserved += Math.max(0, remaining);
    cap.delivered += r.deliveredQty;
    perCapacity.set(capacityId(r.productId, r.consumptionDate, r.shiftId), cap);
  }
  const dates = new Set([...Object.keys(reserved), ...Object.keys(balance.reservedByDate)]);
  for (const date of dates) if ((reserved[date] ?? 0) !== (balance.reservedByDate[date] ?? 0)) problems.push(`reservas de ${date}: documentos ${reserved[date] ?? 0} ≠ saldo ${balance.reservedByDate[date] ?? 0}`);
  for (const c of capacities) {
    const id = capacityId(c.productId, c.date, c.shiftId);
    const expected = perCapacity.get(id) ?? { reserved: 0, delivered: 0 };
    if (c.reserved !== expected.reserved) problems.push(`cota ${id}: reservado ${c.reserved} ≠ reservas ${expected.reserved}`);
    if (c.delivered !== expected.delivered) problems.push(`cota ${id}: entregue ${c.delivered} ≠ reservas ${expected.delivered}`);
    perCapacity.delete(id);
  }
  for (const [id, c] of perCapacity) if (c.reserved > 0 || c.delivered > 0) problems.push(`cota ${id}: documento ausente para reservas existentes`);
  return problems;
}

/* ------------------------------------------------------------------------------------------------ entradas */

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const DATE = z.string().refine(isLocalDate, "Data inválida (use AAAA-MM-DD).");
const REASON = z.string().trim().min(3).max(140);
const text = (max: number) => z.string().trim().max(max);

export const receiptCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    key: KEY,
    productId: z.string().regex(ID),
    kind: z.enum(RECEIPT_KINDS),
    quantity: z.number().int().min(1).max(MAX_RECEIPT_UNITS),
    /** Reais por unidade em texto decimal ("1,10"): nunca ponto flutuante. */
    unitCost: z.string().trim().min(1).max(12),
    /** Data em que as unidades podem ser entregues. Planejado: obrigatória. Físico: data do recebimento (padrão hoje). */
    availableOn: DATE.optional(),
    expiresOn: DATE.optional(),
    lotCode: text(40).optional(),
    supplier: text(80).optional(),
    documentRef: text(60).optional(),
    note: text(200).optional(),
  }),
  z.object({ action: z.literal("reverse"), key: KEY, receiptId: z.string().regex(ID), reason: REASON }),
]);
export type ReceiptCommand = z.infer<typeof receiptCommandSchema>;

export const lossCommandSchema = z.object({
  key: KEY,
  productId: z.string().regex(ID),
  quantity: z.number().int().min(1).max(MAX_LINE_UNITS),
  reason: z.enum(LOSS_REASONS),
  note: REASON,
  /** Opcional: baixar de um lote específico (ex.: o lote vencido). Sem lote, sai primeiro o que vence antes. */
  lotId: z.string().regex(ID).optional(),
});
export type LossCommand = z.infer<typeof lossCommandSchema>;

export const adjustmentCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("count"), key: KEY, productId: z.string().regex(ID), countedQuantity: z.number().int().min(0).max(MAX_ON_HAND), expectedSeq: z.number().int().min(0), reason: REASON, unitCost: z.string().trim().max(12).optional() }),
  z.object({ action: z.literal("adjust"), key: KEY, productId: z.string().regex(ID), delta: z.number().int().min(-MAX_LINE_UNITS).max(MAX_RECEIPT_UNITS).refine((n) => n !== 0, "Informe uma diferença."), reason: REASON, unitCost: z.string().trim().max(12).optional() }),
  z.object({ action: z.literal("extend"), key: KEY, productId: z.string().regex(ID), lotId: z.string().regex(ID), validThrough: DATE, reason: REASON }),
  z.object({ action: z.literal("threshold"), key: KEY, productId: z.string().regex(ID), minStock: z.number().int().min(0).max(MAX_ON_HAND).nullable() }),
]);
export type AdjustmentCommand = z.infer<typeof adjustmentCommandSchema>;

export const capacityCommandSchema = z.object({
  key: KEY,
  productId: z.string().regex(ID),
  date: DATE,
  shiftId: z.string().regex(ID),
  capacity: z.number().int().min(0).max(5_000),
  expectedVersion: z.number().int().min(0).optional(),
});
export type CapacityCommand = z.infer<typeof capacityCommandSchema>;
