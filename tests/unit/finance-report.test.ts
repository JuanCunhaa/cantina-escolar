import { describe, expect, it } from "vitest";
import { buildReport, brl, detailCsv, monthRange, summaryCsv, DETAIL_HEADER, SUMMARY_HEADER } from "@/modules/reports/finance-report";
import type { Receipt } from "@/modules/fees/receipts";

const TODAY = "2026-10-09";
function receipt(over: Partial<Receipt> & { id: string }): Receipt {
  return {
    kind: "topup",
    ref: `topup:${over.id}`,
    point: "secretaria",
    operatorUid: "u1",
    operatorName: "Operadora",
    method: "card_credit",
    sourceId: "term_x",
    receivedOn: "2026-10-05",
    receivedAtIso: "2026-10-05T15:00:00.000Z",
    grossCents: 5000,
    reversedCents: 0,
    fee: { status: "pending", cents: null, source: "operator" },
    feeEstimate: null,
    settlement: { status: "pending", expectedOn: "2026-11-04", settledOn: null, expectedSource: "rule", expectedBasis: "calendar_days", expectedDays: 30, expectedRuleVersion: 1 },
    financeVersion: 0,
    label: "Aluno",
    reference: null,
    status: "confirmed",
    ...over,
  };
}
const estimate = (cents: number, fictitious = true) => ({ cents, seriesId: "term_x__card_credit", ruleVersion: 1, effectiveFrom: "2026-10-01", percentBp: 300, fixedCents: 0, settlementDays: 30, settlementBasis: "calendar_days" as const, fictitious, computedOn: "2026-10-05" });

describe("F20 — dinheiro em reais para a planilha (inteiro exato)", () => {
  it("formata centavos sem ponto flutuante e sem separador de milhar", () => {
    expect([0, 5, 99, 100, 123_456, 1_000_000].map(brl)).toEqual(["0,00", "0,05", "0,99", "1,00", "1234,56", "10000,00"]);
    expect(brl(-150)).toBe("-1,50");
  });
});

describe("F20 — o relatório conta cada recebimento UMA vez e separa as bases da taxa", () => {
  const list = [
    receipt({ id: "a", feeEstimate: estimate(150) }), // estimada
    receipt({ id: "b", feeEstimate: estimate(150), fee: { status: "confirmed", cents: 148, source: "operator" }, settlement: { status: "settled", expectedOn: "2026-11-04", settledOn: "2026-10-08", expectedSource: "rule" } }), // conferida
    receipt({ id: "c", method: "pix", fee: { status: "informed", cents: 20, source: "operator" }, settlement: { status: "settled", expectedOn: null, settledOn: "2026-10-05", expectedSource: null } }), // informada
    receipt({ id: "d", method: "cash", fee: { status: "none", cents: 0, source: "not_applicable" }, settlement: { status: "cash_on_hand", expectedOn: null, settledOn: null }, grossCents: 1500 }),
    receipt({ id: "e", method: "pix", sourceId: "default", settlement: { status: "settled", expectedOn: null, settledOn: "2026-10-05", expectedSource: null }, grossCents: 3000 }), // sem taxa conhecida
    receipt({ id: "f", settlement: { status: "pending", expectedOn: "2026-10-01", settledOn: null, expectedSource: "operator" }, feeEstimate: estimate(150, false) }), // vencida
  ];
  const report = buildReport(list, { from: "2026-10-01", to: "2026-10-31" }, TODAY, { truncated: false, production: false });

  it("totais por base: conferida, informada e estimada somam a taxa efetiva; sem valor fica de fora do líquido", () => {
    const t = report.totals;
    expect(t).toMatchObject({ count: 6, grossCents: 5000 * 4 + 1500 + 3000 });
    expect(t.feeConfirmedCents).toBe(148);
    expect(t.feeInformedCents).toBe(20);
    expect(t.feeEstimatedCents).toBe(300); // a e f; b NÃO soma a estimativa (tem valor real)
    expect(t.feeUnknownCount).toBe(1);
    expect(t.feeUnknownGrossCents).toBe(3000);
    expect(t.feeEffectiveCents).toBe(148 + 20 + 300);
    expect(t.feeConfirmedCents + t.feeInformedCents + t.feeEstimatedCents).toBe(t.feeEffectiveCents);
    expect(t.netExpectedCents).toBe(t.grossCents - 3000 - t.feeEffectiveCents);
    expect(t.netRealCents).toBe(5000 - 148 + 1500); // só conferida e dinheiro
  });

  it("liquidação: liquidada × pendente × vencida; dinheiro fora; regra fictícia contada", () => {
    expect(report.totals).toMatchObject({ settledCount: 3, settledGrossCents: 5000 + 5000 + 3000, pendingCount: 2, pendingGrossCents: 10_000, overdueCount: 1, overdueGrossCents: 5000, fictitiousCount: 2 });
  });

  it("as linhas somam o total e não repetem recebimento", () => {
    const sum = (k: "count" | "grossCents" | "feeEffectiveCents") => report.rows.reduce((n, r) => n + r[k], 0);
    expect(sum("count")).toBe(report.totals.count);
    expect(sum("grossCents")).toBe(report.totals.grossCents);
    expect(sum("feeEffectiveCents")).toBe(report.totals.feeEffectiveCents);
  });

  it("estorno fica à parte e não devolve a taxa", () => {
    const r = buildReport([receipt({ id: "x", method: "pix", fee: { status: "informed", cents: 20, source: "operator" }, reversedCents: 1000 })], { from: TODAY, to: TODAY }, TODAY, { truncated: false, production: false });
    expect(r.totals).toMatchObject({ grossCents: 5000, reversedCents: 1000, feeInformedCents: 20, netExpectedCents: 4980 });
  });
});

