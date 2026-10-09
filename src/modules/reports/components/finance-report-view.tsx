"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import { brDate } from "@/modules/cash/components/cash-text";
import { FinanceTabs } from "@/modules/fees/components/finance-tabs";
import { POINT_LABEL, RECEIPT_KIND_LABEL } from "@/modules/fees/receipt-labels";
import { PAYMENT_LABEL } from "@/modules/payments/methods";
import { useServerQuery } from "@/modules/orders/use-operations";
import type { FinanceReport } from "../finance-report";

export type ReportViewProps = {
  report: FinanceReport;
  from: string;
  to: string;
  onRange: (from: string, to: string) => void;
  onExport: (view: "detail" | "summary") => void;
  exporting: boolean;
  message: string | null;
};

/** Relatório financeiro base: recebimentos externos (não inclui compra com saldo, transferência, CMV nem estoque). Base de data explícita. */
export function ReportView({ report, from, to, onRange, onExport, exporting, message }: ReportViewProps) {
  const t = report.totals;
  return (
    <section aria-labelledby="rep-title">
      <h1 id="rep-title">Financeiro</h1>
      <FinanceTabs current="/operacao/financeiro/relatorio" />
      <p className="muted">
        Base de datas: <strong>data do recebimento</strong> (America/Sao_Paulo). Recarga não é receita de venda; compra com saldo da carteira, transferência e reserva não aparecem aqui porque não são dinheiro recebido. A taxa de cada recebimento entra uma única vez: conferida, senão informada, senão estimada.
      </p>
      {!report.production && t.fictitiousCount > 0 && (
        <p role="note" className="notice" data-testid="rep-fictitious">
          {t.fictitiousCount} recebimento(s) com estimativa de regra FICTÍCIA (homologação). Não representam taxas reais.
        </p>
      )}
      <div className="toolbar">
        <div className="field">
          <label htmlFor="rep-from">De</label>
          <input id="rep-from" type="date" value={from} onChange={(e) => e.target.value && onRange(e.target.value, to)} />
        </div>
        <div className="field">
          <label htmlFor="rep-to">Até</label>
          <input id="rep-to" type="date" value={to} onChange={(e) => e.target.value && onRange(from, e.target.value)} />
        </div>
      </div>

      <h2>Resumo de {brDate(report.from)} a {brDate(report.to)}</h2>
      <dl className="receipt-grid" data-testid="rep-totals">
        <dt>Recebimentos</dt>
        <dd>{t.count}</dd>
        <dt>Valor bruto recebido</dt>
        <dd>{formatBRL(t.grossCents)}</dd>
        <dt>Estornado / devolvido</dt>
        <dd>{formatBRL(t.reversedCents)}</dd>
        <dt>Taxa conferida</dt>
        <dd>{formatBRL(t.feeConfirmedCents)}</dd>
        <dt>Taxa informada no recebimento</dt>
        <dd>{formatBRL(t.feeInformedCents)}</dd>
        <dt>Taxa estimada pela regra</dt>
        <dd>{formatBRL(t.feeEstimatedCents)}</dd>
        <dt>Sem taxa conhecida</dt>
        <dd>
          {t.feeUnknownCount} recebimento(s) · {formatBRL(t.feeUnknownGrossCents)} (fora do líquido)
        </dd>
        <dt>Taxa efetiva (soma, sem repetir)</dt>
        <dd>{formatBRL(t.feeEffectiveCents)}</dd>
        <dt>Líquido previsto</dt>
        <dd>{formatBRL(t.netExpectedCents)}</dd>
        <dt>Líquido real (taxa conferida e dinheiro)</dt>
        <dd>{formatBRL(t.netRealCents)}</dd>
        <dt>Liquidado na conta</dt>
        <dd>
          {t.settledCount} · {formatBRL(t.settledGrossCents)}
        </dd>
        <dt>A liquidar</dt>
        <dd>
          {t.pendingCount} · {formatBRL(t.pendingGrossCents)}
        </dd>
        <dt>Liquidação vencida</dt>
        <dd>
          {t.overdueCount} · {formatBRL(t.overdueGrossCents)}
        </dd>
      </dl>
      {report.truncated && <p role="alert" className="notice notice-error">Relatório parcial: há recebimentos demais no período. Reduza o intervalo.</p>}

      <h2>Por origem, forma e fonte</h2>
      {report.rows.length === 0 && <p className="muted">Nenhum recebimento no período.</p>}
      {report.rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table" data-testid="rep-rows">
            <caption className="visually-hidden">Recebimentos agrupados</caption>
            <thead>
              <tr>
                <th scope="col">Origem</th>
                <th scope="col">Forma</th>
                <th scope="col">Fonte</th>
                <th scope="col">Qtde</th>
                <th scope="col">Bruto</th>
                <th scope="col">Estornado</th>
                <th scope="col">Taxa efetiva</th>
                <th scope="col">Líquido previsto</th>
                <th scope="col">A liquidar</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={`${r.kind}-${r.point}-${r.method}-${r.sourceId}`}>
                  <th scope="row">
                    {RECEIPT_KIND_LABEL[r.kind]} <span className="muted">({POINT_LABEL[r.point]})</span>
                  </th>
                  <td>{PAYMENT_LABEL[r.method]}</td>
                  <td>{r.sourceId}</td>
                  <td>{r.count}</td>
                  <td>{formatBRL(r.grossCents)}</td>
                  <td>{formatBRL(r.reversedCents)}</td>
                  <td>
                    {formatBRL(r.feeEffectiveCents)}
                    {r.feeUnknownCount > 0 && <span className="muted"> · {r.feeUnknownCount} sem taxa</span>}
                  </td>
                  <td>{formatBRL(r.netExpectedCents)}</td>
                  <td>
                    {formatBRL(r.pendingGrossCents)}
                    {r.overdueCount > 0 && <span className="badge badge-cancelled"> {r.overdueCount} vencida(s)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Exportar o mês de {brDate(report.to).slice(3)}</h2>
      <p className="muted">CSV com separador “;”, UTF-8 e texto neutralizado contra fórmulas. O resumo é calculado pelos mesmos recebimentos do detalhe.</p>
      {message && <p role="alert" className="notice notice-error">{message}</p>}
      <div className="checkout-actions">
        <button type="button" disabled={exporting} onClick={() => onExport("detail")} data-testid="rep-export-detail">
          Exportar detalhe (CSV)
        </button>{" "}
        <button type="button" className="secondary" disabled={exporting} onClick={() => onExport("summary")} data-testid="rep-export-summary">
          Exportar resumo (CSV)
        </button>
      </div>
    </section>
  );
}

export function FinanceReportPage({ user }: { user: User }) {
  const today = localDateOf(new Date());
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const q = useServerQuery<FinanceReport>(user, "/api/admin/finance/report", `from=${range.from}&to=${range.to}`);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function download(view: "detail" | "summary") {
    setExporting(true);
    setMessage(null);
    try {
      const month = range.to.slice(0, 7);
      const response = await fetch(`/api/admin/finance/export?month=${month}&view=${view}`, { headers: { authorization: `Bearer ${await user.getIdToken()}` } });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage(body.error === "export_truncated" ? "Há recebimentos demais no mês para uma exportação completa." : errorText(body.error ?? "internal"));
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `financeiro-${view === "detail" ? "detalhe" : "resumo"}-${month}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setMessage(errorText("network"));
    } finally {
      setExporting(false);
    }
  }

  if (q.status === "loading") return <p role="status" className="muted">Carregando…</p>;
  if (!q.data) return <p role="alert" className="notice notice-error">{errorText(q.errorCode ?? "internal")}</p>;
  return <ReportView report={q.data} from={range.from} to={range.to} onRange={(from, to) => setRange({ from: from > to ? to : from, to })} onExport={(v) => void download(v)} exporting={exporting} message={message} />;
}

