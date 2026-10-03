import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { addDays, localDateOf, type LocalDate } from "@/lib/dates/school-time";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { averageUnitMicros, parseUnitCost, type Micros } from "./cost";
import { adjustmentCommandSchema, capacityCommandSchema, lossCommandSchema, receiptCommandSchema, type AdjustmentCommand } from "./model";
import { openStockSession, type AffectedReservation } from "./session";

/**
 * Comandos administrativos de estoque (F10). Todos: servidor autenticado, perfil reautorizado na transação,
 * idempotentes por chave+payload, uma `StockSession` por transação (leituras → planejamento → `commit`), auditoria
 * na mesma transação. Custos só aparecem na resposta para quem tem `costs.read`; a cantina registra perdas sem ver valor.
 */
type Profile = { role: Actor["role"]; permissions: readonly string[] };
const allowManage = (p: Profile) => can(p, "inventory.manage");
const allowLoss = (p: Profile) => can(p, "inventory.loss");

export const MAX_PLANNED_ENTRY_DAYS = 30; // entrada de planejado pode ser registrada com até 30 dias de antecedência
export const MAX_RECEIVED_PAST_DAYS = 90;
export const MAX_EXTEND_DAYS = 30;
export const MAX_CAPACITY_DAYS = 400;

const sessionActor = (actor: Actor) => ({ uid: actor.uid, role: actor.role ?? null });

export type StockStateView = { onHand: number; reservedUnits: number; movementSeq: number; valueMicros?: Micros; averageUnitMicros?: Micros };

/** Estado após o comando; valor e custo médio só para quem enxerga custos. */
function stateView(session: ReturnType<typeof openStockSession>, productId: string, withCosts: boolean): StockStateView {
  const s = session.snapshot(productId);
  const base = { onHand: s.onHand, reservedUnits: s.reservedUnits, movementSeq: s.movementSeq };
  return withCosts ? { ...base, valueMicros: s.valueMicros, averageUnitMicros: averageUnitMicros(s.valueMicros, s.onHand) } : base;
}

/* ------------------------------------------------------------------------------------------------ entradas */

export type ReceiptResult =
  | { action: "create"; receiptId: string; lotId: string; movementId: string; seq: number; totalCostMicros: Micros; validThrough: LocalDate; state: StockStateView }
  | { action: "reverse"; receiptId: string; movementId: string; seq: number; state: StockStateView };

/**
 * Entrada de produto acabado (compra, produção ou estoque inicial) ou estorno. Toda compra é uma entrada separada
 * (100 a R$ 1,00 e 100 a R$ 1,10 NÃO editam o custo: viram duas entradas e o custo médio é calculado sobre o que está
 * em estoque). Estorno só enquanto a entrada não foi consumida; depois disso, perda/ajuste auditado.
 */
