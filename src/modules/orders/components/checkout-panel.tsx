"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { clockLabel, dayMonth, longDayLabel } from "@/modules/menu/format";
import { executeWithRetry } from "@/modules/wallet/operation";
import type { WalletSlot } from "@/modules/wallet/use-wallets";
import type { CheckoutResult } from "../commands";
import { MAX_BATCH_DATES, MAX_BATCH_LINES, MAX_LINES_PER_DATE, subtotalOf, type PriceChange } from "../model";

export { MAX_BATCH_DATES, MAX_BATCH_LINES, MAX_LINES_PER_DATE };

export type CartLine = { date: string; productId: string; name: string; quantity: number; unitPriceCents: number };

type BudgetEffect = { key: string; weekEnd?: string; committedCents: number; requestedCents: number; afterCents: number; limitCents: number | null; exceeds: boolean };
type Violation = { kind: string; productId?: string; categoryId?: string };
type LimitDetails = { days: BudgetEffect[]; weeks: BudgetEffect[]; violations: Violation[]; totalCents: number };

type Op =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "confirmed"; result: CheckoutResult; replayed: boolean }
  | { phase: "refused"; code: string; date: string | null; cartSig: string }
  | { phase: "price_changed"; changes: PriceChange[]; newTotalCents: number; cartSig: string }
  | { phase: "confirm_limits"; details: LimitDetails; cartSig: string }
  | { phase: "uncertain" };

/** Assinatura do carrinho SEM preços: editar datas/produtos/quantidades encerra o aviso da tentativa anterior. */
const cartSigOf = (lines: readonly CartLine[]) => lines.map((l) => `${l.date}:${l.productId}:${l.quantity}`).join("|");

