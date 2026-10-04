import { FieldValue, type Firestore, type Timestamp } from "firebase-admin/firestore";
import { localDateOf } from "@/lib/dates/school-time";
import { conflict } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction, studentAccessRefs } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { openStockSession } from "@/modules/inventory/session";
import { releaseUsage } from "@/modules/policies/purchase-guard";
import { isCancellationOpen } from "@/modules/school/calendar";
import { applyDelta, parseWalletState } from "@/modules/wallet/model";
import {
  CANCELLED,
  aggregateStatus,
  canceledOf,
  cancelSchema,
  isNotPickedUp,
  isOpenStatus,
  refundValueOf,
  remainingOf,
  remainingValueOf,
  totalsOf,
} from "./fulfillment-model";
import { statusInfo } from "./history-model";
import type { OrderItem } from "./model";
import { itemsView, otherOrdersCovering, readOrder, sessionActor, type OrderState } from "./order-state";

/**
 * Cancelamento e reembolso (F14, docs/domains/cancellations.md §14). UM ponto de liquidação, `planCancellation`, usado pelo
 * cancelamento (família ou equipe) e pela resolução `cancel_refund` de não retirada (F13): numa só transação ele
 *   1. confere a quantidade ainda cancelável de cada linha (nunca o que já foi entregue, cancelado ou resolvido);
 *   2. calcula o reembolso pelo valor PAGO registrado no pedido (`subtotalCents`, rateado por acumulado: sem deriva de
 *      centavos, nunca o preço atual do produto) e confere que o acumulado reembolsado não passa do pago;
 *   3. libera a reserva/cota pelo `StockSession` (SEM entrada física) e o consumo da F09 (`releaseUsage`);
 *   4. opcionalmente registra perda EXPLÍCITA (descarte) das unidades indicadas, com custo e motivo, separada do dinheiro;
 *   5. credita a carteira ORIGINAL do aluno que pagou (`wallets/{studentId}` do pedido, mesmo com aluno arquivado, sem
 *      reativar cadastro) com UM lançamento `order_refund` no livro imutável e grava o evento imutável do cancelamento.
 * Todas as leituras acontecem antes de qualquer escrita; as escritas só saem em `commit()`. O chamador grava o progresso do
 * pedido (`orderPatch`: `canceledQty`, `status`, versão) e a auditoria na MESMA transação.
 */
export type CancelKind = "family" | "operational" | "not_picked_up";

export type CancelLine = { lineNo: number; productId: string; name: string; quantity: number; refundCents: number; usageCents: number };
export type CancelDiscard = { lineNo: number; productId: string; name: string; quantity: number; movementId: string };

export type CancelPlan = {
  cancellationId: string;
  seq: number;
  items: OrderItem[];
  lines: CancelLine[];
  canceledUnits: number;
  refundCents: number;
  discards: CancelDiscard[];
  discardedUnits: number;
  shortfallUnits: number;
  affectedOrders: string[];
  studentStatus: string | null;
  wallet: { studentId: string; entryId: string; seq: number; balanceCents: number; version: number; previousBalanceCents: number };
  /** Campos do pedido a gravar (progresso e situação), com a versão incrementada. */
  orderPatch(status: string): Record<string, unknown>;
  /** Todas as gravações do cancelamento, exceto pedido e auditoria (do chamador). */
  commit(): void;
};

const WHO: Record<CancelKind, string> = { family: "Cancelamento pelo responsável", operational: "Cancelamento pela escola", not_picked_up: "Não retirado cancelado pela escola" };
const ledgerReason = (kind: CancelKind, date: string) => `${WHO[kind]} · pedido de ${date}`;

