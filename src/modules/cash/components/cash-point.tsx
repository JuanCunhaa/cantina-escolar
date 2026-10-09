"use client";

import { useState } from "react";
import { formatBRL } from "@/lib/money/format";
import { POINT_LABEL } from "@/modules/fees/receipt-labels";
import { SESSION_STATUS_LABEL, type CashPoint } from "../cash-model";
import type { LiveSummary, SessionView } from "../cash-queries";
import { REVIEW_TEXT, brDate, differenceText, methodLabel, parseCents, when } from "./cash-text";

export type CloseDraft = { countedCashCents: number; declared: { pixCents?: number; cardDebitCents?: number; cardCreditCents?: number }; note: string; expectedReceiptCount: number };

type Props = {
  point: CashPoint;
  date: string;
  session: SessionView | null;
  live: LiveSummary | null;
  locked: boolean;
  onOpen: (openingCents: number) => void;
  onClose: (draft: CloseDraft) => void;
};

const POINT_HELP: Record<CashPoint, string> = {
  secretaria: "Recargas registradas por você na secretaria.",
  counter: "Vendas diretas (sem aluno) registradas por você no balcão. Compras com o saldo da carteira aparecem à parte: não são dinheiro recebido.",
};

/** Tabela dos meios recebidos: dinheiro, Pix e cartão separados, com o estornado abatido. */
export function MethodTable({ live }: { live: LiveSummary }) {
  return (
    <div className="table-scroll">
      <table className="data-table" data-testid="cash-methods">
        <caption className="visually-hidden">Recebimentos por forma de pagamento</caption>
        <thead>
          <tr>
            <th scope="col">Forma</th>
            <th scope="col">Recebimentos</th>
            <th scope="col">Recebido</th>
            <th scope="col">Estornado</th>
            <th scope="col">Líquido de estornos</th>
          </tr>
        </thead>
        <tbody>
          {live.byMethod.map((m) => (
            <tr key={m.method}>
              <th scope="row">{methodLabel(m.method)}</th>
              <td>{m.receiptCount}</td>
              <td>{formatBRL(m.grossCents)}</td>
              <td>{formatBRL(m.reversedCents)}</td>
              <td>{formatBRL(m.netCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpenForm({ locked, onOpen }: Pick<Props, "locked" | "onOpen">) {
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const cents = parseCents(text);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (cents !== null && confirmed) onOpen(cents);
      }}
    >
      <p className="muted">Conte o dinheiro que já está na gaveta, pelo total, e confirme. Esse é o saldo inicial do seu caixa.</p>
      <div className="field">
        <label htmlFor="cash-opening">Saldo inicial em dinheiro (R$)</label>
        <input id="cash-opening" type="text" inputMode="decimal" autoComplete="off" placeholder="0,00" value={text} disabled={locked} onChange={(e) => setText(e.target.value)} data-testid="cash-opening" />
      </div>
      <label>
        <input type="checkbox" checked={confirmed} disabled={locked} onChange={(e) => setConfirmed(e.target.checked)} data-testid="cash-opening-confirm" /> Contei {cents === null ? "o dinheiro" : formatBRL(cents)} na gaveta e confirmo o saldo inicial.
      </label>
      {text.trim() !== "" && cents === null && <p role="alert" className="notice notice-error">Use um valor como 120,00 (ou 0 se a gaveta está vazia).</p>}
      <div className="checkout-actions">
        <button type="submit" disabled={locked || cents === null || !confirmed} data-testid="cash-open">
          Abrir caixa
        </button>
      </div>
    </form>
  );
}

function CloseForm({ session, live, locked, onClose }: { session: SessionView; live: LiveSummary; locked: boolean; onClose: Props["onClose"] }) {
  const [counted, setCounted] = useState("");
  const [pix, setPix] = useState("");
  const [debit, setDebit] = useState("");
  const [credit, setCredit] = useState("");
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const countedCents = parseCents(counted);
  const declared = { pixCents: parseCents(pix) ?? undefined, cardDebitCents: parseCents(debit) ?? undefined, cardCreditCents: parseCents(credit) ?? undefined };
  const invalidDeclared = [pix, debit, credit].some((t) => t.trim() !== "" && parseCents(t) === null);
  const expected = live.expectedCashCents;
  const difference = countedCents === null ? null : countedCents - expected;
  const declaredRows = [
    { label: "Pix visto na conta", value: declared.pixCents, method: "pix" as const },
    { label: "Cartão de débito (maquininha)", value: declared.cardDebitCents, method: "card_debit" as const },
    { label: "Cartão de crédito (maquininha)", value: declared.cardCreditCents, method: "card_credit" as const },
  ].filter((r) => r.value !== undefined);
  const declaredDiffs = declaredRows.map((r) => ({ ...r, diff: (r.value as number) - (live.byMethod.find((m) => m.method === r.method)?.netCents ?? 0) }));
  const hasDivergence = (difference ?? 0) !== 0 || declaredDiffs.some((r) => r.diff !== 0);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!reviewing) {
          if (countedCents !== null && !invalidDeclared) setReviewing(true);
          return;
        }
        if (countedCents !== null) onClose({ countedCashCents: countedCents, declared: Object.fromEntries(Object.entries(declared).filter(([, v]) => v !== undefined)), note: note.trim(), expectedReceiptCount: live.receiptCount });
      }}
    >
      <h3>Fechar o caixa</h3>
      {!reviewing ? (
        <>
          <p className="muted">Conte o dinheiro da gaveta pelo total (sem separar cédulas e moedas). Pix e cartão podem ser conferidos, se quiser.</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="cash-counted">Dinheiro contado na gaveta (R$)</label>
              <input id="cash-counted" type="text" inputMode="decimal" autoComplete="off" value={counted} disabled={locked} onChange={(e) => setCounted(e.target.value)} data-testid="cash-counted" />
            </div>
            <div className="field">
              <label htmlFor="cash-pix">Pix conferido na conta (R$, opcional)</label>
              <input id="cash-pix" type="text" inputMode="decimal" autoComplete="off" value={pix} disabled={locked} onChange={(e) => setPix(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="cash-debit">Cartão de débito conferido (R$, opcional)</label>
              <input id="cash-debit" type="text" inputMode="decimal" autoComplete="off" value={debit} disabled={locked} onChange={(e) => setDebit(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="cash-credit">Cartão de crédito conferido (R$, opcional)</label>
              <input id="cash-credit" type="text" inputMode="decimal" autoComplete="off" value={credit} disabled={locked} onChange={(e) => setCredit(e.target.value)} />
            </div>
            <div className="field field-wide">
              <label htmlFor="cash-note">Observação (opcional)</label>
              <input id="cash-note" type="text" maxLength={200} value={note} disabled={locked} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          {counted.trim() !== "" && countedCents === null && <p role="alert" className="notice notice-error">Use um valor como 120,00 (ou 0).</p>}
          {invalidDeclared && <p role="alert" className="notice notice-error">Confira os valores de Pix e cartão.</p>}
          <div className="checkout-actions">
            <button type="submit" disabled={locked || countedCents === null || invalidDeclared} data-testid="cash-review">
              Revisar fechamento
            </button>
          </div>
        </>
      ) : (
        <div data-testid="cash-review-panel">
          <dl className="receipt-grid">
            <dt>Saldo inicial</dt>
            <dd>{formatBRL(session.openingCents)}</dd>
            <dt>Dinheiro esperado na gaveta</dt>
            <dd data-testid="cash-expected">{formatBRL(expected)}</dd>
            <dt>Dinheiro contado</dt>
            <dd>{formatBRL(countedCents ?? 0)}</dd>
            <dt>Diferença</dt>
            <dd data-testid="cash-difference">
              <strong>{differenceText(difference ?? 0)}</strong>
            </dd>
            {declaredDiffs.map((r) => (
              <div key={r.method} style={{ display: "contents" }}>
                <dt>{r.label}</dt>
                <dd>{differenceText(r.diff)}</dd>
              </div>
            ))}
          </dl>
          {hasDivergence ? (
            <p role="alert" className="notice notice-error">Qualquer diferença, mesmo de 1 centavo, fica pendente de revisão da administração. Nada é ajustado automaticamente na carteira, nos recebimentos ou no estoque.</p>
          ) : (
            <p className="muted">Sem diferença.</p>
          )}
          <div className="checkout-actions">
            <button type="button" className="secondary" disabled={locked} onClick={() => setReviewing(false)}>
              Voltar
            </button>{" "}
            <button type="submit" disabled={locked} data-testid="cash-close">
              Confirmar fechamento
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

/** Um ponto de recebimento (secretaria ou balcão) no dia: abrir → conferir o que entrou → fechar; depois, o resultado e o que veio depois. */
export function CashPointView({ point, date, session, live, locked, onOpen, onClose }: Props) {
  const status = session?.status ?? null;
  return (
    <section aria-labelledby={`cash-${point}-title`} data-testid={`cash-point-${point}`} className="student-block">
      <h2 id={`cash-${point}-title`}>
        {POINT_LABEL[point]} · {brDate(date)}{" "}
        <span className="badge" data-testid={`cash-status-${point}`}>
          {status ? SESSION_STATUS_LABEL[status] : "Sem caixa aberto"}
        </span>
      </h2>
      <p className="muted">{POINT_HELP[point]}</p>

      {!session && <OpenForm locked={locked} onOpen={onOpen} />}

      {session && (
        <p>
          Saldo inicial confirmado: <strong>{formatBRL(session.openingCents)}</strong>
          {session.openedAt && <span className="muted"> · {when(session.openedAt)}</span>}
          {session.reopenCount > 0 && <span className="muted"> · reaberto {session.reopenCount}×</span>}
        </p>
      )}

      {live && (
        <>
          <h3>Recebido neste caixa</h3>
          <MethodTable live={live} />
          {session && (
            <p>
              Dinheiro esperado na gaveta: <strong data-testid="cash-expected-live">{formatBRL(live.expectedCashCents)}</strong>
              <span className="muted"> (saldo inicial + dinheiro recebido − estornado)</span>
            </p>
          )}
          {point === "counter" && (
            <p className="muted" data-testid="cash-wallet">
              Consumo com carteira no balcão: {live.walletConsumption.orderCount} {live.walletConsumption.orderCount === 1 ? "compra" : "compras"} · {formatBRL(live.walletConsumption.totalCents)}. É saldo que já estava na carteira: não entra como dinheiro recebido.
            </p>
          )}
          {!session && live.receiptCount > 0 && <p role="status" className="notice">Há {live.receiptCount} recebimento(s) seu(s) nesta data sem caixa aberto. Abra o caixa e feche para conferi-los.</p>}
        </>
      )}

      {session && live && (status === "open" || status === "reopened") && <CloseForm session={session} live={live} locked={locked} onClose={onClose} />}

      {session?.status === "closed" && session.closure && (
        <div data-testid="cash-closed">
          <h3>Fechamento {session.closureNo}</h3>
          <dl className="receipt-grid">
            <dt>Fechado em</dt>
            <dd>{when(session.closure.closedAtIso)}</dd>
            <dt>Esperado na gaveta</dt>
            <dd>{formatBRL(session.closure.expectedCashCents)}</dd>
            <dt>Contado</dt>
            <dd>{formatBRL(session.closure.countedCashCents)}</dd>
            <dt>Diferença</dt>
            <dd>
              <strong>{differenceText(session.closure.cashDifferenceCents)}</strong>
            </dd>
            <dt>Situação</dt>
            <dd data-testid="cash-review-status">{session.review ? REVIEW_TEXT[session.review.status] : "—"}</dd>
          </dl>
          {session.afterClose && session.afterClose.count > 0 && (
            <p role="alert" className="notice notice-error" data-testid="cash-after-close">
              {session.afterClose.count} movimento(s) lançado(s) depois do fechamento ({session.afterClose.newReceipts.length} recebimento(s), {session.afterClose.newReversals.length} estorno(s)). Este fechamento não foi alterado: peça à administração para reabri-lo.
            </p>
          )}
          {session.history.length > 1 && (
            <>
              <h3>Fechamentos anteriores deste caixa</h3>
              <ul className="plain-list">
                {session.history
                  .filter((h) => h.no !== session.closureNo)
                  .map((h) => (
                    <li key={h.no}>
                      Fechamento {h.no} · {when(h.closedAt)} · contado {formatBRL(h.countedCashCents)} · {differenceText(h.cashDifferenceCents)}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
