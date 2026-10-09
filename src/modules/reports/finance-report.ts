import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { addDays, isLocalDate, localDateOf, localInstant, type LocalDate } from "@/lib/dates/school-time";
import { conflict } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { FICTITIOUS_PREFIX, effectiveFee } from "@/modules/fees/fee-model";
import { POINT_LABEL, RECEIPT_KIND_LABEL, receiptOfDirectSale, receiptOfIntent, receiptOfTopup, type Receipt } from "@/modules/fees/receipts";
import { PAYMENT_LABEL, type PaymentMethod } from "@/modules/payments/methods";
import { csvCell } from "@/modules/orders/fulfillment-model";

/**
 * Relatório financeiro base (F20, docs/domains/reports-cash.md §16.3) — SÓ administração (`finance.manage`). Fonte: os próprios
 * documentos de recebimento (recarga manual, recarga online confirmada, venda direta): projeção reconstruível, sem estado próprio.
 *
 * Contas (cada recebimento entra UMA vez):
 *   - bruto = valor recebido; estornado/devolvido é mostrado à parte (a taxa NÃO é devolvida);
 *   - taxa efetiva = conferida > informada > estimada (nunca duas); sem valor = "desconhecida" (fica fora do líquido e é contada);
 *   - líquido previsto = bruto − taxa efetiva (todos com taxa conhecida); líquido REAL = só taxa conferida (ou dinheiro);
 *   - liquidação: liquidado × pendente × vencido (previsão anterior a hoje), em separado.
 * Não entram aqui: compra com saldo da carteira (não é recebimento), transferência entre alunos, reserva, CMV e compra de estoque
 * (F21). Base de data: DATA DO RECEBIMENTO no fuso America/Sao_Paulo.
 */
export const MAX_REPORT_DAYS = 93;
const RANGE = z.object({ from: z.string().refine(isLocalDate), to: z.string().refine(isLocalDate) }).strict();
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export type GroupRow = {
  kind: Receipt["kind"];
  point: Receipt["point"];
  method: PaymentMethod;
  sourceId: string;
  count: number;
  grossCents: number;
  reversedCents: number;
  /** Taxa por base: cada recebimento está em UMA só. */
  feeConfirmedCents: number;
  feeInformedCents: number;
  feeEstimatedCents: number;
  feeUnknownCount: number;
  feeUnknownGrossCents: number;
  feeEffectiveCents: number;
  netExpectedCents: number;
  netRealCents: number;
  settledCount: number;
  settledGrossCents: number;
  pendingCount: number;
  pendingGrossCents: number;
  overdueCount: number;
  overdueGrossCents: number;
  fictitiousCount: number;
};

export type FinanceReport = { from: LocalDate; to: LocalDate; dateBasis: "receivedOn"; rows: GroupRow[]; totals: Omit<GroupRow, "kind" | "point" | "method" | "sourceId">; truncated: boolean; production: boolean };

const zeroRow = (r: Receipt): GroupRow => ({
  kind: r.kind, point: r.point, method: r.method, sourceId: r.sourceId, count: 0, grossCents: 0, reversedCents: 0,
  feeConfirmedCents: 0, feeInformedCents: 0, feeEstimatedCents: 0, feeUnknownCount: 0, feeUnknownGrossCents: 0, feeEffectiveCents: 0,
  netExpectedCents: 0, netRealCents: 0, settledCount: 0, settledGrossCents: 0, pendingCount: 0, pendingGrossCents: 0, overdueCount: 0, overdueGrossCents: 0, fictitiousCount: 0,
});

type Numeric = Exclude<keyof GroupRow, "kind" | "point" | "method" | "sourceId">;
const NUMERIC: readonly Numeric[] = ["count", "grossCents", "reversedCents", "feeConfirmedCents", "feeInformedCents", "feeEstimatedCents", "feeUnknownCount", "feeUnknownGrossCents", "feeEffectiveCents", "netExpectedCents", "netRealCents", "settledCount", "settledGrossCents", "pendingCount", "pendingGrossCents", "overdueCount", "overdueGrossCents", "fictitiousCount"];