export async function planCancellation(
  db: Firestore,
  tx: FirebaseFirestore.Transaction,
  p: { order: OrderState; actor: Actor; today: string; cancellationId: string; kind: CancelKind; reason: string; cancel: ReadonlyMap<number, number>; discards: ReadonlyMap<number, number> },
): Promise<CancelPlan> {
  const { order, actor, cancellationId, kind } = p;
  const studentId = String(order.data.studentId);
  const byLine = new Map(order.items.map((i) => [i.lineNo, i]));

  const lines: CancelLine[] = [];
  for (const [lineNo, quantity] of p.cancel) {
    const item = byLine.get(lineNo);
    if (!item) throw conflict("line_not_found", "Item não encontrado no pedido.", { lineNo });
    const remaining = remainingOf(item);
    if (remaining === 0) throw conflict("nothing_remaining", "Este item já foi entregue, cancelado ou resolvido: não há o que cancelar.", { lineNo });
    if (quantity > remaining) throw conflict("quantity_exceeds_remaining", "A quantidade supera o que ainda pode ser cancelado.", { lineNo, remaining, requested: quantity });
    const refundCents = refundValueOf(item, quantity);
    if (refundCents > remainingValueOf(item)) throw new Error("Invariante violada: reembolso acima do valor ainda reembolsável da linha.");
    lines.push({ lineNo, productId: item.productId, name: item.name, quantity, refundCents, usageCents: item.unitPriceCents * quantity });
  }
  if (lines.length === 0) throw conflict("nothing_remaining", "Não há unidades a cancelar.");
  for (const [lineNo, quantity] of p.discards) {
    const canceling = p.cancel.get(lineNo) ?? 0;
    if (quantity > canceling) throw conflict("discard_exceeds_canceled", "O descarte supera a quantidade cancelada do item.", { lineNo, canceled: canceling, requested: quantity });
  }
  const refundCents = lines.reduce((n, l) => n + l.refundCents, 0);
  const canceledUnits = lines.reduce((n, l) => n + l.quantity, 0);
  const alreadyRefunded = Number(order.data.refundedCents ?? 0);
  if (refundCents < 1) throw new Error("Invariante violada: reembolso sem valor.");
  if (alreadyRefunded + refundCents > Number(order.data.totalCents)) throw new Error("Invariante violada: reembolsos acumulados acima do valor pago.");

  // Leituras (nenhuma escrita antes do fim delas): carteira ORIGINAL do pedido, cadastro do aluno, estoque e uso.
  const walletRef = db.doc(`wallets/${studentId}`);
  const snaps = await tx.getAll(walletRef, db.doc(`students/${studentId}`));
  const walletSnap = snaps[0]!;
  const studentSnap = snaps[1]!;
  const stock = openStockSession(db, tx, { today: p.today, actor: sessionActor(actor) });
  for (const l of lines) {
    const item = byLine.get(l.lineNo)!;
    await stock.release({ productId: l.productId, reservationId: item.reservationId, quantity: l.quantity, orderRef: order.ref.id });
  }
  const writeUsage = await releaseUsage(db, tx, studentId, lines.map((l) => ({ consumptionDate: order.consumptionDate, amountCents: l.usageCents })));

  const discards: CancelDiscard[] = [];
  let shortfallUnits = 0;
  const affected = new Set<string>();
  for (const [lineNo, quantity] of p.discards) {
    const item = byLine.get(lineNo)!;
    const loss = await stock.removeUnits({
      productId: item.productId,
      quantity,
      type: "loss",
      reason: `Descarte após cancelamento: ${p.reason}`,
      reasonCode: "discard",
      referenceType: "order",
      referenceId: order.ref.id,
    });
    discards.push({ lineNo, productId: item.productId, name: item.name, quantity, movementId: loss.movementId });
    shortfallUnits += loss.shortfallUnits;
    if (loss.shortfallUnits > 0) for (const ref of await otherOrdersCovering(db, tx, item.productId, order.ref.id, loss.shortfallUnits)) affected.add(ref);
  }

  const before = parseWalletState(walletSnap.data());
  const after = applyDelta(before, refundCents); // + : respeita o teto de saldo; falha aborta tudo
  const entryId = `${cancellationId}_refund`;
  const canceling = new Map(lines.map((l) => [l.lineNo, l.quantity]));
  const items = order.items.map((i) => (canceling.has(i.lineNo) ? { ...i, canceledQty: canceledOf(i) + canceling.get(i.lineNo)! } : i));
  const seq = Number(order.data.cancelCount ?? 0) + 1;
  const studentStatus = studentSnap.exists ? String(studentSnap.get("status") ?? "") : null;

  return {
    cancellationId,
    seq,
    items,
    lines,
    canceledUnits,
    refundCents,
    discards,
    discardedUnits: discards.reduce((n, d) => n + d.quantity, 0),
    shortfallUnits,
    affectedOrders: [...affected],
    studentStatus,
    wallet: { studentId, entryId, seq: after.version, balanceCents: after.balanceCents, version: after.version, previousBalanceCents: before.balanceCents },
    orderPatch: (status) => ({
      items,
      canceledQty: totalsOf(items).canceled,
      refundedCents: alreadyRefunded + refundCents,
      cancelCount: seq,
      lastCancellationId: cancellationId,
      status,
      version: order.version + 1,
      updatedAt: FieldValue.serverTimestamp(),
      ...(status === CANCELLED ? { canceledAt: FieldValue.serverTimestamp() } : {}),
    }),
    commit() {
      const stamp = FieldValue.serverTimestamp();
      stock.commit();
      writeUsage();
      tx.create(db.doc(`wallets/${studentId}/entries/${entryId}`), {
        type: "order_refund",
        seq: after.version,
        amountCents: refundCents,
        balanceAfterCents: after.balanceCents,
        reason: ledgerReason(kind, order.consumptionDate),
        orderId: order.ref.id,
        cancellationId,
        actorUid: actor.uid,
        actorRole: actor.role ?? null,
        referenceType: "order",
        referenceId: order.ref.id,
        createdAt: stamp,
      });
      tx.set(walletRef, { studentId, currency: "BRL", balanceCents: after.balanceCents, version: after.version, updatedAt: stamp, ...(walletSnap.exists ? {} : { createdAt: stamp }) }, { merge: true });
      tx.create(db.doc(`orders/${order.ref.id}/cancellations/${cancellationId}`), {
        cancellationId,
        orderId: order.ref.id,
        studentId,
        seq,
        kind,
        lines: lines.map((l) => ({ lineNo: l.lineNo, productId: l.productId, name: l.name, quantity: l.quantity, refundCents: l.refundCents })),
        canceledUnits,
        refundCents,
        walletEntryId: entryId,
        walletSeq: after.version,
        balanceAfterCents: after.balanceCents,
        discards,
        reason: p.reason,
        studentStatus,
        actorUid: actor.uid,
        actorRole: actor.role ?? null,
        createdAt: stamp,
      });
    },
  };
}

