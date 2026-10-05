import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { localDateOf } from "@/lib/dates/school-time";
import { conflict } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { openStockSession } from "@/modules/inventory/session";
import { statusInfo } from "./history-model";
import {
  REFUNDED_CLASSIFICATION,
  RETAINED_CLASSIFICATION,
  aggregateStatus,
  canPrepare,
  deliverSchema,
  deliveredOf,
  isNotPickedUp,
  isOpenStatus,
  notPickedUpSchema,
  prepareSchema,
  remainingOf,
  resolveSchema,
  type ResolveInput,
  totalsOf,
  deliveryRevenueOf,
  remainingValueOf,
} from "./fulfillment-model";
import { planReschedule } from "./amend";
import { planCancellation } from "./cancellation";
import { itemsView, otherOrdersCovering, readOrder, sessionActor, type OrderState } from "./order-state";

/**
 * Comandos de operação do pedido (F13, docs/domains/fulfillment.md §12): preparo, entrega (direta ou parcial),
 * não retirada e sua resolução. Todos: servidor autenticado, perfil ATUAL relido na transação (`runIdempotentCommand`),
 * idempotentes por chave+payload, pedido relido e revalidado DENTRO da transação (leituras antes das escritas) e
 * auditoria na mesma transação. O pedido já foi pago na F11: NENHUM comando daqui toca a carteira ou o livro.
 *
 * Estoque: sempre pela `StockSession` da F10 na mesma transação do pedido; a reserva usada é a do PRÓPRIO pedido
 * (`orderRef` conferido), então uma entrega nunca consome o que está reservado para outro pedido.
 */
const allowOperate = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "orders.operate");
const allowResolve = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "orders.resolve");

/* -------------------------------------------------------------------------------------------------- preparo */

export type PrepareResult = { orderId: string; status: string; statusLabel: string; version: number };

/** Em preparação / pronto. Só avança, só no dia do consumo e só enquanto nada foi entregue. */
export async function setPreparation(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<PrepareResult & { replayed: boolean }> {
  authorize(actor, "orders.operate");
  const input = prepareSchema.parse(raw);
  return runIdempotentCommand(db, actor, { scope: "orders.prepare", key: input.key, payload: input, allow: allowOperate }, async ({ tx, actor: current, auditId }) => {
    const today = localDateOf(clock());
    const order = await readOrder(tx, db, input.orderId);
    if (order.consumptionDate !== today) throw conflict("not_consumption_date", "O preparo só é registrado no dia do consumo.", { consumptionDate: order.consumptionDate, today });
    if (!canPrepare(order.status, input.to)) throw conflict("invalid_transition", "Esta mudança de situação não é possível para o pedido.", { status: order.status, to: input.to });
    const status = aggregateStatus({ items: order.items, prep: input.to, nonPickup: null });
    const stamp = FieldValue.serverTimestamp();
    tx.update(order.ref, { prep: input.to, status, version: order.version + 1, updatedAt: stamp, ...(input.to === "preparing" ? { preparingAt: stamp } : { readyAt: stamp }) });
    auditInTransaction(db, tx, auditId, {
      action: "orders.prepare",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "order", id: input.orderId },
      before: { status: order.status },
      after: { status },
    });
    return { orderId: input.orderId, status, statusLabel: statusInfo(status).label, version: order.version + 1 };
  });
}

/* -------------------------------------------------------------------------------------------------- entrega */

export type DeliverResult = {
  orderId: string;
  deliveryId: string;
  status: string;
  statusLabel: string;
  version: number;
  delivered: { lineNo: number; quantity: number }[];
  items: { lineNo: number; quantity: number; deliveredQty: number; remainingQty: number }[];
  remainingUnits: number;
};

/**
 * Entrega direta ou parcial (por quantidade de item). Numa só transação: ator atual, pedido relido (aluno confere,
 * situação entregável, dia do consumo), quantidade ≤ restante de CADA linha, baixa de estoque/custo histórico pela
 * reserva do próprio pedido (`StockSession.exit`), progresso gravado no pedido, evento imutável em
 * `orders/{id}/deliveries/{id}` e auditoria. Qualquer recusa (inclusive produto planejado sem entrada física, na 2ª linha)
 * desfaz TUDO. Mesma chave + mesmo payload devolve a resposta original; outra chave sobre o mesmo restante recusa
 * (`quantity_exceeds_remaining`/`already_delivered`) — clique duplo e entregas concorrentes não baixam duas vezes.
 */