/** Acrescenta UM recebimento à linha do grupo (função pura: o relatório e o CSV usam a mesma conta). */
export function accumulate(row: GroupRow, r: Receipt, today: LocalDate): void {
  const fee = effectiveFee(r.fee, r.feeEstimate);
  row.count += 1;
  row.grossCents += r.grossCents;
  row.reversedCents += r.reversedCents;
  if (fee.basis === "confirmed") row.feeConfirmedCents += fee.cents!;
  else if (fee.basis === "informed") row.feeInformedCents += fee.cents!;
  else if (fee.basis === "estimated") row.feeEstimatedCents += fee.cents!;
  if (fee.basis === "unknown") {
    row.feeUnknownCount += 1;
    row.feeUnknownGrossCents += r.grossCents;
  } else {
    row.feeEffectiveCents += fee.cents!;
    row.netExpectedCents += r.grossCents - fee.cents!;
    if (fee.basis === "confirmed" || fee.basis === "none") row.netRealCents += r.grossCents - fee.cents!;
  }
  if (r.method !== "cash") {
    if (r.settlement.status === "settled") {
      row.settledCount += 1;
      row.settledGrossCents += r.grossCents;
    } else if (r.settlement.status === "pending") {
      row.pendingCount += 1;
      row.pendingGrossCents += r.grossCents;
      if (r.settlement.expectedOn !== null && r.settlement.expectedOn < today) {
        row.overdueCount += 1;
        row.overdueGrossCents += r.grossCents;
      }
    }
  }
  if (r.feeEstimate?.fictitious) row.fictitiousCount += 1;
}

export function buildReport(receipts: readonly Receipt[], range: { from: LocalDate; to: LocalDate }, today: LocalDate, meta: { truncated: boolean; production: boolean }): FinanceReport {
  const rows = new Map<string, GroupRow>();
  for (const r of receipts) {
    const key = [r.kind, r.point, r.method, r.sourceId].join("|");
    let row = rows.get(key);
    if (!row) rows.set(key, (row = zeroRow(r)));
    accumulate(row, r, today);
  }
  const ordered = [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.method.localeCompare(b.method) || a.sourceId.localeCompare(b.sourceId));
  const totals = Object.fromEntries(NUMERIC.map((k) => [k, ordered.reduce((n, row) => n + row[k], 0)])) as FinanceReport["totals"];
  return { ...range, dateBasis: "receivedOn", rows: ordered, totals, truncated: meta.truncated, production: meta.production };
}

/** Recebimentos do período, das três origens, por data do recebimento. Teto por coleção; acima dele o relatório avisa `truncated`. */
export async function readReceiptsInRange(db: Firestore, range: { from: LocalDate; to: LocalDate }): Promise<{ receipts: Receipt[]; truncated: boolean }> {
  const CAP = 4000;
  const start = Timestamp.fromDate(localInstant(range.from, "00:00"));
  const end = Timestamp.fromDate(localInstant(addDays(range.to, 1), "00:00"));
  const [topups, sales, intents] = await Promise.all([
    db.collection("topups").where("receivedOn", ">=", range.from).where("receivedOn", "<=", range.to).limit(CAP + 1).get(),
    db.collection("directSales").where("consumptionDate", ">=", range.from).where("consumptionDate", "<=", range.to).limit(CAP + 1).get(),
    db.collection("topupIntents").where("confirmation.confirmedAt", ">=", start).where("confirmation.confirmedAt", "<", end).limit(CAP + 1).get(),
  ]);
  const receipts: Receipt[] = [
    ...topups.docs.slice(0, CAP).map((d) => receiptOfTopup(d.id, d.data())),
    ...sales.docs.slice(0, CAP).map((d) => receiptOfDirectSale(d.id, d.data())),
    ...intents.docs.slice(0, CAP).flatMap((d) => {
      const r = receiptOfIntent(d.id, d.data());
      return r ? [r] : [];
    }),
  ];
  return { receipts: receipts.sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.ref.localeCompare(b.ref)), truncated: topups.size > CAP || sales.size > CAP || intents.size > CAP };
}

function checkRange(raw: unknown): { from: LocalDate; to: LocalDate } {
  const range = RANGE.parse(raw);
  if (range.from > range.to) throw conflict("invalid_range", "Período invertido.");
  if (range.to > addDays(range.from, MAX_REPORT_DAYS - 1)) throw conflict("range_too_long", "Período máximo de ~3 meses.", { maxDays: MAX_REPORT_DAYS });
  return range;
}

