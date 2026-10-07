import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction } from "firebase-admin/firestore";
import { localDateOf } from "@/lib/dates/school-time";
import { DomainError, conflict } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { openStockSession } from "@/modules/inventory/session";
import { readMenuForSale } from "@/modules/menu/queries";
import { evaluatePurchasePolicy, type PurchaseEvaluation, type PurchaseLine, type UsageView } from "@/modules/policies/evaluate";
import { parseException, parsePolicy, type PolicyException, type StudentPolicy } from "@/modules/policies/model";
import { exceptionRefOf } from "@/modules/policies/purchase-guard";
import { applyUsageDeltas, readUsage, usageAfter, type UsageDelta } from "@/modules/policies/usage";
import type { PolicySnapshot } from "@/modules/school/calendar";
import { checkDestination } from "@/modules/school/settings";
import { applyDelta, assertCanSpend, parseWalletState } from "@/modules/wallet/model";
import { MAX_ORDER_LINES, exchangeDifference, exchangeQuoteSchema, exchangeSchema, rescheduleSchema, type ExchangeQuote, type ExchangeQuoteInput } from "./amend-model";
import { CANCELLED, aggregateStatus, deliveredOf, exchangeCreditOf, exchangedOf, isOpenStatus, remainingOf, type PrepStage } from "./fulfillment-model";
import { statusInfo } from "./history-model";
import { subtotalOf, type OrderItem } from "./model";
import { itemsView, readOrder, sessionActor, type OrderState } from "./order-state";

/**
 * Reagendamento/antecipação e troca de produtos (F16, docs/domains/pos.md §13; regras puras em `amend-model.ts`).
 *
 * Os dois comandos são da EQUIPE com `orders.amend` (cantina e administração) e seguem o roteiro de docs/firebase/transactions.md:
 * perfil ATUAL relido na transação (`runIdempotentCommand`), pedido relido e revalidado DENTRO dela, todas as leituras antes de
 * qualquer escrita, resultado inteiro ou nada e auditoria na mesma transação. Nenhum I/O externo no callback.
 *
 * Destino (data/turno) segue as regras da compra antecipada (turno ativo, hoje…hoje+7, dia de funcionamento, cardápio do
 * destino). Horário de compra já encerrado só passa com `overrideCutoff` — exceção OPERACIONAL explícita, gravada no evento e na
 * auditoria; o responsável não tem este comando (não há bypass público de horário). Limites diário/semanal do aluno são
 * REVALIDADOS no destino (a origem sai do comprometimento antes de avaliar); a equipe só os supera com exceção de uso único
 * registrada (autorização do responsável ou exceção administrativa auditada), como no PDV.
 */
const allowAmend = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "orders.amend");

type StudentContext = { student: DocumentSnapshot; policy: StudentPolicy; exception: PolicyException | null; exceptionRef: DocumentReference | null };

/** Aluno ATIVO, política atual e a exceção indicada (do PRÓPRIO aluno: o caminho já é `studentPolicies/{aluno}/exceptions`). */
async function readStudentContext(db: Firestore, tx: Transaction, studentId: string, exceptionId: string | undefined): Promise<StudentContext> {
  const exceptionRef = exceptionId ? exceptionRefOf(db, studentId, exceptionId) : null;
  const [student, policy, exception] = await tx.getAll(db.doc(`students/${studentId}`), db.doc(`studentPolicies/${studentId}`), ...(exceptionRef ? [exceptionRef] : []));
  if (!student?.exists || student.get("status") !== "active") throw conflict("student_inactive", "Aluno inativo: reagendar ou trocar não é possível (cancele e reembolse, se for o caso).");
  const parsed = exceptionRef ? parseException(exceptionRef.id, exception?.data()) : null;
  if (exceptionRef && !parsed) throw conflict("exception_not_found", "Exceção não encontrada para este aluno.");
  return { student: student, policy: parsePolicy(policy?.data()), exception: parsed, exceptionRef };
}

/** Avaliador ÚNICO da F09, como funcionário: sem confirmação de responsável; só exceção registrada supera. */
function evaluateLimits(ctx: StudentContext, lines: readonly PurchaseLine[], usage: UsageView, ignoreBlocks: boolean): PurchaseEvaluation | null {
  const paid = lines.filter((l) => l.amountCents > 0); // linha de valor pago zero não compromete limite
  if (paid.length === 0) return null;
  const policy = ignoreBlocks ? { ...ctx.policy, blockedProductIds: [], blockedCategoryIds: [] } : ctx.policy;
  return evaluatePurchasePolicy({ channel: "advance", actorKind: "staff", permitted: true, policy, lines: paid, usage, exception: ctx.exception });
}