describe("F20 — exportação CSV: detalhe e resumo conferem; texto livre neutralizado", () => {
  const list = [
    receipt({ id: "a", feeEstimate: estimate(150), operatorName: "=1+1" }),
    receipt({ id: "b", method: "pix", sourceId: "default", fee: { status: "confirmed", cents: 99, source: "operator" }, settlement: { status: "settled", expectedOn: null, settledOn: "2026-10-05", expectedSource: null }, operatorName: "@cmd|' /C calc'!A0" }),
    receipt({ id: "c", kind: "direct_sale", point: "counter", method: "cash", fee: { status: "none", cents: 0, source: "not_applicable" }, settlement: { status: "cash_on_hand", expectedOn: null, settledOn: null }, grossCents: 1234, operatorName: null }),
  ];

  it("o detalhe tem uma linha por recebimento e o resumo, o mesmo bruto e a mesma taxa", () => {
    const rows = detailCsv(list).trim().split("\r\n");
    expect(rows).toHaveLength(1 + list.length);
    expect(rows[0]!.split(";")).toEqual(DETAIL_HEADER);
    const report = buildReport(list, { from: "2026-10-01", to: "2026-10-31" }, TODAY, { truncated: false, production: false });
    const summary = summaryCsv(report).trim().split("\r\n");
    expect(summary[0]!.split(";")).toEqual(SUMMARY_HEADER);
    const total = summary.at(-1)!.split(";");
    expect(total[0]).toBe("TOTAL");
    expect(total[SUMMARY_HEADER.indexOf("Recebimentos")]).toBe("3");
    expect(total[SUMMARY_HEADER.indexOf("Bruto (R$)")]).toBe(brl(5000 + 5000 + 1234));
    expect(total[SUMMARY_HEADER.indexOf("Taxa efetiva (R$)")]).toBe(brl(150 + 99));
  });

  it("fórmulas em nomes viram texto; valores monetários saem como número pt-BR; vazio é vazio", () => {
    const csv = detailCsv(list);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@cmd");
    expect(csv).not.toMatch(/(^|;)=1\+1/m);
    const first = csv.trim().split("\r\n")[1]!.split(";");
    expect(first[DETAIL_HEADER.indexOf("Bruto (R$)")]).toBe("50,00");
    expect(first[DETAIL_HEADER.indexOf("Base da taxa")]).toBe("estimada");
    expect(first[DETAIL_HEADER.indexOf("Liquidação prevista")]).toBe("04/11/2026");
    expect(first[DETAIL_HEADER.indexOf("Base da previsão")]).toBe("30 dias corridos pela regra v1"); // a base usada na previsão vai no arquivo
    const cash = csv.trim().split("\r\n")[3]!.split(";");
    expect(cash[DETAIL_HEADER.indexOf("Operador")]).toBe("");
    expect(cash[DETAIL_HEADER.indexOf("Liquidação")]).toBe("dinheiro no caixa");
  });
});

describe("F20 — mês da exportação", () => {
  it("do primeiro ao último dia, inclusive em fevereiro bissexto e dezembro", () => {
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31", month: "2026-10" });
    expect(monthRange("2028-02").to).toBe("2028-02-29");
    expect(monthRange("2026-12").to).toBe("2026-12-31");
    expect(() => monthRange("2026-13")).toThrow();
    expect(() => monthRange("26-10")).toThrow();
    expect(() => monthRange(null)).toThrow();
  });
});