export async function changeReceipt(db: Firestore, actor: Actor, raw: unknown): Promise<ReceiptResult & { replayed: boolean }> {
  authorize(actor, "inventory.manage");
  const input = receiptCommandSchema.parse(raw);
  const today = localDateOf(new Date());
  const unitCostMicros = input.action === "create" ? parseUnitCost(input.unitCost) : 0;
  const receiptId = input.action === "create" ? deterministicId("rcp", actor.uid, input.key) : input.receiptId;

  return runIdempotentCommand(db, actor, { scope: `inventory.receipt.${input.action}`, key: input.key, payload: input, allow: allowManage }, async ({ tx, actor: current, auditId }) => {
    const session = openStockSession(db, tx, { today, actor: sessionActor(current) });
    const receiptRef = db.doc(`stockReceipts/${receiptId}`);
    const withCosts = can(current, "costs.read");

    if (input.action === "create") {
      const product = await session.product(input.productId);
      const availableOn = input.availableOn ?? (product.mode === "physical" ? today : undefined);
      if (!availableOn) throw invalid("available_on_required", "Informe a data de disponibilidade do produto planejado.");
      if (product.mode === "planned") {
        if (availableOn < today || availableOn > addDays(today, MAX_PLANNED_ENTRY_DAYS)) throw invalid("date_out_of_window", `A data de disponibilidade deve ser de hoje até ${MAX_PLANNED_ENTRY_DAYS} dias.`);
      } else if (availableOn > today || availableOn < addDays(today, -MAX_RECEIVED_PAST_DAYS)) {
        throw invalid("date_out_of_window", "A data de recebimento não pode ser futura nem muito antiga.");
      }
      if (input.expiresOn !== undefined && input.expiresOn < (availableOn > today ? availableOn : today)) throw invalid("invalid_expiry", "A validade não pode ser anterior à data de disponibilidade nem a hoje.");
      const existing = await tx.get(receiptRef);
      if (existing.exists) throw conflict("already_exists", "Entrada já registrada.");

      const result = await session.receive({
        productId: input.productId,
        lotId: receiptId,
        receiptId,
        quantity: input.quantity,
        unitCostMicros,
        availableOn,
        expiresOn: input.expiresOn ?? null,
        lotCode: input.lotCode || null,
        reason: input.note || null,
        reasonCode: input.kind,
        referenceType: "receipt",
        referenceId: receiptId,
      });
      tx.create(receiptRef, {
        receiptId,
        productId: input.productId,
        kind: input.kind,
        quantity: input.quantity,
        unitCostMicros,
        totalCostMicros: result.totalCostMicros,
        availableOn,
        expiresOn: input.expiresOn ?? null,
        validThrough: result.validThrough,
        lotId: receiptId,
        lotCode: input.lotCode || null,
        supplier: input.supplier || null,
        documentRef: input.documentRef || null,
        note: input.note || null,
        movementSeq: result.seq,
        status: "active",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });
      auditInTransaction(db, tx, auditId, {
        action: "stock.receipt.create",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        target: { type: "stockReceipt", id: receiptId },
        reason: input.note || undefined,
        after: { productId: input.productId, kind: input.kind, quantity: input.quantity, unitCostMicros, totalCostMicros: result.totalCostMicros, availableOn, validThrough: result.validThrough, lotCode: input.lotCode || null },
      });
      session.commit();
      return { action: "create" as const, receiptId, lotId: receiptId, movementId: result.movementId, seq: result.seq, totalCostMicros: withCosts ? result.totalCostMicros : 0, validThrough: result.validThrough, state: stateView(session, input.productId, withCosts) };
    }

    const receipt = await tx.get(receiptRef);
    if (!receipt.exists) throw notFound("receipt_not_found", "Entrada não encontrada.");
    if (receipt.get("status") !== "active") throw conflict("receipt_reversed", "Esta entrada já foi estornada.");
    const productId = String(receipt.get("productId"));
    const result = await session.reverseReceipt({
      productId,
      lotId: String(receipt.get("lotId")),
      receiptSeq: Number(receipt.get("movementSeq")),
      quantity: Number(receipt.get("quantity")),
      totalCostMicros: Number(receipt.get("totalCostMicros")),
      reason: input.reason,
      receiptId,
    });
    tx.update(receiptRef, { status: "reversed", reversedBy: current.uid, reversedAt: FieldValue.serverTimestamp(), reversalReason: input.reason, reversalSeq: result.seq });
    auditInTransaction(db, tx, auditId, {
      action: "stock.receipt.reverse",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "stockReceipt", id: receiptId },
      reason: input.reason,
      before: { status: "active", quantity: Number(receipt.get("quantity")), totalCostMicros: Number(receipt.get("totalCostMicros")) },
      after: { status: "reversed", reversalSeq: result.seq },
    });
    session.commit();
    return { action: "reverse" as const, receiptId, movementId: result.movementId, seq: result.seq, state: stateView(session, productId, withCosts) };
  });
}

/* --------------------------------------------------------------------------------------------------- perdas */

export type LossResult = {
  movementId: string;
  seq: number;
  quantity: number;
  state: StockStateView;
  /** Unidades reservadas que ficaram sem lastro após a perda (0 = nenhuma): os pedidos listados precisam de tratamento. */
  shortfallUnits: number;
  affectedReservations: AffectedReservation[];
  /** Custo da perda: só para quem tem `costs.read`. */
  totalCostMicros?: Micros;
};