const policyDenied = (e: PurchaseEvaluation) =>
  conflict("policy_denied", "O destino passa dos limites ou bloqueios do aluno. Só uma exceção de uso único registrada (autorização do responsável ou exceção administrativa) permite.", {
    violations: e.violations,
    days: e.days,
    weeks: e.weeks,
    totalCents: e.totalCents,
  });

const cutoffRequired = (date: string) =>
  conflict("after_cutoff", "O horário de compra desta data já encerrou: só a equipe pode seguir, confirmando a exceção operacional (registrada na auditoria).", { date, overridable: true });

const policyFields = (s: PolicySnapshot) => ({
  timezone: s.timezone,
  consumptionDate: s.consumptionDate,
  shiftId: s.shiftId,
  purchaseCutoff: s.purchaseCutoff,
  cancelCutoff: s.cancelCutoff,
  purchaseCutoffAt: s.purchaseCutoffAt,
  cancelCutoffAt: s.cancelCutoffAt,
  settingsVersion: s.settingsVersion,
});

/* ------------------------------------------------------------------------------------------- reagendamento */

export type MoveKind = "operational" | "not_picked_up";

export type ReschedulePlan = {
  rescheduleId: string;
  seq: number;
  from: { date: string; shiftId: string };
  to: { date: string; shiftId: string };
  items: OrderItem[];
  lines: { lineNo: number; productId: string; name: string; quantity: number; fromReservationId: string; toReservationId: string }[];
  movedUnits: number;
  movedCents: number;
  cutoffOverride: boolean;
  override: PurchaseEvaluation["override"];
  status: string;
  /** Campos do pedido a gravar (data/turno/política do destino, reservas novas, preparo zerado), com a versão incrementada. */
  orderPatch(): Record<string, unknown>;
  /** Estoque, uso, exceção usada e o evento imutável `orders/{id}/reschedules/{id}`. Pedido e auditoria são do chamador. */
  commit(): void;
};

/**
 * Planejamento ÚNICO do reagendamento (comando da equipe e resolução `reschedule` de não retirado). Move TODO o restante de um
 * pedido ainda sem entrega: o pedido continua o mesmo (mesmo pagamento, mesmo livro, mesmos preços), muda data/turno.
 * Pedido com parte entregue não é reagendado (as unidades entregues pertencem à data original): o restante é entregue ou
 * cancelado/reembolsado. Bloqueios de produto/categoria NÃO são reavaliados (o produto já foi autorizado e pago; reduzir
 * limite ou bloquear depois não desfaz pedido — docs/domains/policies.md §9); os limites do destino SIM.
 */