export async function deliverOrder(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<DeliverResult & { replayed: boolean }> {
  authorize(actor, "orders.operate");
  const input = deliverSchema.parse(raw);
  const deliveryId = deterministicId("dlv", actor.uid, input.key);
  return runIdempotentCommand(db, actor, { scope: "orders.deliver", key: input.key, payload: input, allow: allowOperate }, async ({ tx, actor: current, auditId }) => {
    const today = localDateOf(clock());
    const order = await readOrder(tx, db, input.orderId);
    if (order.data.studentId !== input.studentId) throw conflict("student_mismatch", "O pedido não pertence ao aluno informado.");
    if (order.status === "delivered") throw conflict("already_delivered", "O pedido já foi entregue por completo.");
    if (isNotPickedUp(order.status)) throw conflict("order_not_picked_up", "O pedido foi marcado como não retirado: aguarda resolução da administração.", { status: order.status });
    if (!isOpenStatus(order.status)) throw conflict("order_not_deliverable", "O pedido não está disponível para entrega.", { status: order.status });
    if (order.consumptionDate !== today) throw conflict("not_consumption_date", "A entrega só é registrada no dia do consumo.", { consumptionDate: order.consumptionDate, today });

    const byLine = new Map(order.items.map((i) => [i.lineNo, i]));
    const stock = openStockSession(db, tx, { today, actor: sessionActor(current) });
    const movements: { lineNo: number; productId: string; name: string; quantity: number; movementId: string; movementSeq: number }[] = [];
    for (const line of input.lines) {
      const item = byLine.get(line.lineNo);
      if (!item) throw conflict("line_not_found", "Item não encontrado no pedido.", { lineNo: line.lineNo });
      const remaining = remainingOf(item);
      if (remaining === 0) throw conflict("already_delivered", "Este item já foi entregue por completo.", { lineNo: line.lineNo });
      if (line.quantity > remaining) throw conflict("quantity_exceeds_remaining", "A quantidade supera o que falta entregar.", { lineNo: line.lineNo, remaining, requested: line.quantity });
      const exit = await stock.exit({
        productId: item.productId,
        quantity: line.quantity,
        consumptionDate: order.consumptionDate,
        reservationId: item.reservationId,
        orderRef: input.orderId,
        referenceType: "order",
        referenceId: input.orderId,
        revenueCents: deliveryRevenueOf(item, line.quantity),
      });
      movements.push({ lineNo: item.lineNo, productId: item.productId, name: item.name, quantity: line.quantity, movementId: exit.movementId, movementSeq: exit.seq });
    }

    const delivering = new Map(input.lines.map((l) => [l.lineNo, l.quantity]));
    const items = order.items.map((i) => (delivering.has(i.lineNo) ? { ...i, deliveredQty: deliveredOf(i) + delivering.get(i.lineNo)! } : i));
    const totals = totalsOf(items);
    const status = aggregateStatus({ items, prep: order.prep, nonPickup: null });
    const deliveryCount = Number(order.data.deliveryCount ?? 0) + 1;
    const stamp = FieldValue.serverTimestamp();
    tx.update(order.ref, {
      items,
      deliveredQty: totals.delivered,
      status,
      deliveryCount,
      lastDeliveryId: deliveryId,
      version: order.version + 1,
      updatedAt: stamp,
      ...(status === "delivered" ? { deliveredAt: stamp } : {}),
    });
    tx.create(db.doc(`orders/${input.orderId}/deliveries/${deliveryId}`), {
      deliveryId,
      orderId: input.orderId,
      studentId: input.studentId,
      seq: deliveryCount,
      lines: movements,
      totalUnits: movements.reduce((n, m) => n + m.quantity, 0),
      actorUid: current.uid,
      actorRole: current.role ?? null,
      createdAt: stamp,
    });
    auditInTransaction(db, tx, auditId, {
      action: "orders.deliver",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "order", id: input.orderId },
      before: { status: order.status, deliveredQty: Number(order.data.deliveredQty ?? 0) },
      after: { status, deliveredQty: totals.delivered, deliveryId, lines: movements.map((m) => ({ lineNo: m.lineNo, quantity: m.quantity, movementId: m.movementId })) },
    });
    stock.commit();
    return {
      orderId: input.orderId,
      deliveryId,
      status,
      statusLabel: statusInfo(status).label,
      version: order.version + 1,
      delivered: input.lines.map((l) => ({ lineNo: l.lineNo, quantity: l.quantity })),
      items: itemsView(items),
      remainingUnits: totals.remaining,
    };
  });
}