function groupByDate(lines: readonly CartLine[]): [string, CartLine[]][] {
  const groups = new Map<string, CartLine[]>();
  for (const line of lines) groups.set(line.date, [...(groups.get(line.date) ?? []), line]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

type Props = {
  user: User;
  student: { id: string; name: string; shiftId: string; shiftName: string };
  lines: CartLine[];
  reviewing: boolean;
  onClose: () => void;
  wallet: WalletSlot | undefined;
  onConfirmed: (result: CheckoutResult) => void;
  /** Preços atuais devolvidos pelo servidor numa recusa por mudança de preço (valem até o cardápio recarregar). */
  onServerPrices: (prices: Record<string, number>) => void;
  refreshWallet: () => Promise<boolean>;
  /** Operação enviada ou resultado incerto: a tela trava a edição do carrinho. */
  onBusy: (busy: boolean) => void;
};

/**
 * Revisão e confirmação da compra antecipada (docs/domains/checkout.md). O sucesso só aparece depois da RESPOSTA
 * confirmada do servidor (nunca por otimismo nem pelo listener); sem resposta definitiva a operação fica INCERTA e é
 * repetida com a MESMA chave, de modo que o servidor devolve o pedido original em vez de cobrar de novo. Preço mudou:
 * nada foi cobrado, o carrinho passa a mostrar os preços do servidor e o responsável confirma de novo. Limites/bloqueios:
 * o responsável vê o efeito no orçamento e confirma explicitamente (docs/domains/policies.md §9).
 */
export function CheckoutPanel({ user, student, lines, reviewing, onClose, wallet, onConfirmed, onServerPrices, refreshWallet, onBusy }: Props) {
  const [op, setOp] = useState<Op>({ phase: "idle" });
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const cartSig = cartSigOf(lines);
  const totalCents = lines.reduce((sum, l) => sum + subtotalOf(l.unitPriceCents, l.quantity), 0);
  const days = groupByDate(lines);
  const names = new Map(lines.map((l) => [l.productId, l.name]));

  // Aviso de uma tentativa recusada vale só para o carrinho em que ocorreu.
  const effective: Op = (op.phase === "refused" || op.phase === "price_changed" || op.phase === "confirm_limits") && op.cartSig !== cartSig ? { phase: "idle" } : op;
  const busy = effective.phase === "pending" || effective.phase === "uncertain";

  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => {
    if (reviewing) heading.current?.focus();
  }, [reviewing]);

  async function send(confirmed: boolean) {
    if (inFlight.current || lines.length === 0) return;
    const sig = `${confirmed}|${lines.map((l) => `${l.date}:${l.productId}:${l.quantity}:${l.unitPriceCents}`).join("|")}`;
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: newKey() };
    const key = attempt.current.key;
    const body = {
      key,
      studentId: student.id,
      expectedShiftId: student.shiftId,
      confirmed,
      days: days.map(([date, items]) => ({ date, lines: items.map((l) => ({ productId: l.productId, quantity: l.quantity, expectedPriceCents: l.unitPriceCents })) })),
    };
    inFlight.current = true;
    setOp({ phase: "pending" });
    const outcome = await executeWithRetry(() => api<CheckoutResult & { replayed: boolean }>(user, "POST", "/api/orders/checkout", body, { timeoutMs: 25000 }));
    inFlight.current = false;
    if (outcome.phase === "confirmed") {
      attempt.current = null;
      onConfirmed(outcome.data);
      setOp({ phase: "confirmed", result: outcome.data, replayed: outcome.data.replayed });
      return;
    }
    if (outcome.phase === "uncertain") return setOp({ phase: "uncertain" });
    attempt.current = null;
    const details = outcome.details as Record<string, unknown> | undefined;
    if (outcome.error === "price_changed" && details) {
      const changes = (details.changes as PriceChange[]) ?? [];
      const cart = details.cart as { totalCents: number } | undefined;
      onServerPrices(Object.fromEntries(changes.map((c) => [c.productId, c.currentPriceCents])));
      return setOp({ phase: "price_changed", changes, newTotalCents: cart?.totalCents ?? totalCents, cartSig });
    }
    if (outcome.error === "confirmation_required" && details) return setOp({ phase: "confirm_limits", details: details as unknown as LimitDetails, cartSig });
    const date = typeof details?.date === "string" ? details.date : null;
    setOp({ phase: "refused", code: outcome.error, date, cartSig });
  }

  if (effective.phase === "confirmed") return <Confirmed result={effective.result} replayed={effective.replayed} student={student} wallet={wallet} onNew={() => setOp({ phase: "idle" })} />;
  if (!reviewing && !busy) return null;

  if (lines.length === 0 && !busy) {
    return (
      <section aria-labelledby="checkout-title" className="checkout" data-testid="checkout-review">
        <h2 id="checkout-title" ref={heading} tabIndex={-1}>
          Revisão da compra
        </h2>
        <p>O carrinho está vazio. Escolha produtos no cardápio.</p>
        <button type="button" className="secondary" onClick={onClose}>
          Voltar ao cardápio
        </button>
      </section>
    );
  }

  const balance = wallet?.view?.balanceCents ?? null;
  const shortBy = balance !== null && balance < totalCents ? totalCents - balance : 0;

  return (
    <section aria-labelledby="checkout-title" className="checkout" data-testid="checkout-review" data-phase={effective.phase}>
      <h2 id="checkout-title" ref={heading} tabIndex={-1}>
        Revisão da compra
      </h2>
      <p data-testid="checkout-student">
        <strong>{student.name}</strong> <span className="muted">· Turno {student.shiftName}</span>
      </p>
      {days.map(([date, items]) => (
        <section key={date} aria-label={longDayLabel(date)} className="checkout-day" data-testid="checkout-day" data-date={date}>
          <h3>{longDayLabel(date)}</h3>
          <ul className="plain-list">
            {items.map((l) => (
              <li key={l.productId} className="checkout-line">
                <span>
                  {l.quantity} × {l.name}
                </span>
                <span className="muted">{formatBRL(l.unitPriceCents)} cada</span>
                <span className="checkout-amount">{formatBRL(subtotalOf(l.unitPriceCents, l.quantity))}</span>
              </li>
            ))}
          </ul>
          <p className="checkout-day-total">
            Pedido de {dayMonth(date)}: <strong>{formatBRL(items.reduce((sum, l) => sum + subtotalOf(l.unitPriceCents, l.quantity), 0))}</strong>
          </p>
        </section>
      ))}
      <p className="checkout-total">
        Total a debitar: <strong data-testid="checkout-total">{formatBRL(totalCents)}</strong>
        {days.length > 1 ? <span className="muted"> · {days.length} pedidos, um por data; a confirmação vale para todos ou para nenhum</span> : null}
      </p>
      <p className="muted" data-testid="checkout-balance">
        {balance === null
          ? "Consultando o saldo da carteira…"
          : `Saldo da carteira de ${student.name}: ${formatBRL(balance)}${shortBy === 0 ? ` · após a compra: ${formatBRL(balance - totalCents)}` : ""}.`}
      </p>
      {shortBy > 0 && (
        <p role="status" className="notice">
          O saldo exibido ({formatBRL(balance ?? 0)}) é menor que o total. O servidor decide na confirmação; se faltar saldo, nada é cobrado.
        </p>
      )}

      {effective.phase === "price_changed" && (
        <div role="alert" className="notice notice-error" data-testid="checkout-status" data-phase="price_changed">
          <p>
            Os preços mudaram desde que você escolheu os produtos. <strong>Nada foi cobrado.</strong> O novo total é {formatBRL(effective.newTotalCents)}; revise e confirme de novo.
          </p>
          <ul>
            {effective.changes.map((c) => (
              <li key={`${c.date}:${c.productId}`}>
                {c.name} ({dayMonth(c.date)}): {formatBRL(c.expectedPriceCents)} → {formatBRL(c.currentPriceCents)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {effective.phase === "confirm_limits" && <LimitNotice details={effective.details} names={names} />}
      {effective.phase === "refused" && (
        <p role="alert" className="notice notice-error" data-testid="checkout-status" data-phase="refused" data-code={effective.code}>
          {errorText(effective.code)}
          {effective.date ? ` (${longDayLabel(effective.date)})` : ""} Nada foi cobrado.
        </p>
      )}
      {effective.phase === "pending" && (
        <p role="status" className="notice" data-testid="checkout-status" data-phase="pending">
          Enviado. O resultado só é mostrado depois da confirmação do servidor.
        </p>
      )}
      {effective.phase === "uncertain" && (
        <div role="status" className="notice" data-testid="checkout-status" data-phase="uncertain">
          <p>
            Ainda não sabemos se a compra de {formatBRL(totalCents)} foi concluída. Nada foi repetido como uma compra nova: ao verificar, a mesma operação é consultada e não será cobrada duas vezes.
          </p>
          <button type="button" onClick={() => void send(false)}>
            Verificar resultado
          </button>{" "}
          <button type="button" className="secondary" onClick={() => void refreshWallet()}>
            Conferir o saldo
          </button>{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              attempt.current = null;
              setOp({ phase: "idle" });
            }}
          >
            Abandonar esta operação
          </button>
        </div>
      )}

      {effective.phase !== "uncertain" && (
        <p className="checkout-actions">
          {effective.phase === "confirm_limits" ? (
            <button type="button" disabled={busy} onClick={() => void send(true)} data-testid="checkout-confirm-limits">
              Confirmar mesmo assim
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void send(false)} data-testid="checkout-confirm">
              {effective.phase === "pending" ? "Aguardando confirmação do servidor…" : effective.phase === "price_changed" ? `Confirmar com o novo total (${formatBRL(totalCents)})` : `Confirmar compra (${formatBRL(totalCents)})`}
            </button>
          )}{" "}
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Voltar e editar
          </button>
        </p>
      )}
    </section>
  );
}

/** Efeito no orçamento por data/semana (e bloqueios): o responsável decide com o número à vista. */
function LimitNotice({ details, names }: { details: LimitDetails; names: Map<string, string> }) {
  const exceeded = [...details.days.map((d) => ({ ...d, label: `Limite diário em ${dayMonth(d.key)}` })), ...details.weeks.map((w) => ({ ...w, label: `Limite semanal de ${dayMonth(w.key)} a ${dayMonth(w.weekEnd ?? w.key)}` }))].filter((x) => x.exceeds);
  return (
    <div role="alert" className="notice" data-testid="checkout-status" data-phase="confirm_limits">
      <p>
        <strong>Esta compra supera os limites ou bloqueios definidos para o aluno.</strong> Como responsável, você pode continuar; o valor continua contando como consumo do aluno nas próximas compras. Nada foi cobrado ainda.
      </p>
      <ul>
        {exceeded.map((x) => (
          <li key={x.label}>
            {x.label}: teto {formatBRL(x.limitCents ?? 0)}, já comprometido {formatBRL(x.committedCents)}, esta compra {formatBRL(x.requestedCents)} → {formatBRL(x.afterCents)}.
          </li>
        ))}
        {details.violations
          .filter((v) => v.kind === "product_blocked" || v.kind === "category_blocked")
          .map((v) => (
            <li key={`${v.kind}:${v.productId ?? v.categoryId}`}>{v.kind === "product_blocked" ? `Produto bloqueado: ${names.get(v.productId ?? "") ?? "produto"}.` : "Há produto de uma categoria bloqueada neste carrinho."}</li>
          ))}
      </ul>
    </div>
  );
}

function Confirmed({ result, replayed, student, wallet, onNew }: { result: CheckoutResult; replayed: boolean; student: Props["student"]; wallet: WalletSlot | undefined; onNew: () => void }) {
  const syncing = wallet?.sync !== "live";
  return (
    <section aria-labelledby="checkout-done" className="checkout" data-testid="checkout-review" data-phase="confirmed">
      <h2 id="checkout-done">Compra confirmada</h2>
      <p role="status" data-testid="checkout-status" data-phase="confirmed" data-syncing={syncing}>
        Confirmada pelo servidor: {formatBRL(result.totalCents)} debitados da carteira de {student.name}
        {result.orders.length > 1 ? ` em ${result.orders.length} pedidos` : ""}. Saldo atual: {formatBRL(result.wallet.balanceCents)}.
        {replayed ? " (A compra já tinha sido concluída antes; nada foi cobrado de novo.)" : ""}
        {syncing ? " Atualizando a leitura em tempo real…" : ""}
      </p>
      <ul className="plain-list">
        {result.orders.map((order) => (
          <li key={order.orderId} data-testid="order-confirmed" data-date={order.consumptionDate}>
            <strong>{longDayLabel(order.consumptionDate)}</strong> — pedido pago e agendado, {formatBRL(order.totalCents)}
            <ul>
              {order.items.map((item) => (
                <li key={item.lineNo}>
                  {item.quantity} × {item.name} · {formatBRL(item.subtotalCents)}
                </li>
              ))}
            </ul>
            <span className="muted">
              Cancelamento pela família até {clockLabel(order.cancelCutoffAt)} de {dayMonth(order.consumptionDate)} (horário de Brasília).
            </span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onNew}>
        Fazer nova compra
      </button>
    </section>
  );
}
