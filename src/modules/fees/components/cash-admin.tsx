"use client";

import { useState } from "react";
import Link from "next/link";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { addDays, localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import { ALERT_LABEL, REVIEW_DECISION_LABEL, SESSION_STATUS_LABEL, type CashAlert, type ReviewDecision } from "@/modules/cash/cash-model";
import type { CashAdminList, SessionView } from "@/modules/cash/cash-queries";
import { MethodTable } from "@/modules/cash/components/cash-point";
import { REVIEW_TEXT, brDate, differenceText, when } from "@/modules/cash/components/cash-text";
import { useServerQuery } from "@/modules/orders/use-operations";
import { usePosSubmit } from "@/modules/pos/use-pos";
import { POINT_LABEL } from "@/modules/fees/receipt-labels";
import { FinanceTabs } from "./finance-tabs";

type Message = { kind: "ok" | "error"; text: string };

export type CashAdminViewProps = { list: CashAdminList; from: string; to: string; onRange: (from: string, to: string) => void };

/** Lista de caixas do período e alertas (parte visual, sem rede). */
export function CashAdminView({ list, from, to, onRange }: CashAdminViewProps) {
  const alerts: CashAlert[] = list.alerts;
  return (
    <section aria-labelledby="fin-cash-title">
      <h1 id="fin-cash-title">Financeiro</h1>
      <FinanceTabs current="/operacao/financeiro" />
      <h2>Alertas ({alerts.length})</h2>
      {alerts.length === 0 && <p className="muted">Nenhuma pendência de caixa nos últimos 14 dias.</p>}
      <ul className="plain-list" data-testid="fin-alerts">
        {alerts.map((a) => (
          <li key={`${a.kind}-${a.date}-${a.point}-${a.operatorUid}`}>
            <strong>{ALERT_LABEL[a.kind]}</strong> · {POINT_LABEL[a.point]} · {brDate(a.date)} · {a.operatorName ?? "Operador"}
            {a.detail && a.kind !== "open_not_closed" && <span className="muted"> · {a.detail}</span>}{" "}
            {a.sessionId && <Link href={`/operacao/financeiro/caixas/${a.sessionId}`}>Abrir</Link>}
          </li>
        ))}
      </ul>

      <h2>Caixas do período</h2>
      <div className="toolbar">
        <div className="field">
          <label htmlFor="fin-from">De</label>
          <input id="fin-from" type="date" value={from} onChange={(e) => e.target.value && onRange(e.target.value, to)} />
        </div>
        <div className="field">
          <label htmlFor="fin-to">Até</label>
          <input id="fin-to" type="date" value={to} onChange={(e) => e.target.value && onRange(from, e.target.value)} />
        </div>
      </div>
      {list.sessions.length === 0 && <p className="muted">Nenhum caixa no período.</p>}
      {list.sessions.length > 0 && (
        <div className="table-scroll">
          <table className="data-table" data-testid="fin-sessions">
            <caption className="visually-hidden">Caixas por operador, ponto e data</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Ponto</th>
                <th scope="col">Operador</th>
                <th scope="col">Situação</th>
                <th scope="col">Esperado</th>
                <th scope="col">Contado</th>
                <th scope="col">Diferença</th>
                <th scope="col">Revisão</th>
              </tr>
            </thead>
            <tbody>
              {list.sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    <Link href={`/operacao/financeiro/caixas/${s.sessionId}`}>{brDate(s.date)}</Link>
                  </td>
                  <td>{POINT_LABEL[s.point]}</td>
                  <td>{s.operatorName}</td>
                  <td>
                    {SESSION_STATUS_LABEL[s.status]}
                    {s.reopenCount > 0 ? ` (reaberto ${s.reopenCount}×)` : ""}
                  </td>
                  <td>{s.expectedCashCents === null ? "—" : formatBRL(s.expectedCashCents)}</td>
                  <td>{s.countedCashCents === null ? "—" : formatBRL(s.countedCashCents)}</td>
                  <td>{s.cashDifferenceCents === null ? "—" : differenceText(s.cashDifferenceCents)}</td>
                  <td>{s.reviewStatus ? REVIEW_TEXT[s.reviewStatus as keyof typeof REVIEW_TEXT] : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.truncated && <p className="muted">Lista parcial: reduza o período.</p>}
    </section>
  );
}

export function CashAdmin({ user }: { user: User }) {
  const today = localDateOf(new Date());
  const [range, setRange] = useState({ from: addDays(today, -6), to: today });
  const list = useServerQuery<CashAdminList>(user, "/api/admin/finance/cash", `from=${range.from}&to=${range.to}`);
  if (list.status === "loading") return <p role="status" className="muted">Carregando…</p>;
  if (!list.data) return <p role="alert" className="notice notice-error">{errorText(list.errorCode ?? "internal")}</p>;
  return <CashAdminView list={list.data} from={range.from} to={range.to} onRange={(from, to) => setRange({ from, to })} />;
}

/* ---------------------------------------------------------------------------------------- detalhe */

export type SessionDetailProps = {
  session: SessionView;
  message: Message | null;
  locked: boolean;
  onReview: (decision: ReviewDecision, note: string) => void;
  onReopen: (reason: string) => void;
};

/** Um caixa: fechamento, movimentos posteriores, histórico e as duas ações da administração (revisar a divergência e reabrir). */
export function SessionDetailView({ session, message, locked, onReview, onReopen }: SessionDetailProps) {
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<ReviewDecision>("approved");
  const closure = session.closure;
  const canReview = session.status === "closed" && closure?.hasDivergence === true;
  const live = session.live;
  return (
    <section aria-labelledby="fin-session-title">
      <h1 id="fin-session-title">
        Caixa {POINT_LABEL[session.point]} · {brDate(session.date)}
      </h1>
      <FinanceTabs current="/operacao/financeiro" />
      <p>
        {session.operatorName} · <span className="badge">{SESSION_STATUS_LABEL[session.status]}</span> · saldo inicial {formatBRL(session.openingCents)}
        {session.reopenCount > 0 ? ` · reaberto ${session.reopenCount}×` : ""}
      </p>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid="fin-message">
          {message.text}
        </p>
      )}

      {closure && (
        <>
          <h2>Fechamento {session.closureNo}</h2>
          <dl className="receipt-grid" data-testid="fin-closure">
            <dt>Fechado em</dt>
            <dd>
              {when(closure.closedAtIso)} · {closure.closedByName}
            </dd>
            <dt>Esperado na gaveta</dt>
            <dd>{formatBRL(closure.expectedCashCents)}</dd>
            <dt>Contado</dt>
            <dd>{formatBRL(closure.countedCashCents)}</dd>
            <dt>Diferença</dt>
            <dd>
              <strong>{differenceText(closure.cashDifferenceCents)}</strong>
            </dd>
            <dt>Consumo com carteira (informativo)</dt>
            <dd>
              {closure.walletConsumption.orderCount} compra(s) · {formatBRL(closure.walletConsumption.totalCents)}
            </dd>
            {Object.entries(closure.declared).map(([method, d]) => (
              <div key={method} style={{ display: "contents" }}>
                <dt>Conferido: {method === "pix" ? "Pix" : method === "card_debit" ? "cartão de débito" : "cartão de crédito"}</dt>
                <dd>
                  {formatBRL(d?.declaredCents ?? 0)} · {differenceText(d?.differenceCents ?? 0)}
                </dd>
              </div>
            ))}
            {closure.note && (
              <>
                <dt>Observação do operador</dt>
                <dd>{closure.note}</dd>
              </>
            )}
            <dt>Revisão</dt>
            <dd data-testid="fin-review-status">
              {session.review ? REVIEW_TEXT[session.review.status] : "—"}
              {session.review?.note && <span className="muted"> · “{session.review.note}” ({session.review.byName ?? "administração"}{session.review.selfReview ? ", revisão do próprio caixa" : ""})</span>}
            </dd>
          </dl>
          <MethodTable live={{ receiptCount: closure.receiptCount, byMethod: closure.byMethod, expectedCashCents: closure.expectedCashCents, walletConsumption: closure.walletConsumption }} />
        </>
      )}
      {live && (
        <>
          <h2>Recebido até agora</h2>
          <MethodTable live={live} />
        </>
      )}

      {session.afterClose && session.afterClose.count > 0 && (
        <div role="alert" className="notice notice-error" data-testid="fin-after-close">
          <strong>Movimentos depois do fechamento</strong>
          <ul className="plain-list">
            {session.afterClose.newReceipts.map((r) => (
              <li key={r.ref}>Recebimento novo · {formatBRL(r.grossCents)} · {r.ref}</li>
            ))}
            {session.afterClose.newReversals.map((r) => (
              <li key={r.ref}>Estorno posterior · {formatBRL(r.addedCents)} · {r.ref}</li>
            ))}
          </ul>
          <p>O fechamento acima não foi alterado. Reabra o caixa para o operador incluir estes movimentos num novo fechamento.</p>
        </div>
      )}

      {canReview && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onReview(decision, note.trim());
          }}
        >
          <h2>Revisar a divergência</h2>
          <p className="muted">Aprovar ou manter em apuração apenas registra a decisão. Nada é lançado na carteira, nos recebimentos, no estoque nem no livro; um lançamento compensatório só existe por decisão própria.</p>
          <fieldset className="choice-group">
            <legend>Decisão</legend>
            {(Object.keys(REVIEW_DECISION_LABEL) as ReviewDecision[]).map((d) => (
              <label key={d}>
                <input type="radio" name="fin-decision" checked={decision === d} onChange={() => setDecision(d)} /> {REVIEW_DECISION_LABEL[d]}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="fin-note">Nota da revisão (mínimo 10 caracteres)</label>
            <input id="fin-note" type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} data-testid="fin-note" />
          </div>
          <button type="submit" disabled={locked || note.trim().length < 10} data-testid="fin-review">
            Registrar revisão
          </button>
        </form>
      )}

      {session.status === "closed" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onReopen(reason.trim());
          }}
        >
          <h2>Reabrir o caixa</h2>
          <p className="muted">O operador poderá incluir os movimentos posteriores e fechar de novo. O fechamento atual continua guardado como versão anterior.</p>
          <div className="field">
            <label htmlFor="fin-reason">Motivo da reabertura (mínimo 10 caracteres)</label>
            <input id="fin-reason" type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="fin-reason" />
          </div>
          <button type="submit" className="secondary" disabled={locked || reason.trim().length < 10} data-testid="fin-reopen">
            Reabrir caixa
          </button>
        </form>
      )}

      <h2>Histórico</h2>
      <ul className="plain-list" data-testid="fin-history">
        {session.events.map((e, i) => (
          <li key={`${e.type}-${i}`}>
            {when(e.at)} · {EVENT_TEXT[e.type] ?? e.type}
            {e.closureNo ? ` (fechamento ${e.closureNo})` : ""} · {e.byName}
            {e.reason && <span className="muted"> · “{e.reason}”</span>}
          </li>
        ))}
      </ul>
      {session.history.length > 0 && (
        <ul className="plain-list">
          {session.history.map((h) => (
            <li key={h.no}>
              Fechamento {h.no} · {when(h.closedAt)} · esperado {formatBRL(h.expectedCashCents)} · contado {formatBRL(h.countedCashCents)} · {differenceText(h.cashDifferenceCents)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const EVENT_TEXT: Record<string, string> = { opened: "Caixa aberto", closed: "Caixa fechado", reopened: "Caixa reaberto", reviewed: "Divergência revisada" };

export function CashSessionDetail({ user, sessionId }: { user: User; sessionId: string }) {
  const q = useServerQuery<SessionView>(user, `/api/cash/${sessionId}`, "");
  const submit = usePosSubmit(user);
  const [message, setMessage] = useState<Message | null>(null);
  const locked = submit.busy || submit.uncertain;

  async function run(url: string, body: Record<string, unknown>, ok: string) {
    setMessage(null);
    const r = await submit.submit(url, { sessionId, ...body });
    if (!r) return;
    setMessage(r.ok ? { kind: "ok", text: ok } : { kind: "error", text: errorText(r.error) });
    q.reload();
  }

  if (q.status === "loading") return <p role="status" className="muted">Carregando…</p>;
  if (!q.data) return <p role="alert" className="notice notice-error">{errorText(q.errorCode ?? "internal")}</p>;
  return (
    <SessionDetailView
      session={q.data}
      message={message}
      locked={locked}
      onReview={(decision, note) => void run("/api/admin/finance/cash/review", { closureNo: q.data!.closureNo, decision, note }, decision === "approved" ? "Divergência aprovada, sem ajuste." : "Divergência mantida em apuração.")}
      onReopen={(reason) => void run("/api/admin/finance/cash/reopen", { reason }, "Caixa reaberto. O fechamento anterior foi preservado.")}
    />
  );
}