/* --------------------------------------------------------------------------------------------- comando */

export type CancelResult = {
  orderId: string;
  cancellationId: string;
  kind: CancelKind;
  status: string;
  statusLabel: string;
  version: number;
  canceled: { lineNo: number; quantity: number; refundCents: number }[];
  canceledUnits: number;
  refundCents: number;
  items: { lineNo: number; quantity: number; deliveredQty: number; remainingQty: number }[];
  remainingUnits: number;
  /** Carteira ORIGINAL depois do reembolso: a tela reconcilia pela `version` do servidor (nunca pelo listener). */
  wallet: { studentId: string; entryId: string; seq: number; balanceCents: number; version: number };
  discardedUnits: number;
  /** Só para quem descartou: unidades de OUTROS pedidos que ficaram sem lastro físico e os pedidos a tratar. */
  shortfallUnits: number;
  affectedOrders: string[];
};

const allowCancel = (p: { role: Actor["role"]; permissions: readonly string[] }) => p.role === "guardian" || can(p, "orders.cancel");

const asDate = (value: unknown): Date | null => (value && typeof (value as Timestamp).toDate === "function" ? (value as Timestamp).toDate() : null);

/**
 * Cancelamento total ou parcial das quantidades REMANESCENTES de um pedido antecipado.
 *  - Responsável (vínculo ativo atual): só até o prazo salvo no pedido (`policy.cancelCutoffAt`: `agora >= limite` = encerrado,
 *    mudar o calendário depois não altera o prazo já informado), nunca o já entregue, sem descarte.
 *  - Cantina/administração (`orders.cancel`): excepcional, também depois do prazo, SEMPRE com motivo; descarte só com `inventory.loss`.
 *  - Aluno não cancela; pedido "não retirado" só pela resolução da administração (`cancel_refund`).
 * Mesma chave + mesmo payload devolve a resposta original (reautorizando o vínculo atual); outra chave sobre o mesmo
 * restante recusa (nada a cancelar), então resposta perdida, clique duplo e dois cancelamentos simultâneos não creditam duas vezes.
 */
