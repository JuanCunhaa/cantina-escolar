import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { localDateOf, type LocalDate } from "@/lib/dates/school-time";
import { conflict, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction, studentAccessRefs, authorize } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { openStockSession } from "@/modules/inventory/session";
import { readMenuForSale } from "@/modules/menu/queries";
import { priceChanges, reviewedCart, subtotalOf, totalOf, type ResolvedLine } from "@/modules/orders/model";
import { commitPurchaseUsage, decidePurchase, readPurchaseGuard } from "@/modules/policies/purchase-guard";
import { checkCounterDay } from "@/modules/school/settings";
import { applyDelta, assertCanSpend, parseWalletState } from "@/modules/wallet/model";
import { counterReason, counterSaleSchema, directSaleSchema, feeRecordOf, type CounterItem, type FeeRecord, type PaymentMethod } from "./model";

/**
 * Comandos do PDV (F15, docs/domains/pos.md §13). Ambos: servidor autenticado, perfil ATUAL relido na transação com
 * `pos.operate` (`runIdempotentCommand`), idempotentes por chave + payload, leituras antes das escritas e SEM chamada
 * externa dentro do callback. A data da venda é SEMPRE a de hoje no relógio do servidor (America/Sao_Paulo) e o preço é o
 * ATUAL do servidor (o `expectedPriceCents` do operador só detecta mudança). O horário de fechamento da compra antecipada
 * não se aplica ao balcão (docs/domains/calendar.md); valem o dia de funcionamento, o cardápio, as permissões e o estoque.
 *
 * Estoque: `StockSession.exit` SEM reserva = venda de balcão. Ela só vende o que não está reservado para outros pedidos
 * (`insufficient_stock`/`entry_required`) e grava custo médio histórico no movimento (nunca na resposta). O balcão não
 * consome cota/limite do cardápio dos pedidos antecipados: o teto da venda direta é o estoque físico elegível.
 */
const allowPos = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "pos.operate");

export type SoldLineView = { lineNo: number; productId: string; name: string; quantity: number; unitPriceCents: number; subtotalCents: number };
const soldView = (items: readonly CounterItem[]): SoldLineView[] =>
  items.map((i) => ({ lineNo: i.lineNo, productId: i.productId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents, subtotalCents: i.subtotalCents }));

/** Linhas resolvidas pelo servidor (preço, categoria e nome ATUAIS) + revisão de preço do operador. */
function resolveLines(
  date: LocalDate,
  lines: readonly { productId: string; quantity: number; expectedPriceCents: number }[],
  menu: Awaited<ReturnType<typeof readMenuForSale>>,
) {
  const prepared = lines.map((line) => {
    const sale = menu.get(line.productId);
    if (!sale?.ok) throw conflict("item_unavailable", "Produto indisponível no balcão hoje.", { date, productId: line.productId, reason: sale?.reason ?? "product_not_found" });
    return { ...line, product: sale.product, source: sale.source };
  });
  const resolved: ResolvedLine[] = prepared.map((l) => ({ date, productId: l.productId, name: l.product.name, quantity: l.quantity, expectedPriceCents: l.expectedPriceCents, currentPriceCents: l.product.priceCents }));
  const changes = priceChanges(resolved);
  if (changes.length > 0) throw conflict("price_changed", "Preços mudaram: revise o novo total e confirme de novo.", { changes, cart: reviewedCart(resolved) });
  return prepared;
}

/* ------------------------------------------------------------------------------------------ venda com saldo */

export type CounterSaleResult = {
  orderId: string;
  studentId: string;
  studentName: string;
  consumptionDate: LocalDate;
  shiftId: string;
  status: "delivered";
  totalCents: number;
  itemCount: number;
  items: SoldLineView[];
  walletEntryId: string | null;
  /** Posição do débito no livro = versão da carteira depois dele. */
  walletSeq: number;
  /** Estado da carteira DEPOIS da venda (a tela reconcilia pela `version`, nunca por listener). */
  wallet: { studentId: string; balanceCents: number; version: number };
  override: { via: "exception"; exceptionId: string; kind: "guardian" | "admin" } | null;
};