export async function financeReport(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<FinanceReport> {
  authorize(actor, "finance.manage");
  const range = checkRange(raw);
  const { receipts, truncated } = await readReceiptsInRange(db, range);
  return buildReport(receipts, range, localDateOf(clock()), { truncated, production: process.env.APP_ENV === "production" });
}

/* --------------------------------------------------------------------------------------------- exportação */

/** Moeda pt-BR a partir de centavos INTEIROS (12345 → "123,45"); texto gerado aqui, nunca vindo de usuário. */
export function brl(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}
const date = (d: LocalDate) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

type Raw = { raw: string };
type Cell = string | Raw;
const money = (cents: number | null): Raw => ({ raw: cents === null ? "" : brl(cents) });
/** Texto livre passa por `csvCell` (aspas e neutralização de fórmula); valores monetários são gerados aqui e não precisam. */
const encode = (c: Cell): string => (typeof c === "string" ? csvCell(c) : c.raw);
const line = (cells: readonly Cell[]) => cells.map(encode).join(";");

const BASIS_CSV = { none: "sem taxa", confirmed: "conferida", informed: "informada", estimated: "estimada", unknown: "sem valor" } as const;

export const DETAIL_HEADER = ["Data do recebimento", "Referência interna", "Tipo", "Ponto", "Operador", "Forma", "Fonte (maquininha/provedor)", "Bruto (R$)", "Estornado (R$)", "Base da taxa", "Taxa efetiva (R$)", "Taxa estimada (R$)", "Regra aplicada", "Regra fictícia", "Líquido previsto (R$)", "Liquidação", "Liquidação prevista", "Liquidação real"];
export const SUMMARY_HEADER = ["Tipo", "Ponto", "Forma", "Fonte", "Recebimentos", "Bruto (R$)", "Estornado (R$)", "Taxa conferida (R$)", "Taxa informada (R$)", "Taxa estimada (R$)", "Sem taxa conhecida", "Taxa efetiva (R$)", "Líquido previsto (R$)", "Líquido real (R$)", "Liquidado (R$)", "Pendente (R$)", "Vencido (R$)", "Com regra fictícia"];
const SETTLEMENT_LABEL = { cash_on_hand: "dinheiro no caixa", settled: "liquidado", pending: "pendente" } as const;

export function detailCsv(receipts: readonly Receipt[]): string {
  const rows = receipts.map((r): Cell[] => {
    const fee = effectiveFee(r.fee, r.feeEstimate);
    return [
      date(r.receivedOn), r.ref, RECEIPT_KIND_LABEL[r.kind], POINT_LABEL[r.point], r.operatorName ?? "", PAYMENT_LABEL[r.method], r.sourceId,
      money(r.grossCents), money(r.reversedCents), BASIS_CSV[fee.basis], money(fee.cents), money(fee.estimatedCents),
      r.feeEstimate ? `${r.feeEstimate.seriesId} v${r.feeEstimate.ruleVersion}` : "", r.feeEstimate?.fictitious ? "Sim" : "Não",
      money(fee.cents === null ? null : r.grossCents - fee.cents), SETTLEMENT_LABEL[r.settlement.status], r.settlement.expectedOn ? date(r.settlement.expectedOn) : "", r.settlement.settledOn ? date(r.settlement.settledOn) : "",
    ];
  });
  return `${[line(DETAIL_HEADER), ...rows.map(line)].join("\r\n")}\r\n`;
}

export function summaryCsv(report: FinanceReport): string {
  const row = (label: [string, string, string, string], t: Omit<GroupRow, "kind" | "point" | "method" | "sourceId">): Cell[] => [
    ...label, String(t.count), money(t.grossCents), money(t.reversedCents), money(t.feeConfirmedCents), money(t.feeInformedCents), money(t.feeEstimatedCents), String(t.feeUnknownCount),
    money(t.feeEffectiveCents), money(t.netExpectedCents), money(t.netRealCents), money(t.settledGrossCents), money(t.pendingGrossCents), money(t.overdueGrossCents), String(t.fictitiousCount),
  ];
  const body = report.rows.map((r) => row([RECEIPT_KIND_LABEL[r.kind], POINT_LABEL[r.point], PAYMENT_LABEL[r.method], r.sourceId], r));
  return `${[line(SUMMARY_HEADER), ...body.map(line), line(row(["TOTAL", "", "", ""], report.totals))].join("\r\n")}\r\n`;
}

export function monthRange(rawMonth: unknown): { from: LocalDate; to: LocalDate; month: string } {
  const month = MONTH.parse(rawMonth);
  const from = `${month}-01`;
  const last = addDays(`${nextMonth(month)}-01`, -1);
  return { from, to: last, month };
}
const nextMonth = (m: string): string => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};

export type FinanceExport = { filename: string; csv: string; dateBasis: string; fictitiousCount: number; production: boolean };

/** Exportação mensal (detalhe ou resumo) da administração; o resumo é calculado pelos MESMOS recebimentos do detalhe. */
export async function exportFinance(db: Firestore, actor: Actor, raw: { month: unknown; view: unknown }, clock: () => Date = () => new Date()): Promise<FinanceExport> {
  authorize(actor, "finance.manage");
  const range = monthRange(raw.month);
  const view = z.enum(["detail", "summary"]).parse(raw.view);
  const { receipts, truncated } = await readReceiptsInRange(db, range);
  if (truncated) throw conflict("export_truncated", "Há recebimentos demais no mês para uma exportação completa.");
  const report = buildReport(receipts, range, localDateOf(clock()), { truncated, production: process.env.APP_ENV === "production" });
  const csv = view === "detail" ? detailCsv(receipts) : summaryCsv(report);
  return { filename: `financeiro-${view === "detail" ? "detalhe" : "resumo"}-${range.month}.csv`, csv: `﻿${csv}`, dateBasis: "data do recebimento (America/Sao_Paulo)", fictitiousCount: report.totals.fictitiousCount, production: report.production };
}

export { FICTITIOUS_PREFIX };
