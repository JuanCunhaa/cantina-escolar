import { microsToCents } from "@/modules/inventory/cost";
import { CHANNEL_LABEL, OPERATIONAL_SECTIONS, PENDING_LABEL, SECTION_LABEL, operationalPendency, type SectionName, type SaleFact, type SalesReport } from "./sales-model";
import { CANCELLATION_KIND_LABEL, LEDGER_TYPE_LABEL, LOSS_REASON_LABEL, PURCHASE_KIND_LABEL, ADJUSTMENT_LABEL, labelOf, pendencyLabel } from "./sales-labels";
import { centsCell, intCell, microsCell, percentCell, type Cell, type Table } from "./table";

/**
 * Tabelas de exportação dos relatórios de vendas (F21). Cada tabela sai da MESMA projeção da tela (`SalesReport`) e, no detalhe,
 * dos MESMOS fatos: resumo e detalhe conferem (A29). Escopo `operational` (cantina) NUNCA inclui custo, CMV, margem, lucro, taxa
 * nem carteira: as colunas simplesmente não existem. Valor desconhecido é célula vazia ou texto "pendente", jamais "0,00".
 */
export const SALES_VIEWS = ["summary", "products", "detail", "losses", "purchases", "pending", "cancellations", "ledger"] as const;
export type SalesView = (typeof SALES_VIEWS)[number];

const date = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function situationOf(f: SaleFact): string {
  if (f.revenueCents === null && f.costMicros === null) return "Sem custo e sem receita";
  if (f.costMicros === null) return "Sem custo registrado";
  if (f.revenueCents === null) return "Sem receita registrada";
  return f.originFound ? "Completo" : "Completo (origem não encontrada)";
}