/**
 * Venda de balcão com o saldo da carteira do ALUNO, numa única transação idempotente:
 *   1. operador (perfil atual) e aluno (ativo; permissão de balcão atual; turno conferido);
 *   2. dia de funcionamento, cardápio de hoje (canal balcão) e preço atual do servidor — preço diferente do que o operador
 *      viu recusa tudo (`price_changed`) para nova revisão;
 *   3. guard da F09 (bloqueios, limites diário/semanal do dia de hoje; sem confirmação do responsável: o funcionário só
 *      supera restrição com exceção registrada);
 *   4. saldo suficiente e saída física pelo `StockSession` (reservas de outros pedidos intocadas);
 *   5. gravações: carteira + UM lançamento `counter_purchase`, pedido `channel: "counter"` já ENTREGUE com snapshots,
 *      entrega, uso do dia/semana (+ exceção usada), baixa de estoque/custo e auditoria.
 * Recusa antes do commit = nada gravado (nem a chave). Mesma chave + mesmo payload devolve a resposta original.
 */
export async function placeCounterSale(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<CounterSaleResult & { replayed: boolean }> {
  authorize(actor, "pos.operate");
  const input = counterSaleSchema.parse(raw);
  const { studentId } = input;
  const orderId = deterministicId("cnt", actor.uid, input.key);
  const deliveryId = deterministicId("dlv", actor.uid, "pos", input.key);
  const entryId = `${orderId}_pay`;

  return runIdempotentCommand(db, actor, { scope: "pos.sale", key: input.key, payload: input, allow: allowPos }, async ({ tx, actor: current, auditId }) => {
    const now = clock();
    const today = localDateOf(now);

    // 1. Aluno e permissão ATUAIS (toda leitura antes de qualquer escrita).
    const [student, link, policy] = await tx.getAll(...studentAccessRefs(db, current, studentId));
    if (!student?.exists) throw notFound("student_not_found", "Aluno não encontrado.");
    if (student.get("status") !== "active") throw conflict("student_inactive", "Aluno inativo.");
    const base = { actor: current, studentId, student: student.data(), link: link?.data(), policy: policy?.data() };
    if (!decideStudentAction({ ...base, action: "purchase.counter" })) throw new ForbiddenError("Compra no balcão não permitida para este aluno.");
    const shiftId = String(student.get("shiftId") ?? "");
    if (shiftId !== input.expectedShiftId) throw conflict("shift_changed", "O turno do aluno mudou: revise a venda.", { shiftId });

    // 2. Funcionamento, cardápio de hoje no canal balcão e preços do servidor.
    const [day, menu] = await Promise.all([
      checkCounterDay(db, { shiftId, date: today }, tx),
      readMenuForSale(db, tx, { date: today, shiftId, channel: "counter", productIds: input.lines.map((l) => l.productId) }),
    ]);
    if (!day.allowed) throw conflict(day.reason, undefined, { date: today });
    const prepared = resolveLines(today, input.lines, menu);

    // 3. Política do responsável (mesmo guard do checkout), com os valores do SERVIDOR.
    const guard = await readPurchaseGuard(db, tx, current, {
      studentId,
      channel: "counter",
      exceptionId: input.exceptionId,
      lines: prepared.map((l) => ({ consumptionDate: today, productId: l.product.id, categoryId: l.product.categoryId, amountCents: subtotalOf(l.product.priceCents, l.quantity) })),
    });
    const evaluation = decidePurchase(guard);
    if (!evaluation.allowed) {
      if (!guard.permitted) throw new ForbiddenError("Compra no balcão não permitida para este aluno.");
      throw conflict("policy_denied", "A compra não é permitida pela política do aluno.", { violations: evaluation.violations, days: evaluation.days, weeks: evaluation.weeks, totalCents: evaluation.totalCents });
    }

    // 4. Saldo e saída de estoque (planejamento só LÊ; falha = nada gravado).
    const walletRef = db.doc(`wallets/${studentId}`);
    const walletSnap = await tx.get(walletRef);
    const walletBefore = parseWalletState(walletSnap.data());
    assertCanSpend(walletSnap.data()); // pendência de reversão externa (F19) bloqueia nova compra
    const items: CounterItem[] = prepared.map((l, index) => ({
      lineNo: index + 1,
      productId: l.product.id,
      name: l.product.name,
      categoryId: l.product.categoryId,
      unit: "un",
      quantity: l.quantity,
      unitPriceCents: l.product.priceCents,
      priceVersion: l.product.priceVersion,
      discountCents: 0,
      subtotalCents: subtotalOf(l.product.priceCents, l.quantity),
      source: l.source,
      deliveredQty: l.quantity,
    }));
    const totalCents = totalOf(items);
    if (totalCents > walletBefore.balanceCents) throw conflict("insufficient_balance", "Saldo insuficiente na carteira do aluno.", { balanceCents: walletBefore.balanceCents, requiredCents: totalCents });
    const stock = openStockSession(db, tx, { today, actor: { uid: current.uid, role: current.role ?? null } });
    const movements: { lineNo: number; productId: string; name: string; quantity: number; movementId: string; movementSeq: number }[] = [];
    for (const item of items) {
      const exit = await stock.exit({ productId: item.productId, quantity: item.quantity, consumptionDate: today, referenceType: "order", referenceId: orderId, revenueCents: item.subtotalCents });
      movements.push({ lineNo: item.lineNo, productId: item.productId, name: item.name, quantity: item.quantity, movementId: exit.movementId, movementSeq: exit.seq });
    }
    const wallet = applyDelta(walletBefore, -totalCents);

    // 5. Gravações (nenhuma leitura depois daqui).
    const stamp = FieldValue.serverTimestamp();
    const itemCount = items.reduce((n, i) => n + i.quantity, 0);
    tx.create(db.doc(`wallets/${studentId}/entries/${entryId}`), {
      type: "counter_purchase",
      seq: wallet.version,
      amountCents: -totalCents,
      balanceAfterCents: wallet.balanceCents,
      reason: counterReason(today),
      orderId,
      actorUid: current.uid,
      actorRole: current.role ?? null,
      referenceType: "order",
      referenceId: orderId,
      createdAt: stamp,
    });
    tx.create(db.doc(`orders/${orderId}`), {
      orderId,
      channel: "counter",
      status: "delivered",
      studentId,
      studentName: String(student.get("name") ?? ""),
      studentVersion: Number(student.get("version") ?? 0),
      consumptionDate: today,
      shiftId,
      items,
      itemCount,
      totalCents,
      deliveredQty: itemCount,
      deliveryCount: 1,
      lastDeliveryId: deliveryId,
      deliveredAt: stamp,
      walletEntryId: entryId,
      walletSeq: wallet.version,
      createdByUid: current.uid,
      createdByRole: current.role ?? null,
      override: evaluation.override,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    tx.create(db.doc(`orders/${orderId}/deliveries/${deliveryId}`), {
      deliveryId,
      orderId,
      studentId,
      seq: 1,
      lines: movements,
      totalUnits: itemCount,
      actorUid: current.uid,
      actorRole: current.role ?? null,
      createdAt: stamp,
    });
    stock.commit();
    commitPurchaseUsage(db, tx, current, guard, evaluation, orderId);
    tx.set(walletRef, { studentId, currency: "BRL", balanceCents: wallet.balanceCents, version: wallet.version, updatedAt: stamp, ...(walletSnap.exists ? {} : { createdAt: stamp }) }, { merge: true });
    auditInTransaction(db, tx, auditId, {
      action: "pos.counter_sale",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "order", id: orderId },
      before: { balanceCents: walletBefore.balanceCents },
      after: { balanceCents: wallet.balanceCents, totalCents, studentId, consumptionDate: today, lines: movements.map((m) => ({ lineNo: m.lineNo, quantity: m.quantity, movementId: m.movementId })), override: evaluation.override },
    });
    return {
      orderId,
      studentId,
      studentName: String(student.get("name") ?? ""),
      consumptionDate: today,
      shiftId,
      status: "delivered" as const,
      totalCents,
      itemCount,
      items: soldView(items),
      walletEntryId: entryId,
      walletSeq: wallet.version,
      wallet: { studentId, balanceCents: wallet.balanceCents, version: wallet.version },
      override: evaluation.override?.via === "exception" ? evaluation.override : null,
    };
  });
}

/* ------------------------------------------------------------------------------------------- venda direta */

export type DirectSaleResult = {
  saleId: string;
  consumptionDate: LocalDate;
  shiftId: string;
  paymentMethod: PaymentMethod;
  totalCents: number;
  itemCount: number;
  items: SoldLineView[];
  fee: FeeRecord;
  /** Recebimento líquido (total − taxa) quando a taxa é conhecida; `null` com taxa pendente de conferência. */
  netCents: number | null;
};

/**
 * Venda direta SEM aluno (professor/funcionário), registrada somente depois do recebimento local confirmado
 * (`receivedConfirmed: true`, meio de pagamento obrigatório). Mesmo calendário, cardápio, preço e controle de estoque/custo
 * do balcão, num lançamento SEPARADO (`directSales/{id}`): não existe carteira, livro nem uso de responsável aqui, então o
 * recebimento externo é contado uma única vez. Sem integração com provedores de pagamento nesta etapa.
 */
export async function recordDirectSale(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<DirectSaleResult & { replayed: boolean }> {
  authorize(actor, "pos.operate");
  const input = directSaleSchema.parse(raw);
  const saleId = deterministicId("dsl", actor.uid, input.key);

  return runIdempotentCommand(db, actor, { scope: "pos.direct_sale", key: input.key, payload: input, allow: allowPos }, async ({ tx, actor: current, auditId }) => {
    const today = localDateOf(clock());
    const { shiftId } = input;
    const [day, menu] = await Promise.all([
      checkCounterDay(db, { shiftId, date: today }, tx),
      readMenuForSale(db, tx, { date: today, shiftId, channel: "counter", productIds: input.lines.map((l) => l.productId) }),
    ]);
    if (!day.allowed) throw conflict(day.reason, undefined, { date: today });
    const prepared = resolveLines(today, input.lines, menu);
    const items: CounterItem[] = prepared.map((l, index) => ({
      lineNo: index + 1,
      productId: l.product.id,
      name: l.product.name,
      categoryId: l.product.categoryId,
      unit: "un",
      quantity: l.quantity,
      unitPriceCents: l.product.priceCents,
      priceVersion: l.product.priceVersion,
      discountCents: 0,
      subtotalCents: subtotalOf(l.product.priceCents, l.quantity),
      source: l.source,
      deliveredQty: l.quantity,
    }));
    const totalCents = totalOf(items);
    // Regras da taxa juntas e antes de qualquer valor derivado: dinheiro não tem taxa de meio (0 é aceito) e a taxa não passa do total.
    if (input.paymentMethod === "cash" && input.feeCents) throw conflict("invalid_fee", "Dinheiro não tem taxa de meio de pagamento.", { feeCents: input.feeCents });
    if (input.feeCents !== undefined && input.feeCents > totalCents) throw conflict("invalid_fee", "A taxa não pode superar o valor da venda.", { totalCents, feeCents: input.feeCents });
    const fee = feeRecordOf(input.paymentMethod, input.paymentMethod === "cash" ? undefined : input.feeCents);

    const stock = openStockSession(db, tx, { today, actor: { uid: current.uid, role: current.role ?? null } });
    const movements: { lineNo: number; productId: string; name: string; quantity: number; movementId: string; movementSeq: number }[] = [];
    for (const item of items) {
      const exit = await stock.exit({ productId: item.productId, quantity: item.quantity, consumptionDate: today, referenceType: "directSale", referenceId: saleId, revenueCents: item.subtotalCents });
      movements.push({ lineNo: item.lineNo, productId: item.productId, name: item.name, quantity: item.quantity, movementId: exit.movementId, movementSeq: exit.seq });
    }

    const stamp = FieldValue.serverTimestamp();
    const itemCount = items.reduce((n, i) => n + i.quantity, 0);
    const netCents = fee.cents === null ? null : totalCents - fee.cents;
    tx.create(db.doc(`directSales/${saleId}`), {
      saleId,
      channel: "counter_direct",
      status: "completed",
      consumptionDate: today,
      shiftId,
      items,
      itemCount,
      totalCents,
      payment: { method: input.paymentMethod, receivedCents: totalCents, receivedConfirmed: true, fee, netCents },
      buyerKind: input.buyerKind,
      buyerNote: input.buyerNote ?? null,
      movements,
      createdByUid: current.uid,
      createdByRole: current.role ?? null,
      version: 1,
      createdAt: stamp,
    });
    stock.commit();
    auditInTransaction(db, tx, auditId, {
      action: "pos.direct_sale",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "directSale", id: saleId },
      after: { totalCents, paymentMethod: input.paymentMethod, fee, consumptionDate: today, lines: movements.map((m) => ({ lineNo: m.lineNo, quantity: m.quantity, movementId: m.movementId })) },
    });
    return { saleId, consumptionDate: today, shiftId, paymentMethod: input.paymentMethod, totalCents, itemCount, items: soldView(items), fee, netCents };
  });
}
