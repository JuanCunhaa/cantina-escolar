import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { localDateOf } from "@/lib/dates/school-time";
import { conflict, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { openStockSession } from "@/modules/inventory/session";
import { statusInfo } from "./history-model";
import {
  PENDING_RESOLUTIONS,
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
  totalsOf,
  deliveryRevenueOf,
  remainingValueOf,
  type PrepStage,
} from "./fulfillment-model";
import type { OrderItem } from "./model";

/**
 * Comandos de operação do pedido (F13, docs/domains/fulfillment.md §12): preparo, entrega (direta ou parcial),
 * não retirada e sua resolução. Todos: servidor autenticado, perfil ATUAL relido na transação (`runIdempotentCommand`),
 * idempotentes por chave+payload, pedido relido e revalidado DENTRO da transação (leituras antes das escritas) e
 * auditoria na mesma transação. O pedido já foi pago na F11: NENHUM comando daqui toca a carteira ou o livro.
 *
 * Estoque: sempre pela `StockSession` da F10 na mesma transação do pedido; a reserva usada é a do PRÓPRIO pedido
 * (`orderRef` conferido), então uma entrega nunca consome o que está reservado para outro pedido.
 */
const sessionActor = (actor: Actor) => ({ uid: actor.uid, role: actor.role ?? null });
const allowOperate = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "orders.operate");
const allowResolve = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "orders.resolve");

type OrderState = {
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
  items: OrderItem[];
  status: string;
  prep: PrepStage;
  version: number;
  consumptionDate: string;
};

async function readOrder(tx: FirebaseFirestore.Transaction, db: Firestore, orderId: string): Promise<OrderState> {
  const ref = db.doc(`orders/${orderId}`);
  const snap = await tx.get(ref);
  const data = snap.data();
  if (!data || typeof data.studentId !== "string" || !Array.isArray(data.items)) throw notFound("order_not_found", "Pedido não encontrado.");
  if (data.channel !== "advance") throw conflict("channel_not_supported", "Este comando atende pedidos antecipados.");
  const prep = data.prep === "preparing" || data.prep === "ready" ? (data.prep as PrepStage) : "none";
  return { ref, data, items: data.items as OrderItem[], status: String(data.status ?? "paid"), prep, version: Number(data.version ?? 1), consumptionDate: String(data.consumptionDate) };
}

const itemsView = (items: readonly OrderItem[]) => items.map((i) => ({ lineNo: i.lineNo, quantity: i.quantity, deliveredQty: deliveredOf(i), remainingQty: remainingOf(i) }));

/**
 * Pedidos (que não este) com reserva ativa do produto, das datas mais distantes para as mais próximas, até somar o déficit.
 * A lista do estoque não serve aqui: ela lê o estado já gravado, em que a reserva deste pedido (liberada só em memória na
 * sessão) ainda aparece ativa. Só leituras (as gravações da sessão ficam para o `commit`).
 */
async function otherOrdersCovering(db: Firestore, tx: FirebaseFirestore.Transaction, productId: string, orderId: string, shortfall: number): Promise<string[]> {
  const snap = await tx.get(db.collection(`stockBalances/${productId}/reservations`).where("status", "==", "active").limit(500));
  const rows = snap.docs
    .map((d) => ({ orderRef: String(d.get("orderRef")), date: String(d.get("consumptionDate")), remaining: Number(d.get("quantity") ?? 0) - Number(d.get("deliveredQty") ?? 0) - Number(d.get("releasedQty") ?? 0) }))
    .filter((r) => r.orderRef !== orderId && r.remaining > 0)
    .sort((a, b) => b.date.localeCompare(a.date) || a.orderRef.localeCompare(b.orderRef));
  const out: string[] = [];
  let covered = 0;
  for (const r of rows) {
    if (covered >= shortfall) break;
    out.push(r.orderRef);
    covered += r.remaining;
  }
  return out;
}

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
  classification: typeof RETAINED_CLASSIFICATION;
  retainedCents: number;
  returnedUnits: number;
  discardedUnits: number;
  /** Unidades de OUTROS pedidos que ficaram sem lastro físico por causa do descarte (0 = nenhuma) e os pedidos a tratar. */
  shortfallUnits: number;
  affectedOrders: string[];
};

/**
 * Resolução (SÓ administração, com motivo) de um não retirado. Implementada: `close_charged` = encerrar COM cobrança —
 * o valor já pago fica retido com a classificação `retained_charge_not_picked_up` (sem novo lançamento no livro, sem
 * reembolso, sem receita duplicada). As unidades restantes saem da reserva (voltam à disponibilidade, sem entrada
 * fictícia) e SÓ as listadas em `discards` viram perda, com movimento de perda explícito pelo estoque. Cancelar/reembolsar
 * (F14) e reagendar (F16) ainda não existem: são recusados com a pendência explícita, sem simular conclusão.
 */
export async function resolveNotPickedUp(db: Firestore, actor: Actor, raw: unknown): Promise<ResolveResult & { replayed: boolean }> {
  authorize(actor, "orders.resolve");
  const input = resolveSchema.parse(raw);
  if (input.resolution !== "close_charged") {
    const pending = PENDING_RESOLUTIONS[input.resolution];
    throw conflict("resolution_unavailable", `${pending.label}: ainda não disponível.`, { resolution: input.resolution, availableIn: pending.task });
  }
  return runIdempotentCommand(db, actor, { scope: "orders.resolve", key: input.key, payload: input, allow: allowResolve }, async ({ tx, actor: current, auditId }) => {
    const today = localDateOf(new Date());
    const order = await readOrder(tx, db, input.orderId);
    if (order.status === "not_picked_up_closed") throw conflict("already_resolved", "Este pedido já foi resolvido.");
    if (order.status !== "not_picked_up") throw conflict("invalid_transition", "Só pedidos marcados como não retirados podem ser resolvidos.", { status: order.status });

    const byLine = new Map(order.items.map((i) => [i.lineNo, i]));
    const discards = new Map(input.discards.map((d) => [d.lineNo, d.quantity]));
    for (const [lineNo, quantity] of discards) {
      const item = byLine.get(lineNo);
      if (!item) throw conflict("line_not_found", "Item não encontrado no pedido.", { lineNo });
      if (quantity > remainingOf(item)) throw conflict("quantity_exceeds_remaining", "O descarte supera o que ficou sem retirar.", { lineNo, remaining: remainingOf(item), requested: quantity });
    }

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
    return { orderId: input.orderId, status, statusLabel: statusInfo(status).label, version: order.version + 1, classification: RETAINED_CLASSIFICATION, retainedCents, returnedUnits: returned - discarded, discardedUnits: discarded, shortfallUnits, affectedOrders: [...affected] };
  });
}
