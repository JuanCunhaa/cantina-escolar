import { FieldValue, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore";
import { localDateOf, type LocalDate } from "@/lib/dates/school-time";
import { conflict } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction, studentAccessRefs } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { auditInTransaction } from "@/modules/audit/log";
import { openStockSession } from "@/modules/inventory/session";
import { readMenuForSale } from "@/modules/menu/queries";
import { commitPurchaseUsage, decidePurchase, readPurchaseGuard } from "@/modules/policies/purchase-guard";
import { checkPurchase } from "@/modules/school/settings";
import type { PolicySnapshot } from "@/modules/school/calendar";
import { applyDelta, parseWalletState } from "@/modules/wallet/model";
import { checkoutSchema, priceChanges, reviewedCart, subtotalOf, totalOf, type OrderItem, type OrderStatus, type ResolvedLine } from "./model";

export type CheckoutOrder = {
  orderId: string;
  consumptionDate: LocalDate;
  shiftId: string;
  status: OrderStatus;
  totalCents: number;
  itemCount: number;
  items: OrderItem[];
  walletEntryId: string;
  /** Posição do pagamento no livro da carteira = versão da carteira depois dele. */
  walletSeq: number;
  /** Instantes UTC (ISO) gravados no pedido: prazo de cancelamento familiar já informado, estável. */
  purchaseCutoffAt: string;
  cancelCutoffAt: string;
};
export type CheckoutResult = {
  batchId: string;
  studentId: string;
  shiftId: string;
  totalCents: number;
  orders: CheckoutOrder[];
  /** Estado da carteira DEPOIS do lote: a tela reconcilia pela `version` do servidor (nunca pelo listener). */
  wallet: { studentId: string; balanceCents: number; version: number };
  override: { via: "guardian_confirmation" } | { via: "exception"; exceptionId: string; kind: "guardian" | "admin" } | null;
};

const batchIdOf = (uid: string, key: string): string => deterministicId("bat", uid, key);
const orderIdOf = (uid: string, key: string, date: LocalDate): string => deterministicId("ord", uid, key, date);
const reservationIdOf = (orderId: string, lineNo: number): string => `${orderId}_r${lineNo}`;
const paymentEntryIdOf = (orderId: string): string => `${orderId}_pay`;

/** Vínculo/perfil/política ATUAIS: aluno visível ao ator, ativo e com compra pelo site liberada. */
function assertMayPurchase(actor: Actor, studentId: string, [student, link, policy]: DocumentSnapshot[]): void {
  const base = { actor, studentId, student: student?.data(), link: link?.data(), policy: policy?.data() };
  if (!decideStudentAction({ ...base, action: "view" })) throw new ForbiddenError("Sem acesso ao aluno.");
  if (student?.get("status") !== "active") throw conflict("student_inactive", "Aluno inativo.");
  if (!decideStudentAction({ ...base, action: "purchase.site" })) throw new ForbiddenError("Compra pelo site não permitida.");
}

/**
 * Checkout antecipado (docs/domains/checkout.md): confirma o carrinho de UM aluno para uma ou mais datas (lote
 * TUDO-OU-NADA, até `MAX_BATCH_DATES` datas) e cria um pedido PAGO por data. Numa única transação idempotente:
 *
 *   1. autorização com perfil, vínculo e permissão de compra ATUAIS; turno e status vêm do cadastro atual do aluno;
 *   2. por data: calendário/janela/horário de corte do servidor (F05) e cardápio/produto/preço atuais (F06/F07);
 *   3. preço: se qualquer preço atual difere do que o cliente viu, NADA é cobrado — a recusa `price_changed` devolve o
 *      carrinho com os preços do servidor para nova revisão e confirmação (o cliente nunca define o valor cobrado);
 *   4. guard da F09 (permissão, bloqueios, limite diário/semanal por data de consumo, exceção/confirmação);
 *   5. reservas e cotas pelo `StockSession` da F10 (reserva NÃO é saída física) e o saldo da carteira;
 *   6. só então as gravações: estoque/cotas, uso diário/semanal (+ exceção usada), carteira, UM lançamento de débito
 *      por pedido (livro imutável), os pedidos com snapshots e a auditoria.
 *
 * Qualquer recusa antes do commit deixa tudo sem efeito (nada é gravado, nem a chave de idempotência). Mesma chave +
 * mesmo payload devolve a resposta original (`replayed`) depois de reautorizar com o vínculo atual; mesma chave com
 * payload diferente é conflito. Não há chamada externa dentro do callback (a transação pode reexecutar), por isso o
 * relógio é lido a cada tentativa e todos os IDs derivam de ator + chave + data.
 */
