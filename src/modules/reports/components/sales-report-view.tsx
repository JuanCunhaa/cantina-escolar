"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { localDateOf } from "@/lib/dates/school-time";
import { microsToCents } from "@/modules/inventory/cost";
import { formatBRL } from "@/lib/money/format";
import { brDate } from "@/modules/cash/components/cash-text";
import { bpDecimal } from "../format";
import { FinanceTabs } from "@/modules/fees/components/finance-tabs";
import { useServerQuery } from "@/modules/orders/use-operations";
import {
  ADJUSTMENT_LABEL,
  CANCELLATION_KIND_LABEL,
  LEDGER_TYPE_LABEL,
  LOSS_REASON_LABEL,
  PURCHASE_KIND_LABEL,
  labelOf,
  pendencyLabel,
} from "../sales-labels";
import {
  CHANNELS,
  CHANNEL_LABEL,
  PENDING_LABEL,
  type Filters,
  type GroupRow,
  type OperationalProductRow,
  type OperationalReport,
  type OperationalRow,
  type ProductRow,
  type RankKey,
  type SalesReport,
} from "../sales-model";
import { PRESETS, exportSalesAction, presetRange, salesQuery, type PresetId, type SalesParams } from "../sales-actions";
import type { SalesView } from "../sales-tables";
import type { ExportDeps } from "@/modules/fees/finance-actions";

type Report = SalesReport | OperationalReport;

/** Dependências reais do navegador para o download (token do usuário, `fetch`, link temporário). */
export function browserExport(user: User): ExportDeps {
  return {
    token: () => user.getIdToken(),
    fetchFn: (url, init) => fetch(url, init),
    save: (blob, filename) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  };
}

/** Pontos-base → "47,50 %" (inteiros, sem ponto flutuante). */
export function bpText(bp: number | null): string {
  return bp === null ? "—" : `${bpDecimal(bp)} %`;
}

const PENDING = "pendente";
const EXPORT_VIEWS: { id: SalesView; label: string; full: boolean }[] = [
  { id: "summary", label: "Resumo do período", full: false },
  { id: "products", label: "Por produto", full: false },
  { id: "detail", label: "Detalhe das vendas", full: false },
  { id: "losses", label: "Perdas", full: false },
  { id: "pending", label: "Pedidos a realizar", full: false },
  { id: "cancellations", label: "Cancelamentos", full: false },
  { id: "purchases", label: "Compras de estoque", full: true },
  { id: "ledger", label: "Carteiras (livro)", full: true },
];

/* ---------------------------------------------------------------------------------------------------- avisos */