export async function planReschedule(
  db: Firestore,
  tx: Transaction,
  p: { order: OrderState; actor: Actor; now: Date; today: string; rescheduleId: string; kind: MoveKind; reason: string; toDate: string; toShiftId: string; overrideCutoff: boolean; exceptionId?: string },
): Promise<ReschedulePlan> {
  const { order } = p;
  const orderId = order.ref.id;
  const studentId = String(order.data.studentId);
  const fromShift = String(order.data.shiftId ?? "");
  if (order.items.some((i) => deliveredOf(i) > 0)) {
    throw conflict("partially_delivered", "Parte do pedido já foi entregue: o restante não é reagendado (entregue-o ou cancele e reembolse).");
  }
  const moving = order.items.filter((i) => remainingOf(i) > 0);
  if (moving.length === 0) throw conflict("nothing_remaining", "Não há unidades a reagendar.");
  if (p.toDate === order.consumptionDate && p.toShiftId === fromShift) throw conflict("same_destination", "O destino é a mesma data e o mesmo turno do pedido.");

  // Leituras (nenhuma escrita antes do fim delas).
  const ctx = await readStudentContext(db, tx, studentId, p.exceptionId);
  const currentShift = String(ctx.student.get("shiftId") ?? "");
  if (p.toShiftId !== currentShift) throw conflict("shift_changed", "O destino precisa ser o turno ATUAL do aluno.", { shiftId: currentShift });
  const dest = await checkDestination(db, { shiftId: p.toShiftId, date: p.toDate, now: p.now }, tx);
  if (!dest.allowed) throw conflict(dest.reason, undefined, { date: p.toDate, shiftId: p.toShiftId });
  const menu = await readMenuForSale(db, tx, { date: p.toDate, shiftId: p.toShiftId, channel: "advance", productIds: moving.map((i) => i.productId) });
  const sales = moving.map((item) => {
    const sale = menu.get(item.productId);
    if (!sale?.ok) throw conflict("item_unavailable", "Produto indisponível no destino.", { date: p.toDate, productId: item.productId, reason: sale?.reason ?? "product_not_found" });
    return { item, sale, units: remainingOf(item), usageCents: subtotalOf(item.unitPriceCents, remainingOf(item)) };
  });
  const usage = await readUsage(db, tx, studentId, [order.consumptionDate, p.toDate]);
  const release: UsageDelta[] = sales.map((s) => ({ date: order.consumptionDate, amountCents: -s.usageCents }));
  const commit: UsageDelta[] = sales.map((s) => ({ date: p.toDate, amountCents: s.usageCents }));
  const evaluation = evaluateLimits(ctx, sales.map((s) => ({ consumptionDate: p.toDate, productId: s.item.productId, categoryId: s.sale.product.categoryId, amountCents: s.usageCents })), usageAfter(usage, release), true);
  if (evaluation && !evaluation.allowed) throw policyDenied(evaluation);
  if (dest.cutoffPassed && !p.overrideCutoff) throw cutoffRequired(p.toDate);

  // Estoque: libera a reserva/cota da origem (sem entrada física) e reserva no destino, na MESMA sessão.
  const seq = Number(order.data.rescheduleCount ?? 0) + 1;
  const stock = openStockSession(db, tx, { today: p.today, actor: sessionActor(p.actor) });
  for (const s of sales) await stock.release({ productId: s.item.productId, reservationId: s.item.reservationId, quantity: s.units, orderRef: orderId });
  const lines: ReschedulePlan["lines"] = [];
  for (const s of sales) {
    const toReservationId = `${orderId}_r${s.item.lineNo}_m${seq}`;
    await stock.reserve({ productId: s.item.productId, quantity: s.units, consumptionDate: p.toDate, shiftId: p.toShiftId, reservationId: toReservationId, orderRef: orderId, menuLimit: s.sale.limit });
    lines.push({ lineNo: s.item.lineNo, productId: s.item.productId, name: s.item.name, quantity: s.units, fromReservationId: s.item.reservationId, toReservationId });
  }

  const moved = new Map(lines.map((l) => [l.lineNo, l.toReservationId]));
  const items = order.items.map((i) => (moved.has(i.lineNo) ? { ...i, reservationId: moved.get(i.lineNo)! } : i));
  const status = aggregateStatus({ items, prep: "none", nonPickup: null });
  const movedUnits = lines.reduce((n, l) => n + l.quantity, 0);
  const movedCents = sales.reduce((n, s) => n + s.usageCents, 0);
  const override = evaluation?.override ?? null;
  return {
    rescheduleId: p.rescheduleId,
    seq,
    from: { date: order.consumptionDate, shiftId: fromShift },
    to: { date: p.toDate, shiftId: p.toShiftId },
    items,
    lines,
    movedUnits,
    movedCents,
    cutoffOverride: dest.cutoffPassed,
    override,
    status,
    orderPatch: () => ({
      items,
      consumptionDate: p.toDate,
      shiftId: p.toShiftId,
      policy: policyFields(dest.snapshot),
      prep: "none" satisfies PrepStage,
      status,
      rescheduleCount: seq,
      lastRescheduleId: p.rescheduleId,
      originalConsumptionDate: typeof order.data.originalConsumptionDate === "string" ? order.data.originalConsumptionDate : order.consumptionDate,
      version: order.version + 1,
      updatedAt: FieldValue.serverTimestamp(),
    }),
    commit() {
      stock.commit();
      applyUsageDeltas(tx, db, studentId, usage, [...release, ...commit]);
      if (override?.via === "exception" && ctx.exceptionRef) tx.update(ctx.exceptionRef, { status: "used", usedBy: p.actor.uid, usedFor: orderId, usedAt: FieldValue.serverTimestamp() });
      tx.create(db.doc(`orders/${orderId}/reschedules/${p.rescheduleId}`), {
        rescheduleId: p.rescheduleId,
        orderId,
        studentId,
        seq,
        kind: p.kind,
        from: { date: order.consumptionDate, shiftId: fromShift },
        to: { date: p.toDate, shiftId: p.toShiftId },
        lines,
        movedUnits,
        movedCents,
        cutoffOverride: dest.cutoffPassed,
        override,
        reason: p.reason,
        actorUid: p.actor.uid,
        actorRole: p.actor.role ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });
    },
  };
}

