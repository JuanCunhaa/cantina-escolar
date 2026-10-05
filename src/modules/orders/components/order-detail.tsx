"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { api, errorText } from "@/lib/api-client";
import { localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import { clockLabel, longDayLabel } from "@/modules/menu/format";
import { isNotPickedUp } from "../fulfillment-model";
import type { CommandMessage } from "../use-operations";
import { CancelPanel, Notice } from "./cancel-order";
import { CHANNEL_LABEL, type OrderDetail } from "../history-model";
import { orderDayText, StatusBadge } from "./my-orders";

const PURCHASER: Record<string, string> = { guardian: "Responsável", student: "O próprio aluno", staff: "Equipe da cantina" };
const when = (iso: string | null) => (iso ? `${longDayLabel(localDateOf(new Date(iso)))} às ${clockLabel(iso)}` : "—");

type State = { key: string; status: "error"; code: string } | { key: string; status: "ready"; order: OrderDetail };

/**
 * Detalhe e recibo interno de um pedido, lidos do servidor com o vínculo/perfil atuais. Mostra o SNAPSHOT da compra
 * (nomes, preços, quantidades); mudar produto depois não altera o recibo. A conta que muda ou a tela que desmonta
 * descarta a resposta em voo.
 */
export function OrderDetailView({ user, orderId }: { user: User; orderId: string }) {
  const [loaded, setState] = useState<State | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [notice, setNotice] = useState<CommandMessage | null>(null);
  const uid = user.uid;
  const key = `${uid}|${orderId}|${reloadTick}`;
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  });
  useEffect(() => {
    let current = true;
    void api<OrderDetail>(userRef.current, "GET", `/api/orders/${encodeURIComponent(orderId)}`, undefined, { timeoutMs: 15000 }).then((result) => {
      if (current) setState(result.ok ? { key, status: "ready", order: result.data } : { key, status: "error", code: result.error });
    });
    return () => {
      current = false;
    };
  }, [key, orderId]);
  // Depois de um comando a tela relê o pedido; o estado anterior permanece até a resposta nova (nunca pisca "carregando").
  const state = loaded?.key === key ? loaded : loaded && loaded.key.startsWith(`${uid}|${orderId}|`) ? loaded : ({ status: "loading" } as const);

  if (state.status === "loading") return <p role="status">Carregando o pedido…</p>;
  if (state.status === "error")
    return (
      <section>
        <h1>Pedido</h1>
        <p role="alert" className="notice notice-error" data-testid="order-error">
          {state.code === "forbidden" ? "Você não tem acesso a este pedido." : errorText(state.code)}
        </p>
        <Link href="/portal/pedidos">Voltar para Meus pedidos</Link>
      </section>
    );
  const o = state.order;
  const today = localDateOf(new Date());
  const discount = o.items.reduce((n, i) => n + i.discountCents, 0);
  const anyExchanged = o.items.some((i) => i.exchangedQty > 0 || i.fromExchange);
  return (
    <section data-testid="order-detail" className="receipt">
      <p className="no-print">
        <Link href="/portal/pedidos">← Meus pedidos</Link>
      </p>
      <h1>Pedido de {o.studentName}</h1>
      <p>
        <strong>{orderDayText(o, today)}</strong> <StatusBadge order={o} />
      </p>
      <p className="muted">
        {CHANNEL_LABEL[o.channel as keyof typeof CHANNEL_LABEL] ?? "Compra"} · Código {o.orderId}
      </p>

      <h2>Itens (preços da data da compra)</h2>
      <div className="table-scroll">
        <table className="data-table" data-testid="order-items">
          <caption className="visually-hidden">Itens do pedido</caption>
          <thead>
            <tr>
              <th scope="col">Produto</th>
              <th scope="col">Qtd.</th>
              <th scope="col">Entregues</th>
              <th scope="col">Canceladas</th>
              {anyExchanged && <th scope="col">Trocadas</th>}
              <th scope="col">Faltam</th>
              <th scope="col">Preço un.</th>
              <th scope="col">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((i) => (
              <tr key={i.lineNo}>
                <td>
                  {i.name}
                  {i.fromExchange && <span className="muted"> (entrou na troca)</span>}
                </td>
                <td>{i.quantity}</td>
                <td data-testid="item-delivered">{i.deliveredQty}</td>
                <td data-testid="item-canceled">{i.canceledQty}</td>
                {anyExchanged && <td data-testid="item-exchanged">{i.exchangedQty}</td>}
                <td data-testid="item-remaining">{isNotPickedUp(o.status) ? `${i.remainingQty} (não retiradas)` : i.remainingQty}</td>
                <td>{formatBRL(i.unitPriceCents)}</td>
                <td>{formatBRL(i.subtotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {discount > 0 && <p>Descontos: {formatBRL(discount)}</p>}
      <p>
        Total pago{o.exchanges.length > 0 ? " (com as diferenças das trocas)" : ""}: <strong data-testid="order-total">{formatBRL(o.totalCents)}</strong>
      </p>
      {o.refundedCents > 0 && (
        <p data-testid="order-refunded">
          Devolvido à carteira de {o.studentName}: <strong>{formatBRL(o.refundedCents)}</strong>
        </p>
      )}

      <h2>Histórico do pedido</h2>
      <ol className="plain-list" data-testid="order-timeline">
        {o.timeline.map((t, index) => (
          <li key={`${t.kind}-${index}`}>
            {t.label}: {when(t.at)}
          </li>
        ))}
        {o.purchasedBy && <li>Comprado por: {PURCHASER[o.purchasedBy]}</li>}
        {o.cancelDeadlineAt && <li className="muted">Prazo de cancelamento até {when(o.cancelDeadlineAt)}</li>}
      </ol>
      {o.nonPickup && (
        <p className="notice" data-testid="order-non-pickup">
          {o.nonPickup.resolved && o.nonPickup.kind === "reschedule" ? (
            <>
              Este pedido ficou <strong>não retirado</strong> e a escola o <strong>reagendou</strong> para outra data, sem nova cobrança (veja o histórico).
            </>
          ) : o.nonPickup.resolved && o.nonPickup.kind === "cancel_refund" ? (
            <>
              A escola resolveu este pedido <strong>não retirado</strong> cancelando e devolvendo {formatBRL(o.nonPickup.refundCents ?? 0)} à carteira de {o.studentName}. {o.nonPickup.classification}.
            </>
          ) : o.nonPickup.resolved ? (
            <>
              A escola encerrou este pedido como <strong>não retirado</strong>, com a cobrança mantida ({formatBRL(o.nonPickup.retainedCents ?? 0)} das unidades não retiradas). {o.nonPickup.classification}.
            </>
          ) : (
            <>
              Este pedido foi marcado como <strong>não retirado</strong> e aguarda a decisão da escola. Nenhum valor foi devolvido ainda ({formatBRL(o.nonPickup.retainedCents ?? 0)} das unidades não retiradas seguem pagos).
            </>
          )}
        </p>
      )}
      <Notice message={notice} testId="cancel-message" />
      {o.cancellations.length > 0 && (
        <>
          <h2>Cancelamentos e reembolsos</h2>
          <ul className="plain-list" data-testid="order-cancellations">
            {o.cancellations.map((c, index) => (
              <li key={index}>
                {when(c.at)} — {c.by === "guardian" ? "cancelado pelo responsável" : "cancelado pela escola"}: {c.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}. Devolvido à carteira: <strong>{formatBRL(c.refundCents)}</strong>
                {c.walletSeq !== null && c.balanceAfterCents !== null ? ` (lançamento nº ${c.walletSeq}, saldo depois: ${formatBRL(c.balanceAfterCents)})` : ""}
                {c.reason ? ` · ${c.reason}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {o.reschedules.length > 0 && (
        <>
          <h2>Reagendamentos</h2>
          <ul className="plain-list" data-testid="order-reschedules">
            {o.reschedules.map((r, index) => (
              <li key={index}>
                {when(r.at)} — a escola mudou a data de {longDayLabel(r.fromDate)} para <strong>{longDayLabel(r.toDate)}</strong>
                {r.toShiftName && r.toShiftName !== r.fromShiftName ? ` (turno ${r.toShiftName})` : ""}. Pagamento e preços mantidos, sem nova cobrança.
              </li>
            ))}
          </ul>
        </>
      )}
      {o.exchanges.length > 0 && (
        <>
          <h2>Trocas de produto</h2>
          <ul className="plain-list" data-testid="order-exchanges">
            {o.exchanges.map((x, index) => (
              <li key={index}>
                {when(x.at)} — saiu {x.removed.map((l) => `${l.quantity}× ${l.name}`).join(", ")}; entrou {x.added.map((l) => `${l.quantity}× ${l.name}`).join(", ")}.{" "}
                <strong>
                  {x.differenceCents > 0 ? `Diferença cobrada: ${formatBRL(x.differenceCents)}` : x.differenceCents < 0 ? `Diferença devolvida à carteira: ${formatBRL(-x.differenceCents)}` : "Sem diferença de valor"}
                </strong>
                {x.walletSeq !== null && x.balanceAfterCents !== null ? ` (lançamento nº ${x.walletSeq}, saldo depois: ${formatBRL(x.balanceAfterCents)})` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {o.cancelable ? (
        <CancelPanel user={user} order={o} onDone={() => setReloadTick((n) => n + 1)} onMessage={setNotice} />
      ) : (
        o.cancelDeadlineAt &&
        !["cancelled", "delivered", "not_picked_up_closed"].includes(o.status) &&
        o.items.some((i) => i.remainingQty > 0) && (
          <p className="muted" data-testid="cancel-unavailable">
            O prazo para cancelar este pedido terminou. Se precisar, fale com a escola: o cancelamento depois do prazo é feito pela equipe, com motivo.
          </p>
        )
      )}

      <h2>Recibo interno</h2>
      <dl className="receipt-grid" data-testid="order-receipt">
        <dt>Pagamento</dt>
        <dd>{o.paymentState === "paid" ? "Pago com o saldo da carteira do aluno" : "Pagamento pendente"}</dd>
        <dt>Valor debitado</dt>
        <dd>{o.receipt.amountCents === null ? "—" : formatBRL(Math.abs(o.receipt.amountCents))}</dd>
        <dt>Saldo após a compra</dt>
        <dd>{o.receipt.balanceAfterCents === null ? "—" : formatBRL(o.receipt.balanceAfterCents)}</dd>
        <dt>Lançamento</dt>
        <dd>
          {o.receipt.seq === null ? "—" : `nº ${o.receipt.seq}`} · {when(o.receipt.createdAt)}
        </dd>
      </dl>
      <p className="no-print">
        <button type="button" className="secondary" onClick={() => window.print()}>
          Imprimir recibo
        </button>
      </p>
    </section>
  );
}