export async function cancelOrder(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<CancelResult & { replayed: boolean }> {
  const input = cancelSchema.parse(raw);
  const cancellationId = deterministicId("can", actor.uid, input.key);

  /** Família: o pedido precisa ser de um aluno com vínculo ATIVO agora. Pedido inexistente e de outra família respondem igual. */
  const assertGuardian = async (tx: FirebaseFirestore.Transaction, current: Actor, data: FirebaseFirestore.DocumentData | undefined) => {
    const studentId = data?.studentId;
    if (typeof studentId !== "string") throw new ForbiddenError("Sem acesso ao pedido.");
    const [student, link, policy] = await tx.getAll(...studentAccessRefs(db, current, studentId));
    if (!decideStudentAction({ actor: current, studentId, action: "orders.cancel", student: student?.data(), link: link?.data(), policy: policy?.data() })) throw new ForbiddenError("Sem acesso ao pedido.");
  };

  return runIdempotentCommand(
    db,
    actor,
    {
      scope: "orders.cancel",
      key: input.key,
      payload: input,
      allow: allowCancel,
      revalidateReplay: async ({ tx, actor: current }) => {
        if (current.role !== "guardian") return;
        await assertGuardian(tx, current, (await tx.get(db.doc(`orders/${input.orderId}`))).data());
      },
    },
    async ({ tx, actor: current, auditId }) => {
      const now = clock();
      const today = localDateOf(now);
      const guardian = current.role === "guardian";
      const kind: CancelKind = guardian ? "family" : "operational";
      if (guardian && input.discards.length > 0) throw new ForbiddenError("Descarte é só da equipe.");
      if (!guardian && input.discards.length > 0 && !can(current, "inventory.loss")) throw new ForbiddenError("Sem permissão: inventory.loss.");

      const order = await readOrder(tx, db, input.orderId, guardian ? (data) => assertGuardian(tx, current, data) : undefined).catch((error) => {
        if (guardian && (error as { code?: string }).code === "order_not_found") throw new ForbiddenError("Sem acesso ao pedido.");
        throw error;
      });

      if (order.status === CANCELLED) throw conflict("already_cancelled", "O pedido já foi cancelado.");
      if (order.status === "delivered") throw conflict("already_delivered", "Pedido entregue não pode ser cancelado: a correção é um fluxo de estorno da administração.");
      if (order.status === "not_picked_up") throw conflict("use_resolution", "Pedido não retirado: a administração decide em “Resolver” (cancelar e reembolsar, encerrar com cobrança ou reagendar).", { status: order.status });
      if (isNotPickedUp(order.status)) throw conflict("already_resolved", "Este pedido já foi resolvido.", { status: order.status });
      if (!isOpenStatus(order.status)) throw conflict("order_not_cancelable", "A situação atual do pedido não permite cancelar.", { status: order.status });

      if (guardian) {
        const cutoff = asDate((order.data.policy as { cancelCutoffAt?: unknown } | undefined)?.cancelCutoffAt);
        if (!cutoff) throw conflict("cancel_deadline_unknown", "O prazo de cancelamento deste pedido não está registrado: fale com a escola.");
        if (!isCancellationOpen(now, { cancelCutoffAt: cutoff })) throw conflict("cancel_deadline_passed", "O prazo para cancelar este pedido terminou: fale com a escola.", { cancelCutoffAt: cutoff.toISOString() });
      }

      const byLine = new Map(order.items.map((i) => [i.lineNo, i]));
      const cancel = new Map<number, number>();
      if (input.lines) for (const l of input.lines) cancel.set(l.lineNo, l.quantity);
      else for (const i of order.items) if (remainingOf(i) > 0) cancel.set(i.lineNo, remainingOf(i));
      if (cancel.size === 0) throw conflict("nothing_remaining", "Não há unidades a cancelar.");
      for (const lineNo of cancel.keys()) if (!byLine.has(lineNo)) throw conflict("line_not_found", "Item não encontrado no pedido.", { lineNo });

      const plan = await planCancellation(db, tx, { order, actor: current, today, cancellationId, kind, reason: input.reason, cancel, discards: new Map(input.discards.map((d) => [d.lineNo, d.quantity])) });
      const status = aggregateStatus({ items: plan.items, prep: order.prep, nonPickup: null });
      plan.commit();
      tx.update(order.ref, plan.orderPatch(status));
      auditInTransaction(db, tx, auditId, {
        action: "orders.cancel",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        target: { type: "order", id: input.orderId },
        reason: input.reason,
        before: { status: order.status, refundedCents: Number(order.data.refundedCents ?? 0), balanceCents: plan.wallet.previousBalanceCents },
        after: {
          status,
          kind,
          cancellationId,
          studentId: plan.wallet.studentId,
          studentStatus: plan.studentStatus,
          refundCents: plan.refundCents,
          refundedCents: Number(order.data.refundedCents ?? 0) + plan.refundCents,
          balanceCents: plan.wallet.balanceCents,
          walletEntryId: plan.wallet.entryId,
          lines: plan.lines.map((l) => ({ lineNo: l.lineNo, quantity: l.quantity, refundCents: l.refundCents })),
          discards: plan.discards.map((d) => ({ lineNo: d.lineNo, quantity: d.quantity, movementId: d.movementId })),
          shortfallUnits: plan.shortfallUnits,
          affectedOrders: plan.affectedOrders,
        },
      });
      return {
        orderId: input.orderId,
        cancellationId,
        kind,
        status,
        statusLabel: statusInfo(status).label,
        version: order.version + 1,
        canceled: plan.lines.map((l) => ({ lineNo: l.lineNo, quantity: l.quantity, refundCents: l.refundCents })),
        canceledUnits: plan.canceledUnits,
        refundCents: plan.refundCents,
        items: itemsView(plan.items),
        remainingUnits: totalsOf(plan.items).remaining,
        wallet: { studentId: plan.wallet.studentId, entryId: plan.wallet.entryId, seq: plan.wallet.seq, balanceCents: plan.wallet.balanceCents, version: plan.wallet.version },
        discardedUnits: plan.discardedUnits,
        shortfallUnits: plan.shortfallUnits,
        affectedOrders: plan.affectedOrders,
      };
    },
  );
}