/* ---------------------------------------------------------------------------------------------- não retirada */

export type NotPickedUpResult = { orderId: string; status: string; statusLabel: string; version: number; remainingUnits: number; remainingCents: number };

/**
 * Marca "não retirado": só registra a situação, com motivo. NÃO reembolsa, NÃO gera perda e NÃO libera a reserva — as
 * unidades ficam comprometidas e o pedido fica VISÍVEL para a administração resolver. Só vale com algo ainda por entregar
 * e a partir do dia do consumo. Depois de marcado, a entrega fica bloqueada até a resolução.
 */
export async function markNotPickedUp(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<NotPickedUpResult & { replayed: boolean }> {
  authorize(actor, "orders.operate");
  const input = notPickedUpSchema.parse(raw);
  return runIdempotentCommand(db, actor, { scope: "orders.not_picked_up", key: input.key, payload: input, allow: allowOperate }, async ({ tx, actor: current, auditId }) => {
    const today = localDateOf(clock());
    const order = await readOrder(tx, db, input.orderId);
    if (!isOpenStatus(order.status)) throw conflict("invalid_transition", "A situação atual do pedido não permite marcar como não retirado.", { status: order.status });
    if (order.consumptionDate > today) throw conflict("not_consumption_date", "Só é possível marcar como não retirado a partir do dia do consumo.", { consumptionDate: order.consumptionDate, today });
    const totals = totalsOf(order.items);
    if (totals.remaining === 0) throw conflict("nothing_remaining", "Não há unidades por entregar.");
    const remainingCents = order.items.reduce((sum, i) => sum + remainingValueOf(i), 0);
    const status = aggregateStatus({ items: order.items, prep: order.prep, nonPickup: { resolved: false } });
    const stamp = FieldValue.serverTimestamp();
    tx.update(order.ref, {
      status,
      // Pedido reagendado depois de uma não retirada e de novo não retirado: o registro anterior (já resolvido) vai para o histórico.
      ...(order.data.nonPickup ? { nonPickupHistory: FieldValue.arrayUnion(order.data.nonPickup) } : {}),
      nonPickup: { markedAt: stamp, markedByUid: current.uid, markedByRole: current.role ?? null, reason: input.reason, remainingUnits: totals.remaining, remainingCents, resolution: null },
      version: order.version + 1,
      updatedAt: stamp,
    });
    auditInTransaction(db, tx, auditId, {
      action: "orders.not_picked_up",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "order", id: input.orderId },
      reason: input.reason,
      before: { status: order.status },
      after: { status, remainingUnits: totals.remaining, remainingCents },
    });
    return { orderId: input.orderId, status, statusLabel: statusInfo(status).label, version: order.version + 1, remainingUnits: totals.remaining, remainingCents };
  });
}

export type ResolveResult = {
  orderId: string;
  status: string;
  statusLabel: string;
  version: number;
  resolution: "close_charged" | "cancel_refund" | "reschedule";
  /** `reschedule` não é encerramento financeiro: sem classificação (o pedido volta a "pago · aguardando entrega" no destino). */
  classification: typeof RETAINED_CLASSIFICATION | typeof REFUNDED_CLASSIFICATION | null;
  /** Valor já pago e MANTIDO pela escola (`close_charged`); 0 em `cancel_refund`. */
  retainedCents: number;
  /** Valor devolvido à carteira ORIGINAL do aluno (`cancel_refund`); 0 em `close_charged`. */
  refundCents: number;
  wallet: { studentId: string; entryId: string | null; seq: number; balanceCents: number; version: number } | null;
  returnedUnits: number;
  discardedUnits: number;
  /** Unidades de OUTROS pedidos que ficaram sem lastro físico por causa do descarte (0 = nenhuma) e os pedidos a tratar. */
  shortfallUnits: number;
  affectedOrders: string[];
  /** Só em `reschedule`: novo destino do pedido. */
  rescheduledTo?: { date: string; shiftId: string; cutoffOverride: boolean };
};