export function ReportNotices({ report }: { report: Report }) {
  const fictitiousRules = report.scope === "full" ? (report.fees?.fictitiousCount ?? 0) : 0;
  return (
    <>
      {!report.production && (
        <p role="note" className="notice" data-testid="sales-fictitious">
          Ambiente de teste/homologação: os valores abaixo vêm de dados FICTÍCIOS e não representam a operação real da escola.
          {fictitiousRules > 0 && ` ${fictitiousRules} recebimento(s) usam regra de taxa FICTÍCIA.`}
        </p>
      )}
      {report.truncated.length > 0 && (
        <p role="alert" className="notice notice-error" data-testid="sales-truncated">
          Relatório PARCIAL: há registros demais em {report.truncated.join(", ")}. Reduza o intervalo; a exportação fica bloqueada até lá.
        </p>
      )}
      {report.pendencies.length > 0 && (
        <div role="note" className="notice" data-testid="sales-pendencies">
          <strong>Pendências (não tratadas como zero):</strong>
          <ul className="plain-list">
            {report.pendencies.map((p) => (
              <li key={p.code}>
                {pendencyLabel(p.code)}: {p.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.projection && (
        <p className="muted" data-testid="sales-projection">
          Fonte dos dias: {report.projection.cachedDays} do cache diário, {report.projection.builtDays} preparados agora, {report.projection.liveDays} ao vivo{report.projection.building.length > 0 ? `, ${report.projection.building.length} em preparação` : ""}.
        </p>
      )}
      {Object.entries(report.skipped).length > 0 && (
        <p role="note" className="muted" data-testid="sales-skipped">
          Seções que não seguem os filtros ativos foram omitidas: {Object.values(report.skipped).length} (limpe os filtros para vê-las).
        </p>
      )}
    </>
  );
}

/* --------------------------------------------------------------------------------------------------- filtros */

export type FilterBarProps = {
  report: Report | null;
  params: SalesParams;
  onParams: (next: SalesParams) => void;
  today: string;
};

export function FilterBar({ report, params, onParams, today }: FilterBarProps) {
  const setFilter = (key: keyof Filters, value: string) => {
    const filters: Filters = { ...params.filters };
    if (value === "") delete filters[key];
    else (filters as Record<string, string>)[key] = value;
    onParams({ ...params, filters });
  };
  const options = report?.options;
  return (
    <div className="toolbar no-print">
      <div className="field">
        <label htmlFor="rs-from">De</label>
        <input id="rs-from" type="date" value={params.from} onChange={(e) => e.target.value && onParams({ ...params, from: e.target.value, to: e.target.value > params.to ? e.target.value : params.to })} />
      </div>
      <div className="field">
        <label htmlFor="rs-to">Até</label>
        <input id="rs-to" type="date" value={params.to} onChange={(e) => e.target.value && onParams({ ...params, to: e.target.value, from: e.target.value < params.from ? e.target.value : params.from })} />
      </div>
      <div className="field">
        <label htmlFor="rs-preset">Período pronto</label>
        <select id="rs-preset" value="" onChange={(e) => e.target.value && onParams({ ...params, ...presetRange(e.target.value as PresetId, today) })}>
          <option value="">Escolher…</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="rs-shift">Turno</label>
        <select id="rs-shift" value={params.filters.shiftId ?? ""} onChange={(e) => setFilter("shiftId", e.target.value)}>
          <option value="">Todos</option>
          {options?.shifts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="rs-category">Categoria</label>
        <select id="rs-category" value={params.filters.categoryId ?? ""} onChange={(e) => setFilter("categoryId", e.target.value)}>
          <option value="">Todas</option>
          {options?.categories.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="rs-product">Produto</label>
        <select id="rs-product" value={params.filters.productId ?? ""} onChange={(e) => setFilter("productId", e.target.value)}>
          <option value="">Todos</option>
          {options?.products.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="rs-channel">Canal</label>
        <select id="rs-channel" value={params.filters.channel ?? ""} onChange={(e) => setFilter("channel", e.target.value)}>
          <option value="">Todos</option>
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ vendas realizadas */

function profitText(complete: boolean, completeUnits: number, cents: number): string {
  if (completeUnits === 0) return PENDING;
  return `${formatBRL(cents)}${complete ? "" : " (parcial)"}`;
}

export function RealizedSummary({ report }: { report: Report }) {
  const t = report.realized.totals;
  return (
    <section aria-labelledby="rs-realized">
      <h2 id="rs-realized">Vendas realizadas (entregas e balcão)</h2>
      <p className="muted">
        Base de datas: <strong>{report.dateBasis.sales}</strong>. Recarga, reserva e transferência não são receita: só a baixa de estoque é.
      </p>
      <dl className="receipt-grid" data-testid="sales-totals">
        <dt>Unidades vendidas</dt>
        <dd>{t.units}</dd>
        <dt>Receita realizada</dt>
        <dd>{formatBRL(t.revenueCents)}</dd>
        {report.scope === "full" ? (
          <>
            <dt>CMV (custo histórico das unidades vendidas)</dt>
            <dd>{formatBRL(report.realized.totals.cogsCents)}</dd>
            <dt>Lucro bruto</dt>
            <dd data-testid="sales-profit">
              {profitText(report.realized.totals.complete, report.realized.totals.completeUnits, report.realized.totals.grossProfitCents)}
              {!report.realized.totals.complete && <span className="badge badge-warn"> incompleto</span>}
            </dd>
            <dt>Margem bruta</dt>
            <dd>{bpText(report.realized.totals.marginBp)}</dd>
            <dt>Unidades sem custo / sem receita</dt>
            <dd>
              {report.realized.totals.missingCostUnits} / {report.realized.totals.missingRevenueUnits}
            </dd>
          </>
        ) : (
          <>
            <dt>Pedidos/vendas distintos</dt>
            <dd>{report.realized.totals.origins}</dd>
            <dt>Ticket médio</dt>
            <dd>{report.realized.totals.ticketAverageCents === null ? "—" : formatBRL(report.realized.totals.ticketAverageCents)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

type AnyRow = Pick<OperationalRow, "key" | "label" | "units" | "revenueCents"> & Partial<Pick<GroupRow, "cogsCents" | "grossProfitCents" | "complete" | "marginBp" | "completeUnits">>;
export function GroupTable({ title, rows, scope, testId }: { title: string; rows: AnyRow[]; scope: Report["scope"]; testId: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="table-scroll">
      <table className="data-table" data-testid={testId}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{title.replace(/^Por /, "")}</th>
            <th scope="col">Unidades</th>
            <th scope="col">Receita</th>
            {scope === "full" && (
              <>
                <th scope="col">CMV</th>
                <th scope="col">Lucro bruto</th>
                <th scope="col">Margem</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const full = r.completeUnits !== undefined ? r : null;
            return (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td>{r.units}</td>
                <td>{formatBRL(r.revenueCents)}</td>
                {scope === "full" && full && (
                  <>
                    <td>{formatBRL(full.cogsCents ?? 0)}</td>
                    <td>{profitText(full.complete ?? false, full.completeUnits ?? 0, full.grossProfitCents ?? 0)}</td>
                    <td>{bpText(full.marginBp ?? null)}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const RANK_LABEL: Record<RankKey | "lowTurnover", string> = {
  units: "Mais vendidos (unidades)",
  revenue: "Mais vendidos (valor)",
  profit: "Maior lucro bruto total",
  profitPerUnit: "Maior lucro por unidade",
  margin: "Maior margem percentual",
  lowTurnover: "Baixo giro (menos vendidos, inclusive sem venda)",
};

/** Ranking escolhido pelo usuário; lucro absoluto, lucro por unidade e margem % são listas DIFERENTES e rotuladas. */
export function RankingSection({ report }: { report: Report }) {
  const keys: (RankKey | "lowTurnover")[] = report.scope === "full" ? ["units", "revenue", "profit", "profitPerUnit", "margin", "lowTurnover"] : ["units", "revenue", "lowTurnover"];
  const [by, setBy] = useState<RankKey | "lowTurnover">("units");
  const chosen = keys.includes(by) ? by : "units";
  const rankings = report.realized.rankings as Record<string, unknown>;
  const rows = rankings[chosen] as (ProductRow | OperationalProductRow | { productId: string; name: string; units: number })[];
  return (
    <section aria-labelledby="rs-rank">
      <h2 id="rs-rank">Rankings de produtos</h2>
      <div className="field">
        <label htmlFor="rs-rank-by">Classificar por</label>
        <select id="rs-rank-by" value={chosen} onChange={(e) => setBy(e.target.value as RankKey | "lowTurnover")}>
          {keys.map((k) => (
            <option key={k} value={k}>
              {RANK_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="muted">Nenhum produto com esta medida no período.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="sales-ranking">
            <caption>{RANK_LABEL[chosen]}</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Produto</th>
                <th scope="col">Unidades</th>
                {chosen !== "lowTurnover" && <th scope="col">Receita</th>}
                {report.scope === "full" && chosen !== "lowTurnover" && (
                  <>
                    <th scope="col">Lucro bruto</th>
                    <th scope="col">Lucro por unidade</th>
                    <th scope="col">Margem</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const full = "completeUnits" in r ? r : null;
                return (
                  <tr key={r.productId}>
                    <td>{i + 1}</td>
                    <th scope="row">{r.name}</th>
                    <td>{r.units}</td>
                    {chosen !== "lowTurnover" && <td>{"revenueCents" in r ? formatBRL(r.revenueCents) : "—"}</td>}
                    {report.scope === "full" && chosen !== "lowTurnover" && (
                      <>
                        <td>{full ? profitText(full.complete, full.completeUnits, full.grossProfitCents) : "—"}</td>
                        <td>{full?.profitPerUnitCents == null ? "—" : formatBRL(full.profitPerUnitCents)}</td>
                        <td>{full ? bpText(full.marginBp) : "—"}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------- perdas, a realizar, cancelamentos */

export function LossesSection({ report }: { report: Report }) {
  if (!report.losses) return null;
  const full = report.scope === "full";
  const rows = report.losses.rows;
  return (
    <section aria-labelledby="rs-losses">
      <h2 id="rs-losses">Perdas</h2>
      <p className="muted">{full ? "Perdas ficam FORA do CMV. " : ""}{report.dateBasis.losses}.</p>
      {rows.length === 0 && <p className="muted">Nenhuma perda no período.</p>}
      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table" data-testid="sales-losses">
            <caption className="visually-hidden">Perdas por produto e motivo</caption>
            <thead>
              <tr>
                <th scope="col">Produto</th>
                <th scope="col">Motivo</th>
                <th scope="col">Unidades</th>
                {full && <th scope="col">Custo</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.productId}-${r.reasonCode}`}>
                  <th scope="row">{r.name}</th>
                  <td>{labelOf(LOSS_REASON_LABEL, r.reasonCode)}</td>
                  <td>{r.units}</td>
                  {full && "costMicros" in r && <td>{r.missingCostUnits > 0 ? `${PENDING} (${r.missingCostUnits} un.)` : formatBRL(microsToCents(r.costMicros))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function PendingSection({ report }: { report: Report }) {
  const p = report.pending;
  if (!p) return null;
  return (
    <section aria-labelledby="rs-pending">
      <h2 id="rs-pending">Pedidos pagos ainda não realizados</h2>
      <p className="muted">
        Posição de hoje ({brDate(p.asOf)}). Dinheiro já recebido, mas ainda sem entrega: <strong>não é receita realizada</strong>.
      </p>
      <dl className="receipt-grid" data-testid="sales-pending">
        {p.buckets.map((b) => (
          <div key={b.bucket} className="receipt-row">
            <dt>{PENDING_LABEL[b.bucket]}</dt>
            <dd>
              {formatBRL(b.valueCents)} · {b.orders} pedido(s) · {b.units} unidade(s)
            </dd>
          </div>
        ))}
        <dt>Total a realizar</dt>
        <dd>{formatBRL(p.totals.valueCents)}</dd>
        {report.scope === "full" && report.pending?.estimate && (
          <>
            <dt>Custo estimado (custo médio atual)</dt>
            <dd>
              {formatBRL(report.pending.estimate.costCents)}
              {report.pending.estimate.missingCostUnits > 0 && ` · ${report.pending.estimate.missingCostUnits} un. sem custo médio`}
            </dd>
            <dt>Margem estimada (não é resultado)</dt>
            <dd>{formatBRL(report.pending.estimate.marginCents)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

export function CancellationsSection({ report }: { report: Report }) {
  const c = report.cancellations;
  const retained = report.retained;
  if (!c && !retained) return null;
  return (
    <section aria-labelledby="rs-cancel">
      <h2 id="rs-cancel">Cancelamentos, reembolsos e cobrança retida</h2>
      {c && (
        <>
          <p className="muted">{report.dateBasis.cancellations}. Reembolso volta à carteira de origem: não é saída de dinheiro do banco.</p>
          <dl className="receipt-grid" data-testid="sales-cancellations">
            {c.byKind.map((k) => (
              <div key={k.kind} className="receipt-row">
                <dt>{labelOf(CANCELLATION_KIND_LABEL, k.kind)}</dt>
                <dd>
                  {formatBRL(k.refundCents)} · {k.events} cancelamento(s) · {k.units} unidade(s)
                </dd>
              </div>
            ))}
            <dt>Total reembolsado</dt>
            <dd>{formatBRL(c.totals.refundCents)}</dd>
          </dl>
        </>
      )}
      {retained && (
        <p data-testid="sales-retained">
          Cobrança retida (não retirado encerrado com cobrança): <strong>{formatBRL(retained.amountCents)}</strong> em {retained.orders} pedido(s). Não é venda entregue, nem reembolso, nem perda.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ só administração */

export function ResultSection({ report }: { report: SalesReport }) {
  const r = report.result;
  return (
    <section aria-labelledby="rs-result">
      <h2 id="rs-result">Resultado após perdas e taxas</h2>
      {r === null ? (
        <p className="muted">{report.skipped.result ?? "Indisponível."}</p>
      ) : (
        <>
          <dl className="receipt-grid" data-testid="sales-result">
            <dt>Lucro bruto</dt>
            <dd>{formatBRL(r.grossProfitCents)}</dd>
            <dt>Perdas (fora do CMV)</dt>
            <dd>− {formatBRL(r.lossCostCents)}</dd>
            <dt>Taxas do período (uma por recebimento)</dt>
            <dd>− {formatBRL(r.feesCents)}</dd>
            <dt>Resultado após perdas e taxas</dt>
            <dd>
              <strong>{formatBRL(r.resultCents)}</strong> {r.definitive ? <span className="badge">definitivo</span> : <span className="badge badge-warn">PARCIAL — veja as pendências</span>}
            </dd>
          </dl>
          <p className="muted">{r.note} As taxas seguem a data do recebimento e podem cair em mês diferente das vendas.</p>
          {report.fees && report.fees.unknownCount > 0 && (
            <p role="note" className="notice">
              {report.fees.unknownCount} recebimento(s) sem taxa conhecida: a taxa NÃO foi tratada como zero.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function ReceiptsSection({ report }: { report: SalesReport }) {
  const r = report.receipts;
  if (!r) return null;
  return (
    <section aria-labelledby="rs-receipts">
      <h2 id="rs-receipts">Recebimentos externos, taxas e liquidação</h2>
      <p className="muted">
        Dinheiro que ENTROU ({report.dateBasis.fees}), separado da venda e do crédito de carteira. Recarga credita a carteira pelo valor bruto, mas não é receita de lanche. Detalhe por forma e fonte em Financeiro → Relatório.
      </p>
      <dl className="receipt-grid" data-testid="sales-receipts">
        <dt>Recebido (bruto)</dt>
        <dd>
          {formatBRL(r.grossCents)} · {r.count} recebimento(s)
        </dd>
        <dt>Estornado / devolvido</dt>
        <dd>{formatBRL(r.reversedCents)}</dd>
        <dt>Taxa conferida / informada / estimada</dt>
        <dd>
          {formatBRL(r.feeConfirmedCents)} / {formatBRL(r.feeInformedCents)} / {formatBRL(r.feeEstimatedCents)} (uma por recebimento)
        </dd>
        <dt>Sem taxa conhecida</dt>
        <dd>{r.feeUnknownCount} recebimento(s), fora do líquido</dd>
        <dt>Líquido previsto / real</dt>
        <dd>
          {formatBRL(r.netExpectedCents)} / {formatBRL(r.netRealCents)}
        </dd>
        <dt>Liquidado / a liquidar / vencido</dt>
        <dd>
          {formatBRL(r.settledGrossCents)} / {formatBRL(r.pendingGrossCents)} / {formatBRL(r.overdueGrossCents)}
        </dd>
      </dl>
    </section>
  );
}

export function PurchasesSection({ report }: { report: SalesReport }) {
  const p = report.purchases;
  if (!p) return null;
  return (
    <section aria-labelledby="rs-purchases">
      <h2 id="rs-purchases">Compras de estoque</h2>
      <p className="muted">Aplicação de caixa em mercadoria, SEPARADA do CMV e fora do resultado: a mercadoria só vira custo quando é vendida. {report.dateBasis.purchases}.</p>
      <dl className="receipt-grid" data-testid="sales-purchases">
        {p.rows.map((x) => (
          <div key={x.kind} className="receipt-row">
            <dt>{labelOf(PURCHASE_KIND_LABEL, x.kind)}</dt>
            <dd>
              {formatBRL(microsToCents(x.costMicros))} · {x.units} unidade(s) em {x.facts} entrada(s)
            </dd>
          </div>
        ))}
        {p.reversals.facts > 0 && (
          <div className="receipt-row">
            <dt>Estornos de entrada feitos no período</dt>
            <dd>
              − {formatBRL(microsToCents(p.reversals.costMicros))} · {p.reversals.units} unidade(s) em {p.reversals.facts} estorno(s)
            </dd>
          </div>
        )}
        <dt>Total líquido no período</dt>
        <dd>{formatBRL(p.netCostCents)}</dd>
      </dl>
      {report.adjustments && report.adjustments.rows.length > 0 && (
        <p className="muted">
          Ajustes de estoque (fora do resultado):{" "}
          {report.adjustments.rows.map((a) => `${labelOf(ADJUSTMENT_LABEL, a.type)}: ${a.units} un. (${formatBRL(microsToCents(a.costMicros))})`).join("; ")}
        </p>
      )}
    </section>
  );
}

export function LedgerSection({ report }: { report: SalesReport }) {
  const l = report.ledger;
  if (!l) return null;
  return (
    <section aria-labelledby="rs-ledger">
      <h2 id="rs-ledger">Carteiras (livro de movimentos)</h2>
      <p className="muted">Recarga credita a carteira, mas NÃO é receita de venda. Transferência entre alunos não é faturamento. {report.dateBasis.ledger}.</p>
      <dl className="receipt-grid" data-testid="sales-ledger">
        {l.rows.map((x) => (
          <div key={x.type} className="receipt-row">
            <dt>{labelOf(LEDGER_TYPE_LABEL, x.type)}</dt>
            <dd>
              {formatBRL(x.amountCents)} · {x.entries} lançamento(s)
            </dd>
          </div>
        ))}
        <dt>Variação líquida no período</dt>
        <dd>{formatBRL(l.netCents)}</dd>
        <dt>Saldo agregado atual das carteiras</dt>
        <dd>{l.walletBalanceCents === null ? "indisponível" : `${formatBRL(l.walletBalanceCents)} em ${l.walletCount ?? 0} carteira(s)`}</dd>
      </dl>
    </section>
  );
}

export function ReversalsSection({ report }: { report: SalesReport }) {
  const r = report.reversals;
  if (!r) return null;
  return (
    <section aria-labelledby="rs-reversals">
      <h2 id="rs-reversals">Reversões externas pendentes (reembolso e chargeback)</h2>
      <p className="muted">Posição de hoje, não do período. Pendência aberta ainda não é perda nem entra no resultado; o que a escola absorve é decisão de negócio registrada à parte.</p>
      <dl className="receipt-grid" data-testid="sales-reversals">
        <dt>Pendências abertas</dt>
        <dd>
          {r.open} · {formatBRL(r.outstandingCents)} a recuperar
        </dd>
        <dt>Recuperado do saldo das carteiras</dt>
        <dd>{formatBRL(r.recoveredCents)}</dd>
        <dt>Absorvido pela escola (acumulado)</dt>
        <dd>{formatBRL(r.writtenOffCents)}</dd>
      </dl>
    </section>
  );
}

export function ChecksSection({ report }: { report: SalesReport }) {
  const bad = report.checks.filter((c) => !c.ok);
  return (
    <section aria-labelledby="rs-checks">
      <h2 id="rs-checks">Conferências dos totais</h2>
      {bad.length === 0 ? (
        <p className="muted" data-testid="sales-checks">
          Fecham: {report.checks.filter((c) => c.kind === "cross").length} conferência(s) entre fontes independentes (reembolsos × livro, transferências, vendas × valor pago) e {report.checks.filter((c) => c.kind === "internal").length} de consistência interna (produto, categoria, canal, turno e dia somam o mesmo total).
        </p>
      ) : (
        <ul role="alert" className="plain-list notice notice-error" data-testid="sales-checks">
          {bad.map((c) => (
            <li key={c.id}>
              {c.label}: esperado {c.expected}, obtido {c.actual}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------------- exportação */

export type ExportPanelProps = { scope: Report["scope"]; exporting: boolean; message: string | null; onExport: (view: SalesView, format: "csv" | "xlsx") => void };

export function ExportPanel({ scope, exporting, message, onExport }: ExportPanelProps) {
  const views = EXPORT_VIEWS.filter((v) => scope === "full" || !v.full);
  const [view, setView] = useState<SalesView>("summary");
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  return (
    <section aria-labelledby="rs-export" className="no-print">
      <h2 id="rs-export">Exportar</h2>
      <div className="toolbar">
        <div className="field">
          <label htmlFor="rs-export-view">O que exportar</label>
          <select id="rs-export-view" value={view} onChange={(e) => setView(e.target.value as SalesView)}>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rs-export-format">Formato</label>
          <select id="rs-export-format" value={format} onChange={(e) => setFormat(e.target.value === "xlsx" ? "xlsx" : "csv")}>
            <option value="csv">CSV (UTF-8, separador “;”)</option>
            <option value="xlsx">Planilha XLSX</option>
          </select>
        </div>
      </div>
      <p className="muted">Respeita o período e os filtros acima. Texto é neutralizado contra fórmulas e a exportação é recusada (nunca truncada) se o período tiver registros demais.</p>
      {message && (
        <p role="alert" className="notice notice-error">
          {message}
        </p>
      )}
      <button type="button" disabled={exporting} onClick={() => onExport(view, format)} data-testid="sales-export">
        Exportar
      </button>
    </section>
  );
}

/* ----------------------------------------------------------------------------------------------------- tela */

export type SalesReportViewProps = {
  report: Report | null;
  error?: string | null;
  params: SalesParams;
  onParams: (next: SalesParams) => void;
  today: string;
  onExport: (view: SalesView, format: "csv" | "xlsx") => void;
  exporting: boolean;
  message: string | null;
  tabs?: boolean;
};

export function SalesReportView({ report, error = null, params, onParams, today, onExport, exporting, message, tabs = false }: SalesReportViewProps) {
  return (
    <section aria-labelledby="rs-title">
      <h1 id="rs-title">Relatórios de vendas</h1>
      {tabs && <FinanceTabs current="/operacao/relatorios" />}
      <FilterBar report={report} params={params} onParams={onParams} today={today} />
      {!report && !error && (
        <p role="status" className="muted">
          Carregando…
        </p>
      )}
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      {report && (
        <>
          <p className="muted">
            Período de {brDate(report.from)} a {brDate(report.to)}.
          </p>
          <ReportNotices report={report} />
          <RealizedSummary report={report} />
          <RankingSection report={report} />
          <GroupTable title="Por produto" rows={report.realized.byProduct.map((p) => ({ ...p, key: p.productId, label: p.name }))} scope={report.scope} testId="sales-by-product" />
          <GroupTable title="Por categoria" rows={report.realized.byCategory} scope={report.scope} testId="sales-by-category" />
          <GroupTable title="Por canal" rows={report.realized.byChannel} scope={report.scope} testId="sales-by-channel" />
          <GroupTable title="Por turno" rows={report.realized.byShift} scope={report.scope} testId="sales-by-shift" />
          <GroupTable title="Por dia" rows={report.realized.byDay} scope={report.scope} testId="sales-by-day" />
          {report.scope === "full" && <ResultSection report={report} />}
          {report.scope === "full" && <ReceiptsSection report={report} />}
          <LossesSection report={report} />
          {report.scope === "full" && <PurchasesSection report={report} />}
          <PendingSection report={report} />
          <CancellationsSection report={report} />
          {report.scope === "full" && <LedgerSection report={report} />}
          {report.scope === "full" && <ReversalsSection report={report} />}
          {report.scope === "full" && <ChecksSection report={report} />}
        </>
      )}
      <ExportPanel scope={report?.scope ?? "operational"} exporting={exporting} message={message} onExport={onExport} />
    </section>
  );
}

export function SalesReportPage({ user, tabs }: { user: User; tabs: boolean }) {
  const today = localDateOf(new Date());
  const [params, setParams] = useState<SalesParams>({ ...presetRange("month", today), filters: {} });
  // Sem releitura a cada foco da janela: cada abertura custa leituras do Firestore.
  const q = useServerQuery<Report>(user, "/api/reports/sales", salesQuery(params), true, false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function download(view: SalesView, format: "csv" | "xlsx") {
    setExporting(true);
    setMessage(null);
    setMessage(await exportSalesAction(browserExport(user), params, view, format));
    setExporting(false);
  }

  const error = q.status === "error" && !q.data ? errorText(q.errorCode ?? "internal") : null;
  return <SalesReportView report={q.data} error={error} params={params} onParams={setParams} today={today} onExport={(v, f) => void download(v, f)} exporting={exporting} message={message} tabs={tabs} />;
}
