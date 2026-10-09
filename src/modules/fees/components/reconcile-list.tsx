"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { brDate, parseCents } from "@/modules/cash/components/cash-text";
import { useServerQuery } from "@/modules/orders/use-operations";
import { usePosSubmit } from "@/modules/pos/use-pos";
import { PAYMENT_LABEL } from "@/modules/payments/methods";
import { FEE_BASIS_LABEL, SETTLEMENT_BASIS_LABEL, type FeeBasis } from "../fee-model";
import type { Settlement } from "@/modules/payments/topup-model";
import type { ReceiptAdminView, ReconcileList } from "../fee-queries";
import { POINT_LABEL, RECEIPT_KIND_LABEL } from "../receipt-labels";
import { RECONCILE_ERRORS, adminAction, type Message } from "../finance-actions";
import { FinanceTabs } from "./finance-tabs";

/** Origem/base da previsão à vista: pela regra (prazo, base e versão), informada pelo operador ou sem registro. */
export function basisText(s: Settlement): string {
  if (s.expectedSource === "rule" && s.expectedBasis && s.expectedDays !== null && s.expectedDays !== undefined) {
    return `${s.expectedDays} ${SETTLEMENT_BASIS_LABEL[s.expectedBasis]} pela regra${s.expectedRuleVersion ? ` v${s.expectedRuleVersion}` : ""}`;
  }
  return s.expectedSource === "operator" ? "data informada pelo operador" : "origem não registrada";
}

export type ReconcileDraft = { ref: string; expectedVersion: number; actualFeeCents?: number; settledOn?: string; reason?: string };

function Row({ item, today, locked, onSave }: { item: ReceiptAdminView; today: string; locked: boolean; onSave: (d: ReconcileDraft) => void }) {
  const [open, setOpen] = useState(false);
  const [fee, setFee] = useState("");
  const [settled, setSettled] = useState("");
  const [reason, setReason] = useState("");
  const feeCents = parseCents(fee);
  const confirmedFee = item.fee.status === "confirmed";
  const feeInvalid = fee.trim() !== "" && (feeCents === null || feeCents > item.grossCents);
  const needsFee = !confirmedFee && item.method !== "cash";
  const valid = !feeInvalid && (fee.trim() !== "" || settled !== "") && (!confirmedFee || reason.trim().length >= 10 || fee.trim() === "");
  return (
    <>
      <tr data-ref={item.ref} data-overdue={item.overdue}>
        <td>{brDate(item.receivedOn)}</td>
        <td>
          {RECEIPT_KIND_LABEL[item.kind]} · {POINT_LABEL[item.point]}
          <br />
          <span className="muted">{item.label}</span>
        </td>
        <td>{PAYMENT_LABEL[item.method]}</td>
        <td>{formatBRL(item.grossCents)}</td>
        <td>
          {item.effective.cents === null ? "—" : formatBRL(item.effective.cents)}
          <br />
          <span className="muted">{FEE_BASIS_LABEL[item.effective.basis as FeeBasis]}</span>
          {item.estimate && item.effective.basis !== "estimated" && <span className="muted"> · estimada {formatBRL(item.estimate.cents)}</span>}
          {item.estimate?.fictitious && <span className="badge badge-warn"> regra FICTÍCIA</span>}
        </td>
        <td>
          {item.settlement.status === "settled" ? `Liquidada em ${item.settlement.settledOn ? brDate(item.settlement.settledOn) : "—"}` : item.settlement.expectedOn ? `Prevista ${brDate(item.settlement.expectedOn)} · ${basisText(item.settlement)}` : "Previsão pendente (sem prazo configurado)"}
          {item.overdue && <span className="badge badge-cancelled"> vencida</span>}
        </td>
        <td>
          <button type="button" className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Fechar" : "Conferir"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            <form
              className="form-grid"
              onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                onSave({ ref: item.ref, expectedVersion: item.financeVersion, ...(fee.trim() !== "" && feeCents !== null ? { actualFeeCents: feeCents } : {}), ...(settled ? { settledOn: settled } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) });
              }}
            >
              {item.method !== "cash" && (
                <div className="field">
                  <label htmlFor={`fee-${item.ref}`}>Taxa real, R$ {needsFee ? "" : "(corrigir)"}</label>
                  <input type="text" id={`fee-${item.ref}`} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
                </div>
              )}
              <div className="field">
                <label htmlFor={`set-${item.ref}`}>Liquidada em</label>
                <input id={`set-${item.ref}`} type="date" min={item.receivedOn} max={today} value={settled} onChange={(e) => setSettled(e.target.value)} />
              </div>
              {(confirmedFee || item.settlement.status === "settled") && (
                <div className="field field-wide">
                  <label htmlFor={`why-${item.ref}`}>Motivo da correção (mínimo 10 caracteres)</label>
                  <input type="text" id={`why-${item.ref}`} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              )}
              {feeInvalid && <p role="alert" className="notice notice-error">A taxa precisa estar entre zero e {formatBRL(item.grossCents)}.</p>}
              <div>
                <button type="submit" disabled={locked || !valid} data-testid={`save-${item.ref}`}>
                  Salvar conferência
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