/**
 * Resolução (SÓ administração, com motivo) de um não retirado. Implementada: `close_charged` = encerrar COM cobrança —
 * o valor já pago fica retido com a classificação `retained_charge_not_picked_up` (sem novo lançamento no livro, sem
 * reembolso, sem receita duplicada). As unidades restantes saem da reserva (voltam à disponibilidade, sem entrada
 * fictícia) e SÓ as listadas em `discards` viram perda, com movimento de perda explícito pelo estoque.
 * `cancel_refund` (F14) = cancelar e REEMBOLSAR o restante não retirado à carteira original (valor pago registrado, mesmo
 * ponto de liquidação do cancelamento: livro, reserva/cota, uso da F09 e auditoria na mesma transação). `reschedule` (F16) =
 * reagendar o restante não retirado para outra data/turno do aluno pelo MESMO planejamento do reagendamento da equipe
 * (`planReschedule`: libera a origem, revalida destino/cardápio/cota/limites, mantém pagamento e preços, sem lançamento).
 */
export async function resolveNotPickedUp(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<ResolveResult & { replayed: boolean }> {
  authorize(actor, "orders.resolve");
  const input = resolveSchema.parse(raw);
  return runIdempotentCommand(db, actor, { scope: "orders.resolve", key: input.key, payload: input, allow: allowResolve }, async ({ tx, actor: current, auditId }) => {
    const now = clock();
    const today = localDateOf(now);
    const order = await readOrder(tx, db, input.orderId);
    if (order.status === "not_picked_up_closed" || order.data.nonPickup?.resolution) throw conflict("already_resolved", "Este pedido já foi resolvido.");
    if (order.status !== "not_picked_up") throw conflict("invalid_transition", "Só pedidos marcados como não retirados podem ser resolvidos.", { status: order.status });

    const byLine = new Map(order.items.map((i) => [i.lineNo, i]));
    const discards = new Map(input.discards.map((d) => [d.lineNo, d.quantity]));
    for (const [lineNo, quantity] of discards) {
      const item = byLine.get(lineNo);
      if (!item) throw conflict("line_not_found", "Item não encontrado no pedido.", { lineNo });
      if (quantity > remainingOf(item)) throw conflict("quantity_exceeds_remaining", "O descarte supera o que ficou sem retirar.", { lineNo, remaining: remainingOf(item), requested: quantity });
    }

    if (input.resolution === "cancel_refund") return refundNotPickedUp(db, tx, { order, current, auditId, input, today });
    if (input.resolution === "reschedule") return rescheduleNotPickedUp(db, tx, { order, current, auditId, input, today, now });

    const stock = openStockSession(db, tx, { today, actor: sessionActor(current) });
    const losses: { lineNo: number; productId: string; quantity: number; movementId: string }[] = [];
    let returned = 0;
    let retainedCents = 0;
    for (const item of order.items) {
      const remaining = remainingOf(item);
      if (remaining === 0) continue;
      retainedCents += remainingValueOf(item);
      await stock.release({ productId: item.productId, reservationId: item.reservationId, quantity: remaining, orderRef: input.orderId });
      returned += remaining;
    }
    let discarded = 0;
    let shortfallUnits = 0;
    const affected = new Set<string>();
    for (const [lineNo, quantity] of discards) {
      const item = byLine.get(lineNo)!;
      const loss = await stock.removeUnits({
        productId: item.productId,
        quantity,
        type: "loss",
        reason: `Não retirado: ${input.reason}`,
        reasonCode: "discard",
        referenceType: "order",
        referenceId: input.orderId,
      });
      losses.push({ lineNo, productId: item.productId, quantity, movementId: loss.movementId });
      shortfallUnits += loss.shortfallUnits;
      if (loss.shortfallUnits > 0) for (const ref of await otherOrdersCovering(db, tx, item.productId, input.orderId, loss.shortfallUnits)) affected.add(ref);
      discarded += quantity;
    }

    const status = aggregateStatus({ items: order.items, prep: order.prep, nonPickup: { resolved: true } });
    const stamp = FieldValue.serverTimestamp();
    const previous = (order.data.nonPickup ?? {}) as Record<string, unknown>;
    tx.update(order.ref, {
      status,
      nonPickup: {
        ...previous,
        resolution: {
          kind: "close_charged",
          classification: RETAINED_CLASSIFICATION,
          amountCents: retainedCents,
          returnedUnits: returned - discarded,
          discardedUnits: discarded,
          discards: losses.map((l) => ({ lineNo: l.lineNo, quantity: l.quantity, movementId: l.movementId })),
          reason: input.reason,
          resolvedByUid: current.uid,
          resolvedByRole: current.role ?? null,
          resolvedAt: stamp,
        },
      },
      version: order.version + 1,
      updatedAt: stamp,
    });
    auditInTransaction(db, tx, auditId, {
      action: "orders.resolve_not_picked_up",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "order", id: input.orderId },
      reason: input.reason,
      before: { status: order.status },
      after: { status, classification: RETAINED_CLASSIFICATION, retainedCents, returnedUnits: returned - discarded, discardedUnits: discarded, losses, shortfallUnits, affectedOrders: [...affected] },
    });
    stock.commit();
    return { orderId: input.orderId, status, statusLabel: statusInfo(status).label, version: order.version + 1, resolution: "close_charged", classification: RETAINED_CLASSIFICATION, retainedCents, refundCents: 0, wallet: null, returnedUnits: returned - discarded, discardedUnits: discarded, shortfallUnits, affectedOrders: [...affected] };
  });
}

