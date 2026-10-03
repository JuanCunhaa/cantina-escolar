import { FieldValue, type DocumentReference, type Firestore, type Timestamp, type Transaction } from "firebase-admin/firestore";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { isLocalDate, type LocalDate } from "@/lib/dates/school-time";
import { averageUnitMicros, entryValue, exitCost, mulDivRound, type Micros } from "./cost";
import {
  LOT_PAGE,
  MAX_LINE_UNITS,
  MAX_LOT_PAGES,
  MAX_ON_HAND,
  MAX_RESERVATION_DATES,
  MAX_VALIDITY_KEYS,
  NO_EXPIRY,
  allocateFefo,
  availableAt,
  capacityId,
  deficitOf,
  eligibleOn,
  openKeyOf,
  parseBalance,
  parseCapacity,
  parseLot,
  parseReservation,
  remainingOf,
  reservedTotal,
  statusOf,
  sumFrom,
  type Capacity,
  type Lot,
  type MovementType,
  type Reservation,
  type StockBalance,
  type StockMode,
} from "./model";

/**
 * Sessão transacional de estoque (F10): o ÚNICO ponto que muda saldo, lotes, reservas, cotas e custo. Serve ao checkout
 * (reservar/liberar/reagendar), à entrega e ao PDV (baixar) e aos comandos administrativos (entrada, perda, contagem).
 *
 * Contrato com o chamador (docs/firebase/transactions.md): abrir a sessão DENTRO da transação do pedido/comando,
 * chamar todos os métodos de PLANEJAMENTO (`reserve`, `release`, `exit`, `receive`, `removeUnits`…) — que só LEEM e
 * calculam em memória, lançando `DomainError` se algo não cabe — e só então chamar `commit()`, que grava uma vez cada
 * documento tocado. Nenhuma leitura pode ocorrer depois do `commit`. Vários métodos sobre o mesmo produto enxergam o
 * estado acumulado (ex.: reagendar = `release` da reserva antiga + `reserve` da nova, sem escrita duplicada).
 *
 * Reserva NÃO é saída física: só `exit` baixa unidades e custo. Documentos (docs/firebase/schema.md, F10):
 *  - `stockBalances/{pid}`: quantidades (cantina e administração leem; sem custo);
 *  - `stockBalances/{pid}/lots/{lotId}` e `…/reservations/{id}`;
 *  - `stockCosts/{pid}` e `stockCosts/{pid}/movements/{m…}`: valor e livro com custo (só administração);
 *  - `dailyCapacity/{pid}_{data}_{turno}`: cota (planejado) e comprometimento por data/turno.
 */
export type SessionActor = { uid: string; role: string | null };

export type Tracked<T> = { value: T; isNew: boolean; dirty: boolean };

export type MovementDraft = {
  type: MovementType;
  /** Unidades assinadas: entrada +, saída −. */
  quantity: number;
  /** Valor assinado em micro-centavos, EXATO (soma dos movimentos = valor do estoque). */
  totalCostMicros: Micros;
  /** Informativo: total ÷ |quantidade| arredondado; o total é a verdade. */
  unitCostMicros: Micros;
  allocations: { lotId: string; quantity: number }[];
  reason: string | null;
  /** Código do motivo (perda: expiry|breakage|discard|internal_use; entrada: kind). */
  reasonCode: string | null;
  referenceType: string;
  referenceId: string;
  consumptionDate: LocalDate | null;
  revenueCents: number | null;
};
type Movement = MovementDraft & { seq: number; onHandAfter: number; valueAfterMicros: Micros };

export type ProductState = {
  productId: string;
  mode: StockMode;
  balance: StockBalance;
  balanceCreatedAt: Timestamp | null;
  valueMicros: Micros;
  costCreatedAt: Timestamp | null;
  balanceDirty: boolean;
  lots: Map<string, Tracked<Lot>>;
  reservations: Map<string, Tracked<Reservation>>;
  movements: Movement[];
};

export type ReserveInput = {
  productId: string;
  quantity: number;
  consumptionDate: LocalDate;
  shiftId: string;
  reservationId: string;
  /** Pedido dono da reserva (rastreio). */
  orderRef: string;
  /** Teto de unidades da data/turno vindo do cardápio (F07 `menuOverrides.items[].limit`), se houver. */
  menuLimit?: number | null;
};
export type ReserveResult = { productId: string; reservationId: string; quantity: number; consumptionDate: LocalDate; shiftId: string; committed: number; limit: number | null };
export type ReleaseResult = { productId: string; reservationId: string; releasedQuantity: number; remaining: number };
export type ExitInput = {
  productId: string;
  quantity: number;
  /** Data do consumo (entrega do pedido ou venda do balcão). A elegibilidade dos lotes usa max(data, hoje). */
  consumptionDate: LocalDate;
  /** Entrega de um pedido: baixa esta reserva (e a cota planejada) sem duplo desconto. Sem ela = venda de balcão. */
  reservationId?: string;
  referenceType: string;
  referenceId: string;
  /** Receita da venda (centavos, snapshot do preço autorizado) para a margem; opcional. */
  revenueCents?: number | null;
};
export type ExitResult = { productId: string; movementId: string; seq: number; quantity: number; unitCostMicros: Micros; totalCostMicros: Micros; allocations: { lotId: string; quantity: number }[]; reservationId: string | null };
export type AffectedReservation = { reservationId: string; orderRef: string; consumptionDate: LocalDate; shiftId: string; remaining: number };
export type RemoveResult = { productId: string; movementId: string; seq: number; quantity: number; totalCostMicros: Micros; allocations: { lotId: string; quantity: number }[]; shortfallUnits: number; affectedReservations: AffectedReservation[] };