export type RescheduleResult = {
  orderId: string;
  rescheduleId: string;
  status: string;
  statusLabel: string;
  version: number;
  from: { date: string; shiftId: string };
  to: { date: string; shiftId: string };
  movedUnits: number;
  /** A exceção operacional de horário foi usada (o destino já estava fechado para compra). */
  cutoffOverride: boolean;
  /** Nenhum lançamento no livro: o pagamento original continua sendo o único. */
  charged: 0;
  items: { lineNo: number; quantity: number; deliveredQty: number; remainingQty: number }[];
};

/** Situação que permite reagendar pelo comando comum (não retirado vai pela resolução da administração). */
function assertMovable(order: OrderState, actor: Actor, today: string): void {
  if (order.status === CANCELLED) throw conflict("already_cancelled", "O pedido foi cancelado.");
  if (order.status === "delivered") throw conflict("already_delivered", "Pedido entregue não é reagendado.");
  if (order.status === "not_picked_up") throw conflict("use_resolution", "Pedido não retirado: a administração decide em “Resolver” (reagendar, cancelar e reembolsar ou encerrar com cobrança).", { status: order.status });
  if (order.status === "not_picked_up_closed") throw conflict("already_resolved", "Este pedido já foi resolvido.");
  if (order.status === "partially_delivered") throw conflict("partially_delivered", "Parte do pedido já foi entregue: o restante não é reagendado (entregue-o ou cancele e reembolse).");
  if (!isOpenStatus(order.status)) throw conflict("order_not_reschedulable", "A situação atual do pedido não permite reagendar.", { status: order.status });
  // Pedido de data JÁ PASSADA: como no cancelamento, a decisão é da administração (resolução de não retirado).
  if (order.consumptionDate < today && !can(actor, "orders.resolve")) {
    throw conflict("past_date_requires_resolution", "Pedido de data passada: marque como não retirado para a administração resolver.", { consumptionDate: order.consumptionDate, today });
  }
}

/**
 * Reagendar/antecipar atendimento (equipe, `orders.amend`, motivo obrigatório). Idempotente por chave + payload: resposta
 * perdida e clique duplo com a MESMA chave devolvem a resposta original (o perfil atual é reconferido); outra chave sobre o
 * pedido já movido recusa (`same_destination`) ou move de novo só se o destino for outro — a reserva liberada é sempre a do
 * PRÓPRIO pedido, então nada é reservado duas vezes.
 */
export async function rescheduleOrder(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<RescheduleResult & { replayed: boolean }> {
  authorize(actor, "orders.amend");
  const input = rescheduleSchema.parse(raw);
  const rescheduleId = deterministicId("rsc", actor.uid, input.key);
  return runIdempotentCommand(db, actor, { scope: "orders.reschedule", key: input.key, payload: input, allow: allowAmend }, async ({ tx, actor: current, auditId }) => {
    const now = clock();
    const today = localDateOf(now);
    const order = await readOrder(tx, db, input.orderId);
    assertMovable(order, current, today);
    const plan = await planReschedule(db, tx, { order, actor: current, now, today, rescheduleId, kind: "operational", reason: input.reason, toDate: input.toDate, toShiftId: input.toShiftId, overrideCutoff: input.overrideCutoff, exceptionId: input.exceptionId });
    plan.commit();
    tx.update(order.ref, plan.orderPatch());
    auditInTransaction(db, tx, auditId, {
      action: "orders.reschedule",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "order", id: input.orderId },
      reason: input.reason,
      before: { status: order.status, consumptionDate: plan.from.date, shiftId: plan.from.shiftId },
      after: { status: plan.status, consumptionDate: plan.to.date, shiftId: plan.to.shiftId, rescheduleId, movedUnits: plan.movedUnits, movedCents: plan.movedCents, cutoffOverride: plan.cutoffOverride, override: plan.override, charged: 0 },
    });
    return {
      orderId: input.orderId,
      rescheduleId,
      status: plan.status,
      statusLabel: statusInfo(plan.status).label,
      version: order.version + 1,
      from: plan.from,
      to: plan.to,
      movedUnits: plan.movedUnits,
      cutoffOverride: plan.cutoffOverride,
      charged: 0 as const,
      items: itemsView(plan.items),
    };
  });
}