/**
 * `cancel_refund`: o restante não retirado é cancelado e reembolsado pela MESMA liquidação do cancelamento (`planCancellation`):
 * valor pago registrado → carteira original, reserva/cota e uso liberados, descarte só nas unidades listadas. A resolução fica
 * registrada em `nonPickup.resolution` (kind `cancel_refund`) e a situação passa a `cancelled` (nada entregue) ou `delivered`
 * (parte já entregue antes). Nada de cobrança retida aqui.
 */
async function refundNotPickedUp(
  db: Firestore,
  tx: FirebaseFirestore.Transaction,
  p: { order: OrderState; current: Actor; auditId: string; input: ResolveInput; today: string },
): Promise<ResolveResult> {
  const { order, current, input } = p;
  const cancellationId = deterministicId("can", current.uid, input.key);
  const cancel = new Map(order.items.filter((i) => remainingOf(i) > 0).map((i) => [i.lineNo, remainingOf(i)] as const));
  const plan = await planCancellation(db, tx, { order, actor: current, today: p.today, cancellationId, kind: "not_picked_up", reason: input.reason, cancel, discards: new Map(input.discards.map((d) => [d.lineNo, d.quantity])) });
  const status = aggregateStatus({ items: plan.items, prep: order.prep, nonPickup: null });
  const returned = plan.canceledUnits - plan.discardedUnits;
  const discards = plan.discards.map((d) => ({ lineNo: d.lineNo, quantity: d.quantity, movementId: d.movementId }));
  plan.commit();
  tx.update(order.ref, {
    ...plan.orderPatch(status),
    nonPickup: {
      ...((order.data.nonPickup ?? {}) as Record<string, unknown>),
      resolution: {
        kind: "cancel_refund",
        classification: REFUNDED_CLASSIFICATION,
        amountCents: plan.refundCents,
        refundCents: plan.refundCents,
        returnedUnits: returned,
        discardedUnits: plan.discardedUnits,
        discards,
        cancellationId,
        reason: input.reason,
        resolvedByUid: current.uid,
        resolvedByRole: current.role ?? null,
        resolvedAt: FieldValue.serverTimestamp(),
      },
    },
  });
  auditInTransaction(db, tx, p.auditId, {
    action: "orders.resolve_not_picked_up",
    actorUid: current.uid,
    actorRole: current.role ?? null,
    target: { type: "order", id: input.orderId },
    reason: input.reason,
    before: { status: order.status, refundedCents: Number(order.data.refundedCents ?? 0), balanceCents: plan.wallet.previousBalanceCents },
    after: {
      status,
      resolution: "cancel_refund",
      classification: REFUNDED_CLASSIFICATION,
      cancellationId,
      studentId: plan.wallet.studentId,
      studentStatus: plan.studentStatus,
      refundCents: plan.refundCents,
      balanceCents: plan.wallet.balanceCents,
      walletEntryId: plan.wallet.entryId,
      returnedUnits: returned,
      discardedUnits: plan.discardedUnits,
      discards,
      shortfallUnits: plan.shortfallUnits,
      affectedOrders: plan.affectedOrders,
    },
  });
  return {
    orderId: input.orderId,
    status,
    statusLabel: statusInfo(status).label,
    version: order.version + 1,
    resolution: "cancel_refund",
    classification: REFUNDED_CLASSIFICATION,
    retainedCents: 0,
    refundCents: plan.refundCents,
    wallet: { studentId: plan.wallet.studentId, entryId: plan.wallet.entryId, seq: plan.wallet.seq, balanceCents: plan.wallet.balanceCents, version: plan.wallet.version },
    returnedUnits: returned,
    discardedUnits: plan.discardedUnits,
    shortfallUnits: plan.shortfallUnits,
    affectedOrders: plan.affectedOrders,
  };
}

