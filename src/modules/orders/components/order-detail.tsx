"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { api, errorText } from "@/lib/api-client";
import { localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import { clockLabel, longDayLabel } from "@/modules/menu/format";
import { isNotPickedUp } from "../fulfillment-model";
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
  const uid = user.uid;
  const key = `${uid}|${orderId}`;
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
  const state = loaded?.key === key ? loaded : ({ status: "loading" } as const);

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
              <th scope="col">Faltam</th>
              <th scope="col">Preço un.</th>
              <th scope="col">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((i) => (
              <tr key={i.lineNo}>
                <td>{i.name}</td>
                <td>{i.quantity}</td>
                <td data-testid="item-delivered">{i.deliveredQty}</td>
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
        Total pago: <strong data-testid="order-total">{formatBRL(o.totalCents)}</strong>
      </p>

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
          {o.nonPickup.resolved ? (
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
      <p className="muted">O cancelamento com reembolso à carteira ainda não está disponível nesta tela (chega com a F14).</p>

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