export function buildSalesTables(report: SalesReport, sales: readonly SaleFact[], scope: "full" | "operational"): Partial<Record<SalesView, Table>> {
  const full = scope === "full";
  const out: Partial<Record<SalesView, Table>> = {};
  const r = report.realized;
  const categoryLabel = new Map(r.byCategory.map((c) => [c.key, c.label]));
  const shiftLabel = new Map(r.byShift.map((c) => [c.key, c.label]));

  /* ------------------------------------------------------------------------------------------------ resumo */
  const s: Cell[][] = [];
  const row = (section: string, indicator: string, value: Cell, note = "") => s.push([section, indicator, value, note]);
  row("Período", "De", date(report.from), report.dateBasis.sales);
  row("Período", "Até", date(report.to));
  row("Ambiente", report.production ? "Produção" : "Teste / homologação", report.production ? "" : "Dados FICTÍCIOS: não representam a operação real da escola");
  if (full && report.fees && report.fees.fictitiousCount > 0 && !report.production) row("Ambiente", "Recebimentos com regra de taxa FICTÍCIA", intCell(report.fees.fictitiousCount), "taxas estimadas de teste, não representam taxas reais");
  const f = report.filters;
  row("Filtros", "Turno / produto / categoria / canal", [f.shiftId ?? "todos", f.productId ?? "todos", f.categoryId ?? "todos", f.channel ? CHANNEL_LABEL[f.channel] : "todos"].join(" / "));
  row("Vendas realizadas", "Unidades entregues/vendidas", intCell(r.totals.units), "Receita realizada = baixa de estoque; recarga e reserva não entram");
  row("Vendas realizadas", "Receita (R$)", centsCell(r.totals.revenueCents), r.totals.missingRevenueUnits > 0 ? `${r.totals.missingRevenueUnits} unidade(s) sem receita registrada ficam fora` : "");
  if (full) {
    row("Vendas realizadas", "CMV (R$)", centsCell(r.totals.cogsCents), r.totals.missingCostUnits > 0 ? `${r.totals.missingCostUnits} unidade(s) sem custo ficam fora do CMV` : "custo histórico da baixa");
    row("Vendas realizadas", "CMV exato (R$)", microsCell(r.totals.costMicros));
    row("Vendas realizadas", "Lucro bruto (R$)", centsCell(r.totals.grossProfitCents), r.totals.complete ? "definitivo" : "PARCIAL: há vendas sem custo ou sem receita");
    row("Vendas realizadas", "Margem bruta (%)", percentCell(r.totals.marginBp));
  } else {
    row("Vendas realizadas", "Pedidos/vendas distintos", intCell(r.origins));
  }
  if (report.losses) {
    row("Perdas", "Unidades perdidas", intCell(report.losses.totals.units), report.dateBasis.losses);
    if (full) row("Perdas", "Custo das perdas (R$)", centsCell(report.losses.totals.costCents), report.losses.totals.missingCostUnits > 0 ? `${report.losses.totals.missingCostUnits} unidade(s) sem custo` : "fora do CMV");
  }
  if (full && report.adjustments) {
    for (const a of report.adjustments.rows) row("Ajustes de estoque (fora do resultado)", labelOf(ADJUSTMENT_LABEL, a.type), centsCell(microsToCents(a.costMicros)), `${a.units} unidade(s) líquidas, ${a.facts} registro(s)`);
  }
  if (full && report.fees) {
    row("Taxas", "Taxa efetiva do período (R$)", centsCell(report.fees.effectiveCents), `${report.dateBasis.fees}; conferida > informada > estimada, uma só por recebimento`);
    row("Taxas", "Recebimentos sem taxa conhecida", intCell(report.fees.unknownCount), "não tratados como taxa zero");
  }
  if (full && report.result) {
    row("Resultado", "Resultado após perdas e taxas (R$)", centsCell(report.result.resultCents), report.result.definitive ? "definitivo" : "PARCIAL: veja as pendências");
    row("Resultado", "Observação", report.result.note);
  } else if (full && report.skipped.result) {
    row("Resultado", "Resultado após perdas e taxas", "não calculado", report.skipped.result);
  }
  if (full && report.purchases) {
    for (const p of report.purchases.rows) row("Compras de estoque (fora do resultado)", labelOf(PURCHASE_KIND_LABEL, p.kind), centsCell(microsToCents(p.costMicros)), `${p.units} unidade(s) em ${p.facts} entrada(s); ${p.reversedFacts} estornada(s)`);
    row("Compras de estoque (fora do resultado)", "Total (R$)", centsCell(report.purchases.netCostCents), report.dateBasis.purchases);
  }
  if (report.pending) {
    for (const b of report.pending.buckets) row("Pedidos pagos a realizar", PENDING_LABEL[b.bucket], centsCell(b.valueCents), `${b.orders} pedido(s), ${b.units} unidade(s)`);
    row("Pedidos pagos a realizar", "Total a realizar (R$)", centsCell(report.pending.totals.valueCents), report.dateBasis.pending);
    if (full && report.pending.estimate) {
      row("Pedidos pagos a realizar", "Custo ESTIMADO (R$)", centsCell(report.pending.estimate.costCents), "custo médio atual; só vira CMV na baixa");
      row("Pedidos pagos a realizar", "Margem ESTIMADA (R$)", centsCell(report.pending.estimate.marginCents), report.pending.estimate.missingCostUnits > 0 ? `${report.pending.estimate.missingCostUnits} unidade(s) sem custo médio` : "estimativa");
    }
  }
  if (report.retained) row("Cobrança retida (não retirado)", "Valor mantido (R$)", centsCell(report.retained.amountCents), `${report.retained.orders} pedido(s); não é venda entregue nem reembolso`);
  if (report.cancellations) {
    for (const k of report.cancellations.byKind) row("Cancelamentos e reembolsos", labelOf(CANCELLATION_KIND_LABEL, k.kind), centsCell(k.refundCents), `${k.events} cancelamento(s), ${k.units} unidade(s)`);
    row("Cancelamentos e reembolsos", "Total reembolsado (R$)", centsCell(report.cancellations.totals.refundCents), report.dateBasis.cancellations);
  }
  if (full && report.ledger) {
    for (const l of report.ledger.rows) row("Carteiras (livro)", labelOf(LEDGER_TYPE_LABEL, l.type), centsCell(l.amountCents), `${l.entries} lançamento(s)`);
    row("Carteiras (livro)", "Saldo agregado atual das carteiras (R$)", centsCell(report.ledger.walletBalanceCents), report.ledger.walletBalanceCents === null ? "indisponível" : `${report.ledger.walletCount ?? 0} carteira(s)`);
  }
  for (const p of report.pendencies.filter((x) => full || operationalPendency(x.code))) row("Pendências", pendencyLabel(p.code), intCell(p.count), p.detail);
  if (full) for (const c of report.checks) row("Conferências", c.label, c.ok ? "OK" : `DIVERGE (esperado ${c.expected}, obtido ${c.actual})`);
  for (const [sec, why] of Object.entries(report.skipped)) if (full || OPERATIONAL_SECTIONS.includes(sec as SectionName)) row("Seções omitidas", SECTION_LABEL[sec as SectionName], "omitida", why);
  out.summary = { name: "Resumo", header: ["Seção", "Indicador", "Valor", "Observação"], rows: s };

  /* ---------------------------------------------------------------------------------------------- produtos */
  const prodHeader = full
    ? ["Produto", "Categoria", "Unidades", "Receita (R$)", "CMV (R$)", "CMV exato (R$)", "Lucro bruto (R$)", "Margem bruta (%)", "Lucro por unidade (R$)", "Unidades sem custo", "Unidades sem receita", "Situação"]
    : ["Produto", "Categoria", "Unidades", "Receita (R$)"];
  const prodRows: Cell[][] = r.byProduct.map((p) => {
    const cat = p.categoryId ? (categoryLabel.get(p.categoryId) ?? p.categoryId) : "Sem categoria";
    return full
      ? [p.name, cat, intCell(p.units), centsCell(p.revenueCents), centsCell(p.cogsCents), microsCell(p.costMicros), centsCell(p.grossProfitCents), percentCell(p.marginBp), centsCell(p.profitPerUnitCents), intCell(p.missingCostUnits), intCell(p.missingRevenueUnits), p.complete ? "Completo" : "PARCIAL"]
      : [p.name, cat, intCell(p.units), centsCell(p.revenueCents)];
  });
  const t = r.totals;
  prodRows.push(
    full
      ? ["TOTAL", "", intCell(t.units), centsCell(t.revenueCents), centsCell(t.cogsCents), microsCell(t.costMicros), centsCell(t.grossProfitCents), percentCell(t.marginBp), "", intCell(t.missingCostUnits), intCell(t.missingRevenueUnits), t.complete ? "Completo" : "PARCIAL"]
      : ["TOTAL", "", intCell(t.units), centsCell(t.revenueCents)],
  );
  out.products = { name: "Produtos", header: prodHeader, rows: prodRows };

  /* ---------------------------------------------------------------------------------------------- detalhe */
  const detailHeader = full
    ? ["Data", "Origem", "Produto", "Categoria", "Canal", "Turno", "Unidades", "Receita (R$)", "CMV exato (R$)", "Situação", "Movimento de estoque"]
    : ["Data", "Origem", "Produto", "Categoria", "Canal", "Turno", "Unidades", "Receita (R$)"];
  const ordered = [...sales].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  out.detail = {
    name: "Detalhe",
    header: detailHeader,
    rows: ordered.map((x): Cell[] => {
      const base: Cell[] = [date(x.date), x.origin, x.productName, x.categoryId ? (categoryLabel.get(x.categoryId) ?? x.categoryId) : "Sem categoria", CHANNEL_LABEL[x.channel], x.shiftId ? (shiftLabel.get(x.shiftId) ?? x.shiftId) : "Sem turno", intCell(x.units), centsCell(x.revenueCents)];
      return full ? [...base, microsCell(x.costMicros), situationOf(x), x.id] : base;
    }),
  };

  /* ------------------------------------------------------------------------------------------------ perdas */
  if (report.losses) {
    const header = full ? ["Produto", "Motivo", "Registros", "Unidades", "Custo (R$)", "Custo exato (R$)", "Unidades sem custo"] : ["Produto", "Motivo", "Registros", "Unidades"];
    const rows: Cell[][] = report.losses.rows.map((l) => (full ? [l.name, labelOf(LOSS_REASON_LABEL, l.reasonCode), intCell(l.facts), intCell(l.units), centsCell(microsToCents(l.costMicros)), microsCell(l.costMicros), intCell(l.missingCostUnits)] : [l.name, labelOf(LOSS_REASON_LABEL, l.reasonCode), intCell(l.facts), intCell(l.units)]));
    const lt = report.losses.totals;
    rows.push(full ? ["TOTAL", "", intCell(lt.facts), intCell(lt.units), centsCell(lt.costCents), microsCell(lt.costMicros), intCell(lt.missingCostUnits)] : ["TOTAL", "", intCell(lt.facts), intCell(lt.units)]);
    out.losses = { name: "Perdas", header, rows };
  }

  /* ---------------------------------------------------------------------------------------------- compras */
  if (full && report.purchases) {
    const rows: Cell[][] = report.purchases.byProduct.map((p) => [p.name, intCell(p.units), microsCell(p.costMicros)]);
    rows.push(["TOTAL", intCell(report.purchases.byProduct.reduce((n, p) => n + p.units, 0)), microsCell(report.purchases.netCostMicros)]);
    out.purchases = { name: "Compras", header: ["Produto", "Unidades", "Custo exato (R$)"], rows };
  }

  /* --------------------------------------------------------------------------------------- a realizar */
  if (report.pending) {
    const header = full ? ["Produto", "Unidades a realizar", "Valor pago (R$)", "Custo estimado (R$)"] : ["Produto", "Unidades a realizar", "Valor pago (R$)"];
    const rows: Cell[][] = report.pending.byProduct.map((p) => (full ? [p.name, intCell(p.units), centsCell(p.valueCents), microsCell(p.estimatedCostMicros)] : [p.name, intCell(p.units), centsCell(p.valueCents)]));
    const pt = report.pending.totals;
    rows.push(full ? ["TOTAL", intCell(pt.units), centsCell(pt.valueCents), centsCell(report.pending.estimate?.costCents ?? null)] : ["TOTAL", intCell(pt.units), centsCell(pt.valueCents)]);
    out.pending = { name: "A realizar", header, rows };
  }

  /* ---------------------------------------------------------------------------------------- cancelamentos */
  if (report.cancellations) {
    const rows: Cell[][] = report.cancellations.byKind.map((k) => [labelOf(CANCELLATION_KIND_LABEL, k.kind), intCell(k.events), intCell(k.units), centsCell(k.refundCents)]);
    const ct = report.cancellations.totals;
    rows.push(["TOTAL", intCell(ct.events), intCell(ct.units), centsCell(ct.refundCents)]);
    out.cancellations = { name: "Cancelamentos", header: ["Tipo", "Cancelamentos", "Unidades", "Reembolsado (R$)"], rows };
  }

  /* -------------------------------------------------------------------------------------------- carteira */
  if (full && report.ledger) {
    const rows: Cell[][] = report.ledger.rows.map((l) => [labelOf(LEDGER_TYPE_LABEL, l.type), intCell(l.entries), centsCell(l.amountCents)]);
    rows.push(["Créditos (soma)", "", centsCell(report.ledger.creditedCents)], ["Débitos (soma)", "", centsCell(report.ledger.spentCents)], ["Variação líquida das carteiras", "", centsCell(report.ledger.netCents)]);
    out.ledger = { name: "Carteiras", header: ["Tipo de lançamento", "Lançamentos", "Valor (R$)"], rows };
  }
  return out;
}