const movementId = (seq: number) => `m${String(seq).padStart(9, "0")}`;

function bump(map: Record<string, number>, key: string, delta: number, label: string): void {
  const next = (map[key] ?? 0) + delta;
  if (next < 0) throw new Error(`Invariante de estoque violada (${label}).`);
  if (next === 0) delete map[key];
  else map[key] = next;
}

export class StockSession {
  private readonly products = new Map<string, ProductState>();
  private readonly capacities = new Map<string, Tracked<Capacity>>();
  private committed = false;

  constructor(
    readonly db: Firestore,
    readonly tx: Transaction,
    readonly today: LocalDate,
    readonly actor: SessionActor,
  ) {
    if (!isLocalDate(today)) throw new RangeError("Data de hoje inválida.");
  }

  /* ---------------------------------------------------------------------------------------------- leitura */

  private guard(): void {
    if (this.committed) throw new Error("Sessão de estoque já confirmada: nenhuma leitura ou planejamento depois do commit.");
  }

  private refs(productId: string) {
    const db = this.db;
    return {
      product: db.doc(`products/${productId}`),
      balance: db.doc(`stockBalances/${productId}`),
      cost: db.doc(`stockCosts/${productId}`),
      lots: db.collection(`stockBalances/${productId}/lots`),
      reservations: db.collection(`stockBalances/${productId}/reservations`),
    };
  }

  /** Carrega (uma vez) produto, saldo e valor. Produto inexistente = 404; o modo vem do cadastro atual. */
  async product(productId: string): Promise<ProductState> {
    this.guard();
    const cached = this.products.get(productId);
    if (cached) return cached;
    const r = this.refs(productId);
    const [product, balance, cost] = await this.tx.getAll(r.product, r.balance, r.cost);
    if (!product?.exists) throw notFound("product_not_found", "Produto não encontrado.");
    const mode: StockMode = product.get("availabilityMode") === "planned" ? "planned" : "physical";
    const valueMicros = cost?.exists ? Number(cost.get("valueMicros")) : 0;
    if (!Number.isSafeInteger(valueMicros) || valueMicros < 0) throw new Error("Valor de estoque corrompido.");
    const state: ProductState = {
      productId,
      mode,
      balance: parseBalance(productId, mode, balance?.data()),
      balanceCreatedAt: (balance?.get("createdAt") as Timestamp | undefined) ?? null,
      valueMicros,
      costCreatedAt: (cost?.get("createdAt") as Timestamp | undefined) ?? null,
      balanceDirty: false,
      lots: new Map(),
      reservations: new Map(),
      movements: [],
    };
    this.products.set(productId, state);
    return state;
  }

  private async capacity(productId: string, date: LocalDate, shiftId: string): Promise<Tracked<Capacity>> {
    const id = capacityId(productId, date, shiftId);
    const cached = this.capacities.get(id);
    if (cached) return cached;
    const snap = await this.tx.get(this.db.doc(`dailyCapacity/${id}`));
    const tracked: Tracked<Capacity> = { value: parseCapacity(productId, date, shiftId, snap.data()), isNew: !snap.exists, dirty: false };
    this.capacities.set(id, tracked);
    return tracked;
  }

  private async reservation(p: ProductState, reservationId: string): Promise<Tracked<Reservation> | null> {
    const cached = p.reservations.get(reservationId);
    if (cached) return cached;
    const snap = await this.tx.get(this.refs(p.productId).reservations.doc(reservationId));
    if (!snap.exists) return null;
    const tracked: Tracked<Reservation> = { value: parseReservation(snap.id, snap.data()!), isNew: false, dirty: false };
    p.reservations.set(reservationId, tracked);
    return tracked;
  }

  /** Lê um lote específico (estorno de entrada, perda de um lote, extensão de validade). */
  async lot(productId: string, lotId: string): Promise<Tracked<Lot> | null> {
    const p = await this.product(productId);
    const cached = p.lots.get(lotId);
    if (cached) return cached;
    const snap = await this.tx.get(this.refs(productId).lots.doc(lotId));
    if (!snap.exists) return null;
    const tracked: Tracked<Lot> = { value: parseLot(snap.id, snap.data()!), isNew: false, dirty: false };
    p.lots.set(lotId, tracked);
    return tracked;
  }