/* ------------------------------------------------------------------------------------------------- troca */

type ExchangePlan = {
  quote: ExchangeQuote;
  evaluation: PurchaseEvaluation | null;
  /** Aplica as recusas da CONFIRMAÇÃO (horário, política, diferença confirmada, saldo) e devolve a carteira depois da troca. */
  enforce(input: { overrideCutoff: boolean; expectedDifferenceCents: number }): { balanceCents: number; version: number } | null;
  orderPatch(): Record<string, unknown>;
  commit(wallet: { balanceCents: number; version: number } | null): { entryId: string | null };
  items: OrderItem[];
  status: string;
  seq: number;
};

function assertExchangeable(order: OrderState, today: string): void {
  if (order.status === CANCELLED) throw conflict("already_cancelled", "O pedido foi cancelado.");
  if (order.status === "delivered") throw conflict("already_delivered", "Pedido entregue não tem o que trocar (correção de entregue é estorno da administração).");
  if (order.status === "not_picked_up" || order.status === "not_picked_up_closed") throw conflict("use_resolution", "Pedido não retirado: a administração decide em “Resolver”.", { status: order.status });
  if (!isOpenStatus(order.status)) throw conflict("order_not_exchangeable", "A situação atual do pedido não permite trocar.", { status: order.status });
  if (order.consumptionDate < today) throw conflict("past_date", "Pedido de data passada não é trocado.", { consumptionDate: order.consumptionDate, today });
}

/**
 * Planejamento da troca (prévia e confirmação usam o MESMO cálculo). Só leituras até `commit`:
 *   - sai: quantidade ≤ restante de cada linha; crédito = valor PAGO dessas unidades (rateio por acumulado, nunca o preço atual);
 *   - entra: produto do cardápio da data/turno do pedido, preço ATUAL do servidor (o que a equipe viu precisa bater);
 *   - política do aluno sobre o que ENTRA (bloqueios e limites da data/semana, com o que sai já descontado);
 *   - estoque: libera a reserva das unidades que saem e reserva as novas na mesma sessão;
 *   - diferença = cobrança − crédito, só ela movimenta a carteira original.
 */
