"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { addDays, localDateOf } from "@/lib/dates/school-time";
import { useServerQuery } from "@/modules/orders/use-operations";
import { usePosSubmit } from "@/modules/pos/use-pos";
import { POINT_LABEL } from "@/modules/fees/receipt-labels";
import { ALERT_LABEL, SESSION_STATUS_LABEL, type CashAlert, type CashPoint } from "../cash-model";
import type { MyCash } from "../cash-queries";
import { closeCashAction, openCashAction, type CloseDraft, type Message } from "@/modules/fees/finance-actions";
import { CashPointView } from "./cash-point";
import { brDate, differenceText } from "./cash-text";

/** Alertas do próprio operador: nunca bloqueiam o dia; cada um leva a abrir/fechar a data pendente. */
export function CashAlerts({ alerts, onPick }: { alerts: CashAlert[]; onPick: (date: string) => void }) {
  if (alerts.length === 0) return null;
  return (
    <section aria-labelledby="cash-alerts-title" data-testid="cash-alerts">
      <h2 id="cash-alerts-title">Pendências de caixa ({alerts.length})</h2>
      <p className="muted">Estes avisos não impedem você de trabalhar hoje.</p>
      <ul className="plain-list">
        {alerts.map((a) => (
          <li key={`${a.kind}-${a.date}-${a.point}`}>
            <strong>{ALERT_LABEL[a.kind]}</strong> · {POINT_LABEL[a.point]} · {brDate(a.date)}
            {a.detail && a.kind !== "open_not_closed" && <span className="muted"> · {a.detail}</span>}{" "}
            {(a.kind === "open_not_closed" || a.kind === "receipts_without_session") && (
              <button type="button" className="secondary" onClick={() => onPick(a.date)}>
                Ir para este dia
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RecentClosings({ recent }: { recent: MyCash["recent"] }) {
  if (recent.length === 0) return null;
  return (
    <section aria-labelledby="cash-recent-title">
      <h2 id="cash-recent-title">Seus últimos caixas</h2>
      <ul className="plain-list" data-testid="cash-recent">
        {recent.map((r) => (
          <li key={r.sessionId}>
            {brDate(r.date)} · {POINT_LABEL[r.point]} · {SESSION_STATUS_LABEL[r.status]}
            {r.cashDifferenceCents !== null && <span className="muted"> · {differenceText(r.cashDifferenceCents)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Caixa do PRÓPRIO operador (secretaria, cantina ou administração): abrir com saldo inicial confirmado, ver o que entrou em dinheiro,
 * Pix e cartão (compra com saldo não conta), contar a gaveta pelo total e fechar. O resultado vem da RESPOSTA do servidor;
 * resposta perdida repete a mesma chave. Divergência (qualquer centavo) fica pendente para a administração.
 */
export function CashDesk({ user }: { user: User }) {
  const today = localDateOf(new Date());
  const [date, setDate] = useState(today);
  const cash = useServerQuery<MyCash>(user, "/api/cash", `date=${date}`);
  const submit = usePosSubmit(user);
  const [message, setMessage] = useState<Message | null>(null);
  const locked = submit.busy || submit.uncertain;

  async function open(point: CashPoint, openingCents: number) {
    setMessage(null);
    const result = await openCashAction(submit.submit, { point, date, openingCents });
    if (result) setMessage(result);
    cash.reload();
  }

  async function close(sessionId: string, draft: CloseDraft) {
    setMessage(null);
    const result = await closeCashAction(submit.submit, sessionId, draft);
    if (result) setMessage(result);
    cash.reload();
  }

  return (
    <section aria-labelledby="cash-title">
      <h1 id="cash-title">Caixa</h1>
      <p className="muted">Seu caixa do dia: o que você recebeu em dinheiro, Pix e cartão, e a contagem da gaveta. Cada pessoa fecha o próprio caixa.</p>
      <div className="field">
        <label htmlFor="cash-date">Data do caixa</label>
        <input id="cash-date" type="date" value={date} max={today} min={addDays(today, -7)} disabled={locked} onChange={(e) => e.target.value && setDate(e.target.value)} data-testid="cash-date" />
      </div>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid="cash-message">
          {message.text}
        </p>
      )}
      {submit.uncertain && <p role="alert" className="notice">Sem resposta do servidor. Repita a ação para conferir: a mesma operação é reaproveitada, sem duplicar nada.</p>}
      {cash.status === "loading" && <p role="status" className="muted">Carregando…</p>}
      {cash.status === "error" && !cash.data && <p role="alert" className="notice notice-error">{errorText(cash.errorCode ?? "internal")}</p>}
      {cash.data && (
        <>
          <CashAlerts alerts={cash.data.alerts} onPick={setDate} />
          {cash.data.points.map((p) => (
            <CashPointView key={p.point} point={p.point} date={cash.data!.date} session={p.session} live={p.live} locked={locked} onOpen={(cents) => void open(p.point, cents)} onClose={(draft) => void close(p.sessionId, draft)} />
          ))}
          <RecentClosings recent={cash.data.recent} />
        </>
      )}
    </section>
  );
}