/** Perda (vencimento, quebra, descarte, consumo interno) com motivo obrigatório. Cantina e administração; cantina não vê custo. */
export async function registerLoss(db: Firestore, actor: Actor, raw: unknown): Promise<LossResult & { replayed: boolean }> {
  authorize(actor, "inventory.loss");
  const input = lossCommandSchema.parse(raw);
  const today = localDateOf(new Date());
  return runIdempotentCommand(db, actor, { scope: "inventory.loss", key: input.key, payload: input, allow: allowLoss }, async ({ tx, actor: current, auditId }) => {
    const session = openStockSession(db, tx, { today, actor: sessionActor(current) });
    const withCosts = can(current, "costs.read");
    const before = (await session.product(input.productId)).balance.onHand;
    const result = await session.removeUnits({
      productId: input.productId,
      quantity: input.quantity,
      type: "loss",
      reason: input.note,
      reasonCode: input.reason,
      referenceType: "loss",
      referenceId: auditId,
      lotId: input.lotId,
    });
    auditInTransaction(db, tx, auditId, {
      action: "stock.loss",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "stockProduct", id: input.productId },
      reason: `${input.reason}: ${input.note}`,
      before: { onHand: before },
      after: { onHand: before - input.quantity, quantity: input.quantity, totalCostMicros: result.totalCostMicros, lotId: input.lotId ?? null, shortfallUnits: result.shortfallUnits, affectedOrders: result.affectedReservations.map((r) => r.orderRef) },
    });
    session.commit();
    const view: LossResult = { movementId: result.movementId, seq: result.seq, quantity: input.quantity, state: stateView(session, input.productId, withCosts), shortfallUnits: result.shortfallUnits, affectedReservations: result.affectedReservations };
    if (withCosts) view.totalCostMicros = result.totalCostMicros;
    return view;
  });
}

/* --------------------------------------------------------------------------------------------- inventário */

export type AdjustmentResult = {
  action: AdjustmentCommand["action"];
  changed: boolean;
  movementId: string | null;
  seq: number | null;
  /** Diferença aplicada (contagem − sistema, ou o ajuste informado). */
  delta: number;
  state: StockStateView;
  shortfallUnits: number;
  affectedReservations: AffectedReservation[];
  totalCostMicros?: Micros;
};

/**
 * Inventário e ajustes (administração): contagem física (compara com o sistema; `expectedSeq` detecta movimento
 * ocorrido depois que a contagem começou), ajuste de divergência, ampliação explícita de validade de sobra e estoque
 * mínimo. Nunca edita movimento antigo: a correção é um movimento novo, com motivo, autor e referência.
 */
export async function changeAdjustment(db: Firestore, actor: Actor, raw: unknown): Promise<AdjustmentResult & { replayed: boolean }> {
  authorize(actor, "inventory.manage");
  const input = adjustmentCommandSchema.parse(raw);
  const today = localDateOf(new Date());
  const unitCost = "unitCost" in input && input.unitCost ? parseUnitCost(input.unitCost) : null;

  return runIdempotentCommand(db, actor, { scope: `inventory.adjust.${input.action}`, key: input.key, payload: input, allow: allowManage }, async ({ tx, actor: current, auditId }) => {
    const session = openStockSession(db, tx, { today, actor: sessionActor(current) });
    const withCosts = can(current, "costs.read");
    const product = await session.product(input.productId);
    const onHandBefore = product.balance.onHand;
    const audit = (action: string, reason: string | undefined, before: Record<string, unknown>, after: Record<string, unknown>) =>
      auditInTransaction(db, tx, auditId, { action, actorUid: current.uid, actorRole: current.role ?? null, target: { type: "stockProduct", id: input.productId }, reason, before, after });
    const out = (partial: Partial<AdjustmentResult>): AdjustmentResult => ({
      action: input.action,
      changed: true,
      movementId: null,
      seq: null,
      delta: 0,
      state: stateView(session, input.productId, withCosts),
      shortfallUnits: 0,
      affectedReservations: [],
      ...partial,
    });

    if (input.action === "threshold") {
      const change = await session.setMinStock(input.productId, input.minStock);
      audit("stock.threshold", undefined, { minStock: change.before }, { minStock: change.after });
      session.commit();
      return out({ changed: change.before !== change.after });
    }

    if (input.action === "extend") {
      if (input.validThrough > addDays(today, MAX_EXTEND_DAYS)) throw invalid("date_out_of_window", `A validade pode ser ampliada em até ${MAX_EXTEND_DAYS} dias.`);
      const lot = await session.lot(input.productId, input.lotId);
      if (!lot) throw notFound("lot_not_found", "Lote não encontrado.");
      const change = await session.extendLot({ productId: input.productId, lotId: input.lotId, validThrough: input.validThrough });
      audit("stock.lot.extend", input.reason, { lotId: input.lotId, validThrough: change.before, remaining: change.remaining }, { lotId: input.lotId, validThrough: change.after });
      session.commit();
      return out({});
    }

    const delta = input.action === "count" ? input.countedQuantity - onHandBefore : input.delta;
    if (input.action === "count" && input.expectedSeq !== product.balance.movementSeq) {
      throw conflict("stale_count", "O estoque mudou depois do início da contagem. Refaça a contagem.", { expectedSeq: input.expectedSeq, currentSeq: product.balance.movementSeq, onHand: onHandBefore });
    }
    const type = input.action === "count" ? ("count_adjustment" as const) : ("adjustment" as const);
    if (delta === 0) {
      audit("stock.count", input.reason, { onHand: onHandBefore }, { onHand: onHandBefore, countedQuantity: onHandBefore, delta: 0 });
      session.commit();
      return out({ changed: false });
    }
    if (delta > 0) {
      const lotId = deterministicId("adj", current.uid, input.key);
      const found = await session.addFound({ productId: input.productId, lotId, quantity: delta, unitCostMicros: unitCost, type, reason: input.reason, referenceId: auditId });
      audit(input.action === "count" ? "stock.count" : "stock.adjust", input.reason, { onHand: onHandBefore }, { onHand: onHandBefore + delta, delta, totalCostMicros: found.totalCostMicros, lotId });
      session.commit();
      return out({ movementId: found.movementId, seq: found.seq, delta, ...(withCosts ? { totalCostMicros: found.totalCostMicros } : {}) });
    }
    const removed = await session.removeUnits({ productId: input.productId, quantity: -delta, type, reason: input.reason, referenceType: type, referenceId: auditId });
    audit(input.action === "count" ? "stock.count" : "stock.adjust", input.reason, { onHand: onHandBefore }, { onHand: onHandBefore + delta, delta, totalCostMicros: removed.totalCostMicros, shortfallUnits: removed.shortfallUnits, affectedOrders: removed.affectedReservations.map((r) => r.orderRef) });
    session.commit();
    return out({ movementId: removed.movementId, seq: removed.seq, delta, shortfallUnits: removed.shortfallUnits, affectedReservations: removed.affectedReservations, ...(withCosts ? { totalCostMicros: removed.totalCostMicros } : {}) });
  });
}