async function planExchange(db: Firestore, tx: Transaction, p: { order: OrderState; actor: Actor; now: Date; today: string; exchangeId: string; input: ExchangeQuoteInput; reason: string }): Promise<ExchangePlan> {
  const { order, input } = p;
  const orderId = order.ref.id;
  const studentId = String(order.data.studentId);
  const shiftId = String(order.data.shiftId ?? "");
  const byLine = new Map(order.items.map((i) => [i.lineNo, i]));

  const removed = input.remove.map((r) => {
    const item = byLine.get(r.lineNo);
    if (!item) throw conflict("line_not_found", "Item não encontrado no pedido.", { lineNo: r.lineNo });
    const remaining = remainingOf(item);
    if (remaining === 0) throw conflict("nothing_remaining", "Este item já foi entregue, cancelado ou trocado: não há o que trocar.", { lineNo: r.lineNo });
    if (r.quantity > remaining) throw conflict("quantity_exceeds_remaining", "A quantidade supera o que ainda pode ser trocado.", { lineNo: r.lineNo, remaining, requested: r.quantity });
    return { item, quantity: r.quantity, creditCents: exchangeCreditOf(item, r.quantity), usageCents: subtotalOf(item.unitPriceCents, r.quantity) };
  });
  const leaving = new Set(removed.map((r) => r.item.productId));
  for (const a of input.add) if (leaving.has(a.productId)) throw conflict("same_product", "Trocar um produto por ele mesmo não muda nada: use cancelar para reduzir a quantidade.", { productId: a.productId });
  if (order.items.length + input.add.length > MAX_ORDER_LINES) throw conflict("too_many_lines", `O pedido chegaria a mais de ${MAX_ORDER_LINES} linhas.`);

  // Leituras.
  const ctx = await readStudentContext(db, tx, studentId, input.exceptionId);
  const dest = await checkDestination(db, { shiftId, date: order.consumptionDate, now: p.now }, tx);
  if (!dest.allowed) throw conflict(dest.reason, undefined, { date: order.consumptionDate, shiftId });
  const menu = await readMenuForSale(db, tx, { date: order.consumptionDate, shiftId, channel: "advance", productIds: input.add.map((a) => a.productId) });
  const added = input.add.map((a) => {
    const sale = menu.get(a.productId);
    if (!sale?.ok) throw conflict("item_unavailable", "Produto indisponível nesta data e turno.", { date: order.consumptionDate, productId: a.productId, reason: sale?.reason ?? "product_not_found" });
    return { ...a, sale, unitPriceCents: sale.product.priceCents, subtotalCents: subtotalOf(sale.product.priceCents, a.quantity) };
  });
  const changes = added.filter((a) => a.expectedPriceCents !== a.unitPriceCents).map((a) => ({ productId: a.productId, name: a.sale.product.name, expectedPriceCents: a.expectedPriceCents, currentPriceCents: a.unitPriceCents }));
  if (changes.length > 0) throw conflict("price_changed", "Preços mudaram: revise a troca e confirme de novo.", { changes });
  const walletRef = db.doc(`wallets/${studentId}`);
  const walletSnap = await tx.get(walletRef);
  const walletBefore = parseWalletState(walletSnap.data());
  const usage = await readUsage(db, tx, studentId, [order.consumptionDate]);

  const creditCents = removed.reduce((n, r) => n + r.creditCents, 0);
  const chargeCents = added.reduce((n, a) => n + a.subtotalCents, 0);
  const differenceCents = exchangeDifference(creditCents, chargeCents);
  const release: UsageDelta[] = removed.map((r) => ({ date: order.consumptionDate, amountCents: -r.usageCents }));
  const commitUsage: UsageDelta[] = added.map((a) => ({ date: order.consumptionDate, amountCents: a.subtotalCents }));
  const evaluation = evaluateLimits(ctx, added.map((a) => ({ consumptionDate: order.consumptionDate, productId: a.productId, categoryId: a.sale.product.categoryId, amountCents: a.subtotalCents })), usageAfter(usage, release), false);

  // Estoque (planejamento só lê; falta de unidade/cota recusa já na prévia).
  const stock = openStockSession(db, tx, { today: p.today, actor: sessionActor(p.actor) });
  for (const r of removed) await stock.release({ productId: r.item.productId, reservationId: r.item.reservationId, quantity: r.quantity, orderRef: orderId });
  let nextLine = Math.max(0, ...order.items.map((i) => i.lineNo));
  const fromLineNos = removed.map((r) => r.item.lineNo);
  const newItems: OrderItem[] = [];
  for (const a of added) {
    nextLine += 1;
    const reservationId = `${orderId}_r${nextLine}`;
    await stock.reserve({ productId: a.productId, quantity: a.quantity, consumptionDate: order.consumptionDate, shiftId, reservationId, orderRef: orderId, menuLimit: a.sale.limit });
    newItems.push({
      lineNo: nextLine,
      productId: a.productId,
      name: a.sale.product.name,
      categoryId: a.sale.product.categoryId,
      unit: "un",
      quantity: a.quantity,
      unitPriceCents: a.unitPriceCents,
      priceVersion: a.sale.product.priceVersion,
      discountCents: 0,
      subtotalCents: a.subtotalCents,
      source: a.sale.source,
      reservationId,
      exchange: { exchangeId: p.exchangeId, fromLineNos },
    });
  }
  const leavingQty = new Map(removed.map((r) => [r.item.lineNo, r.quantity]));
  const items = [...order.items.map((i) => (leavingQty.has(i.lineNo) ? { ...i, exchangedQty: exchangedOf(i) + leavingQty.get(i.lineNo)! } : i)), ...newItems];
  const status = aggregateStatus({ items, prep: order.prep, nonPickup: null });
  const seq = Number(order.data.exchangeCount ?? 0) + 1;
  const quote: ExchangeQuote = {
    orderId,
    version: order.version,
    consumptionDate: order.consumptionDate,
    shiftId,
    removed: removed.map((r) => ({ lineNo: r.item.lineNo, productId: r.item.productId, name: r.item.name, quantity: r.quantity, creditCents: r.creditCents })),
    added: newItems.map((i) => ({ productId: i.productId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents, subtotalCents: i.subtotalCents })),
    creditCents,
    chargeCents,
    differenceCents,
    wallet: { balanceCents: walletBefore.balanceCents, sufficient: walletBefore.balanceCents >= differenceCents },
    policy: { allowed: evaluation?.allowed ?? true, violations: (evaluation?.violations ?? []).map((v) => ({ ...v })) },
    cutoffPassed: dest.cutoffPassed,
  };

  let entryId: string | null = null;
  return {
    quote,
    evaluation,
    items,
    status,
    seq,
    enforce({ overrideCutoff, expectedDifferenceCents }) {
      if (dest.cutoffPassed && !overrideCutoff) throw cutoffRequired(order.consumptionDate);
      if (evaluation && !evaluation.allowed) throw policyDenied(evaluation);
      if (expectedDifferenceCents !== differenceCents) throw conflict("difference_changed", "A diferença calculada pelo servidor mudou: revise a troca e confirme de novo.", { quote });
      if (differenceCents === 0) return null;
      if (differenceCents > 0) assertCanSpend(walletSnap.data()); // troca com cobrança é despesa (F19: bloqueada com pendência)
      try {
        return applyDelta(walletBefore, -differenceCents); // + cobra, − devolve; saldo nunca negativo, teto respeitado
      } catch (error) {
        if (error instanceof DomainError && error.code === "insufficient_balance") {
          throw conflict("insufficient_balance", "Saldo insuficiente para a diferença da troca: nada foi alterado.", { balanceCents: walletBefore.balanceCents, requiredCents: differenceCents });
        }
        throw error;
      }
    },
    orderPatch: () => ({
      items,
      // Total = valor LÍQUIDO pago pelo pedido (compra + diferenças das trocas): base do teto de reembolsos.
      totalCents: Number(order.data.totalCents) + differenceCents,
      itemCount: items.reduce((n, i) => n + i.quantity - exchangedOf(i), 0),
      exchangeCount: seq,
      lastExchangeId: p.exchangeId,
      status,
      version: order.version + 1,
      updatedAt: FieldValue.serverTimestamp(),
    }),
    commit(wallet) {
      const stamp = FieldValue.serverTimestamp();
      stock.commit();
      applyUsageDeltas(tx, db, studentId, usage, [...release, ...commitUsage]);
      if (evaluation?.override?.via === "exception" && ctx.exceptionRef) tx.update(ctx.exceptionRef, { status: "used", usedBy: p.actor.uid, usedFor: orderId, usedAt: stamp });
      if (wallet) {
        entryId = `${p.exchangeId}_diff`;
        tx.create(db.doc(`wallets/${studentId}/entries/${entryId}`), {
          type: "order_exchange",
          seq: wallet.version,
          amountCents: -differenceCents,
          balanceAfterCents: wallet.balanceCents,
          reason: `Troca de produto · pedido de ${order.consumptionDate}`,
          orderId,
          exchangeId: p.exchangeId,
          actorUid: p.actor.uid,
          actorRole: p.actor.role ?? null,
          referenceType: "order",
          referenceId: orderId,
          createdAt: stamp,
        });
        tx.set(walletRef, { studentId, currency: "BRL", balanceCents: wallet.balanceCents, version: wallet.version, updatedAt: stamp, ...(walletSnap.exists ? {} : { createdAt: stamp }) }, { merge: true });
      }
      tx.create(db.doc(`orders/${orderId}/exchanges/${p.exchangeId}`), {
        exchangeId: p.exchangeId,
        orderId,
        studentId,
        seq,
        removed: quote.removed,
        added: newItems.map((i) => ({ lineNo: i.lineNo, productId: i.productId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents, subtotalCents: i.subtotalCents })),
        creditCents,
        chargeCents,
        differenceCents,
        walletEntryId: entryId,
        walletSeq: wallet?.version ?? null,
        balanceAfterCents: wallet?.balanceCents ?? walletBefore.balanceCents,
        cutoffOverride: dest.cutoffPassed,
        override: evaluation?.override ?? null,
        reason: p.reason,
        actorUid: p.actor.uid,
        actorRole: p.actor.role ?? null,
        createdAt: stamp,
      });
      return { entryId };
    },
  };
}