  /**
   * Lê lotes ABERTOS em ordem de validade (FEFO), a partir de `fromKey` (null = desde o mais antigo, inclusive vencidos),
   * em páginas, até `done()` ser verdadeiro. Lotes esvaziados não têm `openKey` e nunca aparecem. No máximo 60 por operação.
   */
  private async loadLots(p: ProductState, fromKey: string | null, done: () => boolean): Promise<void> {
    const col = this.refs(p.productId).lots;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LOT_PAGES; page++) {
      let query = col.orderBy("openKey");
      query = cursor !== null ? query.startAfter(cursor) : fromKey !== null ? query.startAt(fromKey) : query;
      const snap = await this.tx.get(query.limit(LOT_PAGE));
      for (const doc of snap.docs) if (!p.lots.has(doc.id)) p.lots.set(doc.id, { value: parseLot(doc.id, doc.data()), isNew: false, dirty: false });
      if (done() || snap.size < LOT_PAGE) return;
      cursor = String(snap.docs[snap.docs.length - 1]!.get("openKey"));
    }
    throw conflict("too_many_open_lots", "Há lotes abertos demais neste produto. Encerre lotes antigos (perda ou estorno) antes de continuar.");
  }

  private lotValues(p: ProductState): Lot[] {
    return [...p.lots.values()].map((t) => t.value);
  }

  /* --------------------------------------------------------------------------------------------- reservas */

  /**
   * Reserva `quantity` unidades para uma data/turno de consumo (checkout). NÃO baixa o físico. Compromisso por
   * data/turno em `dailyCapacity` (cota do planejado e/ou teto do cardápio). Produto físico: só reserva o que
   * está livre (estoque válido na data − reservas de outros pedidos). Produto planejado: só a cota (a entrada física
   * vem antes da entrega, nunca da reserva).
   */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const { productId, quantity, consumptionDate, shiftId, reservationId } = input;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_LINE_UNITS) throw invalid("invalid_quantity", "Quantidade inválida.");
    if (!isLocalDate(consumptionDate)) throw invalid("invalid_date", "Data inválida.");
    if (consumptionDate < this.today) throw invalid("date_in_past", "Não é possível reservar para uma data passada.");
    const p = await this.product(productId);
    if (await this.reservation(p, reservationId)) throw conflict("reservation_exists", "Já existe uma reserva com este identificador.");
    const cap = await this.capacity(productId, consumptionDate, shiftId);
    const c = cap.value;
    const committed = c.reserved + c.delivered;

    let limit: number | null = input.menuLimit ?? null;
    if (p.mode === "planned") {
      if (c.capacity === null) throw conflict("capacity_not_set", "A administração ainda não definiu a cota deste produto para a data e o turno.", { productId, date: consumptionDate, shiftId });
      limit = limit === null ? c.capacity : Math.min(limit, c.capacity);
    }
    if (limit !== null && committed + quantity > limit) {
      throw conflict("capacity_exceeded", "Cota esgotada para a data e o turno.", { productId, date: consumptionDate, shiftId, limit, committed, available: Math.max(0, limit - committed) });
    }
    if (p.mode === "physical") {
      const available = availableAt(p.balance.supplyByValidity, p.balance.reservedByDate, consumptionDate);
      if (quantity > available) throw conflict("insufficient_stock", "Estoque insuficiente (reservas de outros pedidos não são vendidas).", { productId, date: consumptionDate, available, requested: quantity });
    }
    if (!(consumptionDate in p.balance.reservedByDate) && Object.keys(p.balance.reservedByDate).length >= MAX_RESERVATION_DATES) {
      throw conflict("too_many_reservation_dates", "Há datas reservadas demais para este produto.");
    }

    bump(p.balance.reservedByDate, consumptionDate, quantity, "reserva");
    p.balanceDirty = true;
    c.reserved += quantity;
    cap.dirty = true;
    const reservation: Reservation = { id: reservationId, productId, orderRef: input.orderRef, consumptionDate, shiftId, quantity, deliveredQty: 0, releasedQty: 0 };
    p.reservations.set(reservationId, { value: reservation, isNew: true, dirty: true });
    return { productId, reservationId, quantity, consumptionDate, shiftId, committed: committed + quantity, limit };
  }

  /** Libera (cancelamento, reembolso, reagendamento) o que ainda não foi entregue. Não cria entrada fictícia nem mexe em custo. */
  async release(input: { productId: string; reservationId: string; quantity?: number }): Promise<ReleaseResult> {
    const p = await this.product(input.productId);
    const tracked = await this.reservation(p, input.reservationId);
    if (!tracked) throw notFound("reservation_not_found", "Reserva não encontrada.");
    const r = tracked.value;
    const remaining = remainingOf(r);
    const quantity = input.quantity ?? remaining;
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw invalid("invalid_quantity", "Quantidade inválida.");
    if (remaining === 0) throw conflict("reservation_closed", "A reserva já foi encerrada.");
    if (quantity > remaining) throw conflict("reservation_closed", "Há menos unidades reservadas do que o informado.", { remaining });
    const cap = await this.capacity(r.productId, r.consumptionDate, r.shiftId);
    if (cap.value.reserved < quantity) throw new Error("Invariante de estoque violada (cota reservada).");
    bump(p.balance.reservedByDate, r.consumptionDate, -quantity, "liberação");
    p.balanceDirty = true;
    cap.value.reserved -= quantity;
    cap.dirty = true;
    r.releasedQty += quantity;
    tracked.dirty = true;
    return { productId: r.productId, reservationId: r.id, releasedQuantity: quantity, remaining: remaining - quantity };
  }

  /* ------------------------------------------------------------------------------------------------ saída */

  /**
   * Saída FÍSICA definitiva (entrega do pedido ou venda do balcão): baixa unidades e custo médio, grava custo unitário
   * e total HISTÓRICOS no movimento e, se vier de uma reserva, baixa a reserva e a cota (sem duplo desconto).
   * Exige unidade física elegível para o dia: produto planejado sem entrada registrada falha com `entry_required` e diz
   * o que registrar; lote vencido nunca é usado. Venda de balcão não toma unidades reservadas de outros pedidos.
   */
  async exit(input: ExitInput): Promise<ExitResult> {
    const { productId, quantity, consumptionDate } = input;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_LINE_UNITS) throw invalid("invalid_quantity", "Quantidade inválida.");
    if (!isLocalDate(consumptionDate)) throw invalid("invalid_date", "Data inválida.");
    const p = await this.product(productId);
    const eligDate = consumptionDate > this.today ? consumptionDate : this.today;

    let reservation: Tracked<Reservation> | null = null;
    if (input.reservationId) {
      reservation = await this.reservation(p, input.reservationId);
      if (!reservation) throw notFound("reservation_not_found", "Reserva não encontrada.");
      const remaining = remainingOf(reservation.value);
      if (remaining < quantity) throw conflict("reservation_closed", "A reserva não cobre esta quantidade (já entregue, liberada ou menor).", { remaining });
    }

    const reservedOthers = reservation ? 0 : p.balance.reservedByDate[eligDate] ?? 0;
    // Venda de balcão de produto planejado precisa de quantidade + reservas da data em lotes elegíveis: ler lotes até cobrir ISSO
    // (parar ao cobrir só a quantidade geraria entry_required falso quando há mais de uma página de lotes).
    const needed = p.mode === "planned" ? quantity + reservedOthers : quantity;
    await this.loadLots(p, eligDate, () => allocateFefo(this.lotValues(p), needed, eligibleOn(eligDate)).unmet === 0);
    const lots = this.lotValues(p);
    const covered = allocateFefo(lots, Number.MAX_SAFE_INTEGER, eligibleOn(eligDate));
    const eligible = Number.MAX_SAFE_INTEGER - covered.unmet;

    if (p.mode === "planned") {
      if (eligible - reservedOthers < quantity) {
        const missing = quantity + reservedOthers - eligible;
        throw conflict("entry_required", "Falta registrar a entrada física deste produto para a data.", {
          productId,
          date: eligDate,
          missingUnits: Math.max(1, missing),
          eligibleUnits: eligible,
          reservedUnits: reservedOthers,
          action: "Registre a entrada de produto acabado (quantidade, custo unitário e data de disponibilidade) antes de entregar.",
        });
      }
    } else if (reservation) {
      if (eligible < quantity) throw conflict("insufficient_stock", "Não há unidade física válida para a data (estoque ausente ou vencido).", { productId, date: eligDate, available: eligible, requested: quantity, expiredUnits: Math.max(0, p.balance.onHand - sumFrom(p.balance.supplyByValidity, eligDate)) });
    } else {
      const available = availableAt(p.balance.supplyByValidity, p.balance.reservedByDate, eligDate);
      if (quantity > available) {
        throw conflict("insufficient_stock", "Estoque insuficiente (unidades reservadas por outros pedidos não são vendidas).", {
          productId,
          date: eligDate,
          available,
          requested: quantity,
          reservedUnits: reservedTotal(p.balance),
          expiredUnits: Math.max(0, p.balance.onHand - sumFrom(p.balance.supplyByValidity, eligDate)),
        });
      }
    }

    const { allocations, unmet } = allocateFefo(lots, quantity, eligibleOn(eligDate));
    if (unmet > 0) throw conflict("insufficient_stock", "Estoque insuficiente.", { productId, date: eligDate, available: eligible, requested: quantity });

    const total = exitCost(p.valueMicros, p.balance.onHand, quantity);
    this.takeFromLots(p, allocations);
    p.balance.onHand -= quantity;
    p.valueMicros -= total;
    if (reservation) {
      const r = reservation.value;
      const cap = await this.capacity(r.productId, r.consumptionDate, r.shiftId);
      if (cap.value.reserved < quantity) throw new Error("Invariante de estoque violada (cota reservada).");
      bump(p.balance.reservedByDate, r.consumptionDate, -quantity, "entrega");
      cap.value.reserved -= quantity;
      cap.value.delivered += quantity;
      cap.dirty = true;
      r.deliveredQty += quantity;
      reservation.dirty = true;
    }
    const movement = this.push(p, {
      type: "sale_exit",
      quantity: -quantity,
      totalCostMicros: -total,
      unitCostMicros: averageUnitMicros(total, quantity),
      allocations,
      reason: null,
      reasonCode: null,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      consumptionDate,
      revenueCents: input.revenueCents ?? null,
    });
    p.balance.lastExitSeq = movement.seq;
    return { productId, movementId: movementId(movement.seq), seq: movement.seq, quantity, unitCostMicros: movement.unitCostMicros, totalCostMicros: total, allocations, reservationId: input.reservationId ?? null };
  }

  /* ------------------------------------------------------------------------------- entrada e ajustes físicos */

  /** Entrada de produto acabado: lote novo (um por entrada), valor exato somado ao estoque, movimento no livro. */
  async receive(input: {
    productId: string;
    lotId: string;
    receiptId: string;
    quantity: number;
    unitCostMicros: Micros;
    availableOn: LocalDate;
    expiresOn: LocalDate | null;
    lotCode: string | null;
    reason: string | null;
    reasonCode?: string | null;
    type?: MovementType;
    referenceType?: string;
    referenceId?: string;
  }): Promise<{ seq: number; movementId: string; totalCostMicros: Micros; validThrough: LocalDate }> {
    const p = await this.product(input.productId);
    const validThrough = input.expiresOn ?? (p.mode === "planned" ? input.availableOn : NO_EXPIRY);
    return this.addLot(p, { ...input, validThrough, totalCostMicros: entryValue(input.quantity, input.unitCostMicros), type: input.type ?? "receipt" });
  }

  /**
   * Unidades encontradas na contagem/ajuste positivo. Valorizadas ao custo informado ou, se omitido, ao custo médio
   * atual; sem estoque e sem custo informado não há como valorizar (`cost_required`): nunca custo zero escondido.
   */
  async addFound(input: { productId: string; lotId: string; quantity: number; unitCostMicros: Micros | null; type: "count_adjustment" | "adjustment"; reason: string; referenceId: string }) {
    const p = await this.product(input.productId);
    let total: Micros;
    if (input.unitCostMicros !== null) total = entryValue(input.quantity, input.unitCostMicros);
    else if (p.balance.onHand > 0 && p.valueMicros > 0) total = mulDivRound(p.valueMicros, input.quantity, p.balance.onHand);
    else throw conflict("cost_required", "Sem estoque para calcular o custo médio: informe o custo unitário.");
    return this.addLot(p, {
      productId: input.productId,
      lotId: input.lotId,
      receiptId: null,
      quantity: input.quantity,
      totalCostMicros: total,
      unitCostMicros: averageUnitMicros(total, input.quantity),
      availableOn: this.today,
      expiresOn: null,
      validThrough: p.mode === "planned" ? this.today : NO_EXPIRY,
      lotCode: null,
      reason: input.reason,
      type: input.type,
      referenceType: input.type,
      referenceId: input.referenceId,
    });
  }

  private addLot(
    p: ProductState,
    a: {
      productId: string;
      lotId: string;
      receiptId: string | null;
      quantity: number;
      totalCostMicros: Micros;
      unitCostMicros: Micros;
      availableOn: LocalDate;
      expiresOn: LocalDate | null;
      validThrough: LocalDate;
      lotCode: string | null;
      reason: string | null;
      type: MovementType;
      reasonCode?: string | null;
      referenceType?: string;
      referenceId?: string;
    },
  ) {
    if (!Number.isSafeInteger(a.quantity) || a.quantity < 1) throw invalid("invalid_quantity", "Quantidade inválida.");
    if (p.balance.onHand + a.quantity > MAX_ON_HAND) throw conflict("stock_limit", "Estoque acima do limite do sistema.");
    if (!Number.isSafeInteger(p.valueMicros + a.totalCostMicros)) throw conflict("stock_limit", "Valor de estoque acima do limite do sistema.");
    if (!(a.validThrough in p.balance.supplyByValidity) && Object.keys(p.balance.supplyByValidity).length >= MAX_VALIDITY_KEYS) {
      throw conflict("too_many_expiry_dates", "Há validades distintas demais em estoque para este produto.");
    }
    const lot: Lot = { id: a.lotId, productId: a.productId, receiptId: a.receiptId, lotCode: a.lotCode, availableOn: a.availableOn, expiresOn: a.expiresOn, validThrough: a.validThrough, quantity: a.quantity, remaining: a.quantity };
    p.lots.set(a.lotId, { value: lot, isNew: true, dirty: true });
    bump(p.balance.supplyByValidity, a.validThrough, a.quantity, "entrada");
    p.balance.onHand += a.quantity;
    p.valueMicros += a.totalCostMicros;
    const movement = this.push(p, {
      type: a.type,
      quantity: a.quantity,
      totalCostMicros: a.totalCostMicros,
      unitCostMicros: a.unitCostMicros,
      allocations: [{ lotId: a.lotId, quantity: a.quantity }],
      reason: a.reason,
      reasonCode: a.reasonCode ?? null,
      referenceType: a.referenceType ?? "receipt",
      referenceId: a.referenceId ?? a.receiptId ?? a.lotId,
      consumptionDate: null,
      revenueCents: null,
    });
    return { seq: movement.seq, movementId: movementId(movement.seq), totalCostMicros: a.totalCostMicros, validThrough: a.validThrough };
  }

  /**
   * Estorno de entrada equivocada (trilha: movimento `receipt_reversal` com o valor EXATO da entrada). Só vale se o lote
   * está intacto e nenhuma saída pelo custo médio ocorreu desde a entrada — senão o custo das saídas já consumiu a média
   * e o tratamento correto é perda/ajuste auditado (`receipt_consumed`). Nunca deixa reservas físicas sem lastro.
   */
  async reverseReceipt(input: { productId: string; lotId: string; receiptSeq: number; quantity: number; totalCostMicros: Micros; reason: string; receiptId: string }) {
    const p = await this.product(input.productId);
    const lot = await this.lot(input.productId, input.lotId);
    if (!lot || lot.value.remaining !== lot.value.quantity || lot.value.quantity !== input.quantity || p.balance.lastExitSeq >= input.receiptSeq) {
      throw conflict("receipt_consumed", "Esta entrada já foi total ou parcialmente consumida. Use perda ou ajuste auditado em vez de estorno.");
    }
    if (p.valueMicros < input.totalCostMicros) throw conflict("receipt_consumed", "O valor em estoque é menor que o da entrada. Use ajuste auditado.");
    const onHandAfter = p.balance.onHand - input.quantity;
    const valueAfter = p.valueMicros - input.totalCostMicros;
    if (onHandAfter === 0 && valueAfter !== 0) throw conflict("receipt_consumed", "O valor residual não confere com a entrada. Use ajuste auditado.");
    const supplyAfter = { ...p.balance.supplyByValidity };
    bump(supplyAfter, lot.value.validThrough, -input.quantity, "estorno");
    if (p.mode === "physical" && deficitOf(supplyAfter, p.balance.reservedByDate) > 0) {
      throw conflict("reserved_units", "As unidades desta entrada estão reservadas por pedidos. Trate os pedidos antes do estorno.", { reservedUnits: reservedTotal(p.balance) });
    }
    lot.value.remaining = 0;
    lot.dirty = true;
    p.balance.supplyByValidity = supplyAfter;
    p.balance.onHand = onHandAfter;
    p.valueMicros = valueAfter;
    const movement = this.push(p, {
      type: "receipt_reversal",
      quantity: -input.quantity,
      totalCostMicros: -input.totalCostMicros,
      unitCostMicros: averageUnitMicros(input.totalCostMicros, input.quantity),
      allocations: [{ lotId: input.lotId, quantity: input.quantity }],
      reason: input.reason,
      reasonCode: null,
      referenceType: "receipt",
      referenceId: input.receiptId,
      consumptionDate: null,
      revenueCents: null,
    });
    return { seq: movement.seq, movementId: movementId(movement.seq) };
  }

  /**
   * Baixa por perda, contagem ou ajuste negativo, ao custo médio. Estoque físico nunca fica negativo. Sai primeiro o que
   * vence antes (inclusive vencido) ou o lote indicado. Se isso deixa pedidos com reserva sem lastro, NÃO falseia
   * venda/entrega: registra a perda e devolve `shortfallUnits` e os pedidos comprometidos para tratamento.
   */
  async removeUnits(input: { productId: string; quantity: number; type: "loss" | "count_adjustment" | "adjustment"; reason: string; reasonCode?: string; referenceType: string; referenceId: string; lotId?: string }): Promise<RemoveResult> {
    const { productId, quantity } = input;
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw invalid("invalid_quantity", "Quantidade inválida.");
    const p = await this.product(productId);
    if (quantity > p.balance.onHand) throw conflict("insufficient_stock", "O estoque físico não pode ficar negativo.", { productId, onHand: p.balance.onHand, requested: quantity });
    let allocations: { lotId: string; quantity: number }[];
    if (input.lotId) {
      const lot = await this.lot(productId, input.lotId);
      if (!lot || lot.value.remaining < quantity) throw conflict("lot_insufficient", "O lote não tem esta quantidade.", { lotId: input.lotId, remaining: lot?.value.remaining ?? 0 });
      allocations = [{ lotId: input.lotId, quantity }];
    } else {
      await this.loadLots(p, null, () => allocateFefo(this.lotValues(p), quantity, () => true).unmet === 0);
      const plan = allocateFefo(this.lotValues(p), quantity, () => true);
      if (plan.unmet > 0) throw conflict("insufficient_stock", "Estoque insuficiente nos lotes.", { productId, requested: quantity });
      allocations = plan.allocations;
    }
    const total = exitCost(p.valueMicros, p.balance.onHand, quantity);
    this.takeFromLots(p, allocations);
    p.balance.onHand -= quantity;
    p.valueMicros -= total;
    const movement = this.push(p, {
      type: input.type,
      quantity: -quantity,
      totalCostMicros: -total,
      unitCostMicros: averageUnitMicros(total, quantity),
      allocations,
      reason: input.reason,
      reasonCode: input.reasonCode ?? null,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      consumptionDate: null,
      revenueCents: null,
    });
    p.balance.lastExitSeq = movement.seq;
    const shortfallUnits = p.mode === "physical" ? deficitOf(p.balance.supplyByValidity, p.balance.reservedByDate) : 0;
    const affectedReservations = shortfallUnits > 0 ? await this.affectedReservations(p, shortfallUnits) : [];
    return { productId, movementId: movementId(movement.seq), seq: movement.seq, quantity, totalCostMicros: total, allocations, shortfallUnits, affectedReservations };
  }

  /** Reservas ativas mais distantes primeiro (as de maior data cobrem o déficit antes), até somar o déficit; tratadas pela administração. */
  private async affectedReservations(p: ProductState, shortfall: number): Promise<AffectedReservation[]> {
    const snap = await this.tx.get(this.refs(p.productId).reservations.where("status", "==", "active").limit(500));
    const active = snap.docs.map((d) => parseReservation(d.id, d.data())).filter((r) => remainingOf(r) > 0).sort((a, b) => b.consumptionDate.localeCompare(a.consumptionDate) || a.id.localeCompare(b.id));
    const out: AffectedReservation[] = [];
    let covered = 0;
    for (const r of active) {
      if (covered >= shortfall) break;
      out.push({ reservationId: r.id, orderRef: r.orderRef, consumptionDate: r.consumptionDate, shiftId: r.shiftId, remaining: remainingOf(r) });
      covered += remainingOf(r);
    }
    return out;
  }

  /** Sobras explícitas: amplia a validade de um lote (ex.: sobra de planejado vira disponibilidade de balcão no dia seguinte). */
  async extendLot(input: { productId: string; lotId: string; validThrough: LocalDate }): Promise<{ before: LocalDate; after: LocalDate; remaining: number }> {
    const p = await this.product(input.productId);
    const lot = await this.lot(input.productId, input.lotId);
    if (!lot || lot.value.remaining === 0) throw notFound("lot_not_found", "Lote não encontrado ou já esgotado.");
    const before = lot.value.validThrough;
    if (input.validThrough <= before) throw invalid("invalid_validity", "A nova validade precisa ser posterior à atual.");
    if (!(input.validThrough in p.balance.supplyByValidity) && Object.keys(p.balance.supplyByValidity).length >= MAX_VALIDITY_KEYS) throw conflict("too_many_expiry_dates", "Há validades distintas demais.");
    bump(p.balance.supplyByValidity, before, -lot.value.remaining, "validade");
    bump(p.balance.supplyByValidity, input.validThrough, lot.value.remaining, "validade");
    lot.value.validThrough = input.validThrough;
    lot.value.expiresOn = input.validThrough;
    lot.dirty = true;
    p.balanceDirty = true;
    return { before, after: input.validThrough, remaining: lot.value.remaining };
  }

  async setMinStock(productId: string, minStock: number | null): Promise<{ before: number | null; after: number | null }> {
    const p = await this.product(productId);
    const before = p.balance.minStock;
    p.balance.minStock = minStock;
    p.balanceDirty = true;
    return { before, after: minStock };
  }

  /** Define a cota planejada (ou o teto) de uma data/turno. Reduzir abaixo do comprometido NÃO cancela pedidos: só bloqueia novos. */
  async setCapacity(input: { productId: string; date: LocalDate; shiftId: string; capacity: number; expectedVersion?: number }): Promise<{ before: Capacity; after: Capacity }> {
    await this.product(input.productId);
    const cap = await this.capacity(input.productId, input.date, input.shiftId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== cap.value.version) throw conflict("stale_capacity", "A cota foi alterada por outra pessoa. Recarregue.");
    const before = { ...cap.value };
    cap.value.capacity = input.capacity;
    cap.dirty = true;
    return { before, after: { ...cap.value, version: cap.value.version + 1 } };
  }

  /* ----------------------------------------------------------------------------------------------- interno */

  private takeFromLots(p: ProductState, allocations: readonly { lotId: string; quantity: number }[]): void {
    for (const a of allocations) {
      const lot = p.lots.get(a.lotId);
      if (!lot || lot.value.remaining < a.quantity) throw new Error("Invariante de estoque violada (lote).");
      lot.value.remaining -= a.quantity;
      lot.dirty = true;
      bump(p.balance.supplyByValidity, lot.value.validThrough, -a.quantity, "lote");
    }
  }

  private push(p: ProductState, draft: MovementDraft): Movement {
    if (p.balance.onHand < 0 || p.valueMicros < 0) throw new Error("Invariante de estoque violada (saldo negativo).");
    if (p.balance.onHand === 0 && p.valueMicros !== 0) throw new Error("Invariante de estoque violada (valor residual sem unidades).");
    p.balance.movementSeq += 1;
    const movement: Movement = { ...draft, seq: p.balance.movementSeq, onHandAfter: p.balance.onHand, valueAfterMicros: p.valueMicros };
    p.movements.push(movement);
    p.balanceDirty = true;
    return movement;
  }

  /** Resumo do que mudou por produto (para auditoria do comando). */
  snapshot(productId: string): { onHand: number; valueMicros: Micros; reservedUnits: number; movementSeq: number } {
    const p = this.products.get(productId);
    if (!p) throw new Error("Produto não carregado na sessão.");
    return { onHand: p.balance.onHand, valueMicros: p.valueMicros, reservedUnits: reservedTotal(p.balance), movementSeq: p.balance.movementSeq };
  }

  /* ------------------------------------------------------------------------------------------------ commit */

  /** Grava uma vez cada documento tocado. Chamar depois de TODAS as leituras/planejamentos e na mesma transação. */
  commit(): void {
    this.guard();
    this.committed = true;
    const now = FieldValue.serverTimestamp();
    for (const p of this.products.values()) {
      const r = this.refs(p.productId);
      const hasMovements = p.movements.length > 0;
      for (const m of p.movements) {
        this.tx.create(this.db.doc(`stockCosts/${p.productId}/movements/${movementId(m.seq)}`), {
          productId: p.productId,
          seq: m.seq,
          type: m.type,
          quantity: m.quantity,
          unitCostMicros: m.unitCostMicros,
          totalCostMicros: m.totalCostMicros,
          onHandAfter: m.onHandAfter,
          valueAfterMicros: m.valueAfterMicros,
          allocations: m.allocations,
          reason: m.reason,
          reasonCode: m.reasonCode,
          referenceType: m.referenceType,
          referenceId: m.referenceId,
          consumptionDate: m.consumptionDate,
          revenueCents: m.revenueCents,
          actorUid: this.actor.uid,
          actorRole: this.actor.role,
          createdAt: now,
        });
      }
      if (hasMovements) {
        this.tx.set(r.cost, { productId: p.productId, valueMicros: p.valueMicros, movementSeq: p.balance.movementSeq, createdAt: p.costCreatedAt ?? now, updatedAt: now });
      }
      for (const t of p.lots.values()) if (t.dirty) this.writeLot(r.lots.doc(t.value.id), t, now);
      for (const t of p.reservations.values()) if (t.dirty) this.writeReservation(r.reservations.doc(t.value.id), t, now);
      if (p.balanceDirty) {
        const b = p.balance;
        this.tx.set(r.balance, {
          productId: p.productId,
          mode: p.mode,
          onHand: b.onHand,
          reservedTotal: reservedTotal(b),
          reservedByDate: b.reservedByDate,
          supplyByValidity: b.supplyByValidity,
          minStock: b.minStock,
          movementSeq: b.movementSeq,
          lastExitSeq: b.lastExitSeq,
          version: b.version + 1,
          createdAt: p.balanceCreatedAt ?? now,
          updatedAt: now,
        });
      }
    }
    for (const t of this.capacities.values()) {
      if (!t.dirty) continue;
      const c = t.value;
      this.tx.set(this.db.doc(`dailyCapacity/${capacityId(c.productId, c.date, c.shiftId)}`), {
        productId: c.productId,
        date: c.date,
        shiftId: c.shiftId,
        capacity: c.capacity,
        reserved: c.reserved,
        delivered: c.delivered,
        version: c.version + 1,
        updatedAt: now,
      });
    }
  }

  private writeLot(ref: DocumentReference, t: Tracked<Lot>, now: FieldValue): void {
    const lot = t.value;
    const openKey = lot.remaining > 0 ? openKeyOf(lot) : FieldValue.delete();
    if (t.isNew) {
      this.tx.create(ref, {
        productId: lot.productId,
        receiptId: lot.receiptId,
        lotCode: lot.lotCode,
        availableOn: lot.availableOn,
        expiresOn: lot.expiresOn,
        validThrough: lot.validThrough,
        quantity: lot.quantity,
        remaining: lot.remaining,
        ...(lot.remaining > 0 ? { openKey: openKeyOf(lot) } : {}),
        createdAt: now,
        updatedAt: now,
      });
    } else {
      this.tx.update(ref, { remaining: lot.remaining, validThrough: lot.validThrough, expiresOn: lot.expiresOn, openKey, updatedAt: now });
    }
  }

  private writeReservation(ref: DocumentReference, t: Tracked<Reservation>, now: FieldValue): void {
    const r = t.value;
    const status = statusOf(r);
    if (t.isNew) {
      this.tx.create(ref, { productId: r.productId, orderRef: r.orderRef, consumptionDate: r.consumptionDate, shiftId: r.shiftId, quantity: r.quantity, deliveredQty: r.deliveredQty, releasedQty: r.releasedQty, status, createdAt: now, updatedAt: now });
    } else {
      this.tx.update(ref, { deliveredQty: r.deliveredQty, releasedQty: r.releasedQty, status, updatedAt: now });
    }
  }
}

/** Abre a sessão de estoque dentro da transação do comando (veja o contrato no cabeçalho de `StockSession`). */
export function openStockSession(db: Firestore, tx: Transaction, input: { today: LocalDate; actor: SessionActor }): StockSession {
  return new StockSession(db, tx, input.today, input.actor);
}