export type ReconcileViewProps = { list: ReconcileList; message: Message | null; locked: boolean; onSave: (d: ReconcileDraft) => void };

/** Recebimentos com taxa real ou liquidação ainda por conferir. A conferência não toca a carteira nem o livro. */
export function ReconcileView({ list, message, locked, onSave }: ReconcileViewProps) {
  const overdue = list.items.filter((i) => i.overdue).length;
  return (
    <section aria-labelledby="rec-title">
      <h1 id="rec-title">Financeiro</h1>
      <FinanceTabs current="/operacao/financeiro/conferencia" />
      <p className="muted">
        Informe a taxa REAL (ou o líquido recebido) e a data em que o valor caiu na conta. O relatório usa o valor real; a estimativa pela regra só vale enquanto não há valor real e nunca é somada a ele. O crédito do aluno não muda.
      </p>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid="rec-message">
          {message.text}
        </p>
      )}
      <h2>
        A conferir ({list.items.length}){overdue > 0 && ` · ${overdue} com liquidação vencida`}
      </h2>
      {list.items.length === 0 && <p className="muted">Nada pendente de conferência.</p>}
      {list.items.length > 0 && (
        <div className="table-scroll">
          <table className="data-table" data-testid="rec-table">
            <caption className="visually-hidden">Recebimentos a conferir</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Recebimento</th>
                <th scope="col">Forma</th>
                <th scope="col">Bruto</th>
                <th scope="col">Taxa</th>
                <th scope="col">Liquidação</th>
                <th scope="col">
                  <span className="visually-hidden">Ação</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((i) => (
                <Row key={i.ref} item={i} today={list.today} locked={locked} onSave={onSave} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.truncated && <p className="muted">Lista parcial: confira estes e recarregue.</p>}
    </section>
  );
}

export function ReconcilePage({ user }: { user: User }) {
  const q = useServerQuery<ReconcileList>(user, "/api/admin/finance/receipts", "");
  const submit = usePosSubmit(user);
  const [message, setMessage] = useState<Message | null>(null);
  async function save(d: ReconcileDraft) {
    setMessage(null);
    const result = await adminAction(submit.submit, "/api/admin/finance/reconcile", d, "Conferência registrada. Carteira e livro não foram alterados.", RECONCILE_ERRORS);
    if (result) setMessage(result);
    q.reload();
  }
  if (q.status === "loading") return <p role="status" className="muted">Carregando…</p>;
  if (!q.data) return <p role="alert" className="notice notice-error">{errorText(q.errorCode ?? "internal")}</p>;
  return <ReconcileView list={q.data} message={message} locked={submit.busy || submit.uncertain} onSave={(d) => void save(d)} />;
}