/** Prévia da troca (só leitura, transação somente leitura): nada é gravado nem reservado. A confirmação recalcula tudo. */
export async function quoteExchange(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<ExchangeQuote> {
  authorize(actor, "orders.amend");
  const input = exchangeQuoteSchema.parse(raw);
  return db.runTransaction(
    async (tx) => {
      const now = clock();
      const today = localDateOf(now);
      const order = await readOrder(tx, db, input.orderId);
      assertExchangeable(order, today);
      return (await planExchange(db, tx, { order, actor, now, today, exchangeId: "quote", input, reason: "" })).quote;
    },
    { readOnly: true },
  );
}

export type ExchangeResult = {
  orderId: string;
  exchangeId: string;
  status: string;
  statusLabel: string;
  version: number;
  creditCents: number;
  chargeCents: number;
  differenceCents: number;
  cutoffOverride: boolean;
  /** Carteira ORIGINAL depois da diferença (null = diferença zero, sem lançamento). A tela reconcilia pela `version`. */
  wallet: { studentId: string; entryId: string; balanceCents: number; version: number } | null;
  items: { lineNo: number; quantity: number; deliveredQty: number; remainingQty: number }[];
};

/**
 * Troca de produtos (equipe, `orders.amend`, motivo obrigatório, diferença CONFIRMADA). Numa só transação: carteira e livro
 * (só a diferença), uso da F09, reservas/cotas, pedido (linhas antigas ganham `exchangedQty`; linhas novas com o preço do
 * servidor), evento imutável e auditoria. Saldo insuficiente, política, horário sem exceção ou diferença diferente da confirmada
 * recusam SEM efeito parcial. Entregas, cancelamentos e movimentos anteriores não são tocados.
 */
export async function exchangeItems(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<ExchangeResult & { replayed: boolean }> {
  authorize(actor, "orders.amend");
  const input = exchangeSchema.parse(raw);
  const exchangeId = deterministicId("xch", actor.uid, input.key);
  return runIdempotentCommand(db, actor, { scope: "orders.exchange", key: input.key, payload: input, allow: allowAmend }, async ({ tx, actor: current, auditId }) => {
    const now = clock();
    const today = localDateOf(now);
    const order = await readOrder(tx, db, input.orderId);
    assertExchangeable(order, today);
    const plan = await planExchange(db, tx, { order, actor: current, now, today, exchangeId, input, reason: input.reason });
    const wallet = plan.enforce({ overrideCutoff: input.overrideCutoff, expectedDifferenceCents: input.expectedDifferenceCents });
    const { entryId } = plan.commit(wallet);
    tx.update(order.ref, plan.orderPatch());
    const studentId = String(order.data.studentId);
    auditInTransaction(db, tx, auditId, {
      action: "orders.exchange",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "order", id: input.orderId },
      reason: input.reason,
      before: { status: order.status, totalCents: Number(order.data.totalCents), balanceCents: plan.quote.wallet.balanceCents },
      after: {
        status: plan.status,
        exchangeId,
        studentId,
        removed: plan.quote.removed.map((r) => ({ lineNo: r.lineNo, quantity: r.quantity, creditCents: r.creditCents })),
        added: plan.quote.added.map((a) => ({ productId: a.productId, quantity: a.quantity, subtotalCents: a.subtotalCents })),
        creditCents: plan.quote.creditCents,
        chargeCents: plan.quote.chargeCents,
        differenceCents: plan.quote.differenceCents,
        totalCents: Number(order.data.totalCents) + plan.quote.differenceCents,
        balanceCents: wallet?.balanceCents ?? plan.quote.wallet.balanceCents,
        walletEntryId: entryId,
        cutoffOverride: plan.quote.cutoffPassed,
        override: plan.evaluation?.override ?? null,
      },
    });
    return {
      orderId: input.orderId,
      exchangeId,
      status: plan.status,
      statusLabel: statusInfo(plan.status).label,
      version: order.version + 1,
      creditCents: plan.quote.creditCents,
      chargeCents: plan.quote.chargeCents,
      differenceCents: plan.quote.differenceCents,
      cutoffOverride: plan.quote.cutoffPassed,
      wallet: wallet && entryId ? { studentId, entryId, balanceCents: wallet.balanceCents, version: wallet.version } : null,
      items: itemsView(plan.items),
    };
  });
}