export async function placeAdvanceOrders(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<CheckoutResult & { replayed: boolean }> {
  const input = checkoutSchema.parse(raw);
  const { studentId } = input;
  const batchId = batchIdOf(actor.uid, input.key);

  return runIdempotentCommand(
    db,
    actor,
    {
      scope: "orders.checkout",
      key: input.key,
      payload: input,
      allow: (p) => p.role === "guardian" || p.role === "student",
      revalidateReplay: async ({ tx, actor: current }) => assertMayPurchase(current, studentId, await tx.getAll(...studentAccessRefs(db, current, studentId))),
    },
    async ({ tx, actor: current, auditId }) => {
      const now = clock();
      const today = localDateOf(now);

      // 1. Autorização atual e dados do aluno (todas as leituras antes de qualquer escrita).
      const access = await tx.getAll(...studentAccessRefs(db, current, studentId));
      assertMayPurchase(current, studentId, access);
      const studentDoc = access[0]!;
      const shiftId = String(studentDoc.get("shiftId") ?? "");
      if (shiftId !== input.expectedShiftId) throw conflict("shift_changed", "O turno do aluno mudou: revise o carrinho.", { shiftId });

      // 2. Calendário, horário, cardápio e preços do servidor, por data.
      const perDay = await Promise.all(
        input.days.map(async (day) => {
          const [check, menu] = await Promise.all([
            checkPurchase(db, { shiftId, date: day.date, now }, tx),
            readMenuForSale(db, tx, { date: day.date, shiftId, channel: "advance", productIds: day.lines.map((l) => l.productId) }),
          ]);
          return { day, check, menu };
        }),
      );
      const prepared = perDay.map(({ day, check, menu }) => {
        if (!check.allowed) throw conflict(check.reason, undefined, { date: day.date });
        const lines = day.lines.map((line) => {
          const sale = menu.get(line.productId);
          if (!sale?.ok) throw conflict("item_unavailable", "Produto indisponível nesta data.", { date: day.date, productId: line.productId, reason: sale?.reason ?? "product_not_found" });
          return { ...line, product: sale.product, source: sale.source, limit: sale.limit };
        });
        return { date: day.date, snapshot: check.snapshot, lines };
      });

      // 3. Revisão de preço: nenhuma cobrança silenciosa de valor diferente do que o cliente viu.
      const resolved: ResolvedLine[] = prepared.flatMap((d) =>
        d.lines.map((l) => ({ date: d.date, productId: l.productId, name: l.product.name, quantity: l.quantity, expectedPriceCents: l.expectedPriceCents, currentPriceCents: l.product.priceCents })),
      );
      const changes = priceChanges(resolved);
      if (changes.length > 0) throw conflict("price_changed", "Preços mudaram: revise o novo total e confirme de novo.", { changes, cart: reviewedCart(resolved) });

      // 4. Política do responsável (F09), com os valores do SERVIDOR.
      const guard = await readPurchaseGuard(db, tx, current, {
        studentId,
        channel: "advance",
        confirmed: input.confirmed,
        exceptionId: input.exceptionId,
        lines: prepared.flatMap((d) => d.lines.map((l) => ({ consumptionDate: d.date, productId: l.product.id, categoryId: l.product.categoryId, amountCents: subtotalOf(l.product.priceCents, l.quantity) }))),
      });
      const evaluation = decidePurchase(guard);
      if (!evaluation.allowed) {
        const details = { violations: evaluation.violations, days: evaluation.days, weeks: evaluation.weeks, totalCents: evaluation.totalCents };
        if (!guard.permitted) throw new ForbiddenError("Compra pelo site não permitida.");
        if (evaluation.needsConfirmation) throw conflict("confirmation_required", "A compra supera limites ou bloqueios: confirme explicitamente para continuar.", details);
        throw conflict("policy_denied", "A compra não é permitida pela política do aluno.", details);
      }

      // 5. Carteira e reservas/cotas (planejamento só LÊ; falha = nada gravado).
      const walletRef = db.doc(`wallets/${studentId}`);
      const walletSnap = await tx.get(walletRef);
      const walletBefore = parseWalletState(walletSnap.data());
      const orders = prepared.map((d) => {
        const orderId = orderIdOf(current.uid, input.key, d.date);
        return { ...d, orderId };
      });
      const grandTotal = orders.reduce((sum, o) => sum + o.lines.reduce((s, l) => s + subtotalOf(l.product.priceCents, l.quantity), 0), 0);
      if (grandTotal > walletBefore.balanceCents) {
        throw conflict("insufficient_balance", "Saldo insuficiente na carteira do aluno.", { balanceCents: walletBefore.balanceCents, requiredCents: grandTotal });
      }
      const stock = openStockSession(db, tx, { today, actor: { uid: current.uid, role: current.role ?? null } });
      const built = [];
      for (const o of orders) {
        const items: OrderItem[] = [];
        let lineNo = 0;
        for (const l of o.lines) {
          lineNo += 1;
          const reservationId = reservationIdOf(o.orderId, lineNo);
          await stock.reserve({ productId: l.product.id, quantity: l.quantity, consumptionDate: o.date, shiftId, reservationId, orderRef: o.orderId, menuLimit: l.limit });
          items.push({
            lineNo,
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
            reservationId,
          });
        }
        built.push({ ...o, items, totalCents: totalOf(items) });
      }

      // 6. Gravações (nenhuma leitura depois daqui).
      let wallet = walletBefore;
      const stamp = FieldValue.serverTimestamp();
      const results: CheckoutOrder[] = [];
      for (const o of built) {
        wallet = applyDelta(wallet, -o.totalCents);
        const entryId = paymentEntryIdOf(o.orderId);
        const snapshot: PolicySnapshot = o.snapshot;
        tx.create(db.doc(`wallets/${studentId}/entries/${entryId}`), {
          type: "advance_purchase",
          seq: wallet.version,
          amountCents: -o.totalCents,
          balanceAfterCents: wallet.balanceCents,
          reason: `Compra antecipada para ${o.date}`,
          orderId: o.orderId,
          batchId,
          actorUid: current.uid,
          actorRole: current.role ?? null,
          referenceType: "order",
          referenceId: o.orderId,
          createdAt: stamp,
        });
        tx.create(db.doc(`orders/${o.orderId}`), {
          orderId: o.orderId,
          batchId,
          channel: "advance",
          status: "paid",
          studentId,
          studentName: String(studentDoc.get("name") ?? ""),
          studentVersion: Number(studentDoc.get("version") ?? 0),
          consumptionDate: o.date,
          shiftId,
          items: o.items,
          itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
          totalCents: o.totalCents,
          walletEntryId: entryId,
          walletSeq: wallet.version,
          policy: {
            timezone: snapshot.timezone,
            consumptionDate: snapshot.consumptionDate,
            shiftId: snapshot.shiftId,
            purchaseCutoff: snapshot.purchaseCutoff,
            cancelCutoff: snapshot.cancelCutoff,
            purchaseCutoffAt: snapshot.purchaseCutoffAt,
            cancelCutoffAt: snapshot.cancelCutoffAt,
            settingsVersion: snapshot.settingsVersion,
          },
          createdByUid: current.uid,
          createdByRole: current.role ?? null,
          override: evaluation.override,
          version: 1,
          createdAt: stamp,
          updatedAt: stamp,
        });
        results.push({
          orderId: o.orderId,
          consumptionDate: o.date,
          shiftId,
          status: "paid",
          totalCents: o.totalCents,
          itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
          items: o.items,
          walletEntryId: entryId,
          walletSeq: wallet.version,
          purchaseCutoffAt: snapshot.purchaseCutoffAt.toISOString(),
          cancelCutoffAt: snapshot.cancelCutoffAt.toISOString(),
        });
      }
      stock.commit();
      commitPurchaseUsage(db, tx, current, guard, evaluation, batchId);
      tx.set(walletRef, { studentId, currency: "BRL", balanceCents: wallet.balanceCents, version: wallet.version, updatedAt: stamp, ...(walletSnap.exists ? {} : { createdAt: stamp }) }, { merge: true });
      auditInTransaction(db, tx, auditId, {
        action: "orders.checkout",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        target: { type: "orderBatch", id: batchId },
        before: { balanceCents: walletBefore.balanceCents },
        after: { balanceCents: wallet.balanceCents, totalCents: grandTotal, studentId, orderIds: results.map((r) => r.orderId), dates: results.map((r) => r.consumptionDate), override: evaluation.override },
      });
      return {
        batchId,
        studentId,
        shiftId,
        totalCents: grandTotal,
        orders: results,
        wallet: { studentId, balanceCents: wallet.balanceCents, version: wallet.version },
        override: evaluation.override,
      };
    },
  );
}