/* ------------------------------------------------------------------------------------------------- cotas */

export type CapacityResult = { productId: string; date: LocalDate; shiftId: string; capacity: number; reserved: number; delivered: number; version: number; changed: boolean };

/**
 * Cota (disponibilidade planejada) por produto/data/turno. Reduzir abaixo do que já está comprometido NÃO cancela nem
 * reembolsa pedidos: só impede novas reservas (o excesso aparece nos números devolvidos).
 */
export async function setDailyCapacity(db: Firestore, actor: Actor, raw: unknown): Promise<CapacityResult & { replayed: boolean }> {
  authorize(actor, "inventory.manage");
  const input = capacityCommandSchema.parse(raw);
  const today = localDateOf(new Date());
  if (input.date < today || input.date > addDays(today, MAX_CAPACITY_DAYS)) throw invalid("date_out_of_window", `Escolha uma data de hoje até ${MAX_CAPACITY_DAYS} dias.`);

  return runIdempotentCommand(db, actor, { scope: "inventory.capacity", key: input.key, payload: input, allow: allowManage }, async ({ tx, actor: current, auditId }) => {
    const session = openStockSession(db, tx, { today, actor: sessionActor(current) });
    const shift = await tx.get(db.doc(`shifts/${input.shiftId}`));
    if (!shift.exists || shift.get("status") !== "active") throw invalid("shift_unavailable", "Turno inexistente ou arquivado.");
    const { before, after } = await session.setCapacity({ productId: input.productId, date: input.date, shiftId: input.shiftId, capacity: input.capacity, expectedVersion: input.expectedVersion });
    const changed = before.capacity !== after.capacity;
    auditInTransaction(db, tx, auditId, {
      action: "stock.capacity.set",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "dailyCapacity", id: `${input.productId}_${input.date}_${input.shiftId}` },
      before: { capacity: before.capacity, reserved: before.reserved, delivered: before.delivered },
      after: { capacity: after.capacity, appliesTo: "new_reservations_only" },
    });
    session.commit();
    return { productId: input.productId, date: input.date, shiftId: input.shiftId, capacity: input.capacity, reserved: after.reserved, delivered: after.delivered, version: after.version, changed };
  });
}