/**
 * `reschedule` (F16): o restante não retirado vai para outra data/turno pelo MESMO `planReschedule` do comando da equipe. O pedido
 * volta a "pago · aguardando entrega" no destino (sem cobrança nova, preços preservados); a resolução fica em
 * `nonPickup.resolution` (kind `reschedule`) e o evento em `orders/{id}/reschedules`. Pedido com parte entregue é recusado.
 */
async function rescheduleNotPickedUp(
  db: Firestore,
  tx: FirebaseFirestore.Transaction,
  p: { order: OrderState; current: Actor; auditId: string; input: ResolveInput; today: string; now: Date },
): Promise<ResolveResult> {
  const { order, current, input } = p;
  const rescheduleId = deterministicId("rsc", current.uid, input.key);
  const plan = await planReschedule(db, tx, {
    order,
    actor: current,
    now: p.now,
    today: p.today,
    rescheduleId,
    kind: "not_picked_up",
    reason: input.reason,
    toDate: input.toDate!,
    toShiftId: input.toShiftId!,
    overrideCutoff: input.overrideCutoff,
    exceptionId: input.exceptionId,
  });
  plan.commit();
  tx.update(order.ref, {
    ...plan.orderPatch(),
    nonPickup: {
      ...((order.data.nonPickup ?? {}) as Record<string, unknown>),
      resolution: {
        kind: "reschedule",
        classification: null,
        amountCents: 0,
        rescheduleId,
        to: plan.to,
        cutoffOverride: plan.cutoffOverride,
        reason: input.reason,
        resolvedByUid: current.uid,
        resolvedByRole: current.role ?? null,
        resolvedAt: FieldValue.serverTimestamp(),
      },
    },
  });
  auditInTransaction(db, tx, p.auditId, {
    action: "orders.resolve_not_picked_up",
    actorUid: current.uid,
    actorRole: current.role ?? null,
    target: { type: "order", id: input.orderId },
    reason: input.reason,
    before: { status: order.status, consumptionDate: plan.from.date, shiftId: plan.from.shiftId },
    after: { status: plan.status, resolution: "reschedule", rescheduleId, consumptionDate: plan.to.date, shiftId: plan.to.shiftId, movedUnits: plan.movedUnits, cutoffOverride: plan.cutoffOverride, override: plan.override, charged: 0 },
  });
  return {
    orderId: input.orderId,
    status: plan.status,
    statusLabel: statusInfo(plan.status).label,
    version: order.version + 1,
    resolution: "reschedule",
    classification: null,
    retainedCents: 0,
    refundCents: 0,
    wallet: null,
    returnedUnits: 0,
    discardedUnits: 0,
    shortfallUnits: 0,
    affectedOrders: [],
    rescheduledTo: { ...plan.to, cutoffOverride: plan.cutoffOverride },
  };
}
