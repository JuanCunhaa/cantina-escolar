// Projeção de vendas, CMV, margens, perdas, a realizar e cancelamentos (F21) — regras puras. Os valores esperados são calculados À MÃO
// nos comentários (centavos / micro-centavos), não pelo código testado. A20: 100 un. a R$ 1,00 + 100 a R$ 1,10 → média R$ 1,05; vender
// 10 a R$ 2,00 = receita R$ 20,00, CMV R$ 10,50, lucro bruto R$ 9,50. 1 centavo = 1 000 000 micro-centavos.
import { describe, expect, it } from "vitest";
import {
  buildSalesReport,
  dedupeById,
  lowTurnover,
  pendingBucket,
  rankProducts,
  reconcileSales,
  roundDiv,
  skippedReason,
  toOperational,
  type CancellationFact,
  type LedgerFact,
  type LossFact,
  type PendingOrderFact,
  type PurchaseFact,
  type SaleFact,
  type SalesInput,
} from "@/modules/reports/sales-model";
import { buildSalesTables } from "@/modules/reports/sales-tables";
import { tableCsv } from "@/modules/reports/table";
import { crc32, sheetXml, tableXlsx } from "@/modules/reports/xlsx";
import { parseSalesQuery, reportScope } from "@/modules/reports/sales-report";

const c = (cents: number): number => cents * 1_000_000; // centavos → micro-centavos
const TODAY = "2026-10-09";

let n = 0;
function sale(over: Partial<SaleFact> & { productId: string }): SaleFact {
  n += 1;
  return {
    id: `stockCosts/${over.productId}/movements/m${String(n).padStart(9, "0")}`,
    date: "2026-10-05",
    productName: over.productId.toUpperCase(),
    categoryId: "cat_a",
    channel: "counter",
    shiftId: "turno_m",
    units: 1,
    revenueCents: 0,
    costMicros: 0,
    origin: `order:o${n}`,
    originFound: true,
    ...over,
  };
}

function input(over: Partial<SalesInput> = {}): SalesInput {
  return {
    from: "2026-10-01",
    to: "2026-10-31",
    today: TODAY,
    filters: {},
    production: false,
    labels: { categories: { cat_a: "Salgados", cat_b: "Doces" }, shifts: { turno_m: "Manhã", turno_t: "Tarde" } },
    catalog: [],
    sales: [],
    losses: [],
    adjustments: [],
    purchases: [],
    pending: [],
    retained: [],
    cancellations: [],
    ledger: [],
    reversals: [],
    fees: { effectiveCents: 0, unknownCount: 0, unknownGrossCents: 0, fictitiousCount: 0 },
    avgCost: null,
    walletBalanceCents: null,
    walletCount: null,
    truncated: [],
    unreadable: [],
    ...over,
  };
}

describe("F21 — arredondamento e utilidades", () => {
  it("meio para longe do zero, uma vez, em inteiros", () => {
    expect(roundDiv(5, 2)).toBe(3); // 2,5 → 3
    expect(roundDiv(-5, 2)).toBe(-3); // -2,5 → -3
    expect(roundDiv(4, 3)).toBe(1); // 1,33 → 1
    expect(roundDiv(5, 3)).toBe(2); // 1,67 → 2
    expect(() => roundDiv(1, 0)).toThrow(RangeError);
  });

  it("repetição do MESMO documento de origem não conta de novo (replay)", () => {
    const a = sale({ productId: "p1", revenueCents: 200, costMicros: c(105), units: 1 });
    const r = dedupeById([a, a, { ...a }]);
    expect(r.facts).toHaveLength(1);
    expect(r.ignored).toBe(2);
  });
});

describe("F21 — A20: receita, CMV e lucro bruto da venda de 10 unidades", () => {
  it("100×R$1,00 + 100×R$1,10 → média R$1,05; 10 a R$2,00 = R$20,00 − R$10,50 = R$9,50", () => {
    // custo exato da baixa = 10 × R$ 1,05 = R$ 10,50 = 1 050 centavos
    const report = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 10, revenueCents: 2000, costMicros: c(1050) })] }));
    const t = report.realized.totals;
    expect(t.units).toBe(10);
    expect(t.revenueCents).toBe(2000);
    expect(t.cogsCents).toBe(1050);
    expect(t.grossProfitCents).toBe(950);
    expect(t.marginBp).toBe(4750); // 950 ÷ 2000 = 47,50 %
    expect(t.profitPerUnitCents).toBe(95);
    expect(t.complete).toBe(true);
  });

  it("CMV arredondado UMA vez no total, não por baixa (3 × 333,333333 centavos = 1000, não 999)", () => {
    const part = 333_333_333; // 333,333333 centavos
    const sales = [1, 2, 3].map(() => sale({ productId: "p1", revenueCents: 500, costMicros: part }));
    const report = buildSalesReport(input({ sales }));
    expect(report.realized.totals.costMicros).toBe(999_999_999);
    expect(report.realized.totals.cogsCents).toBe(1000); // 999,999999 → 1000
    expect(report.realized.totals.grossProfitCents).toBe(500); // 1500 − 1000
  });

  it("mudar preço/custo atual não toca o histórico: o relatório só usa o snapshot da baixa", () => {
    const old = sale({ productId: "p1", date: "2026-10-02", units: 2, revenueCents: 400, costMicros: c(200) });
    const recent = sale({ productId: "p1", date: "2026-10-08", units: 2, revenueCents: 600, costMicros: c(300) }); // preço e custo subiram depois
    const report = buildSalesReport(input({ sales: [old, recent] }));
    const day = (d: string) => report.realized.byDay.find((x) => x.key === d)!;
    expect([day("2026-10-02").revenueCents, day("2026-10-02").cogsCents, day("2026-10-02").grossProfitCents]).toEqual([400, 200, 200]);
    expect([day("2026-10-08").revenueCents, day("2026-10-08").cogsCents, day("2026-10-08").grossProfitCents]).toEqual([600, 300, 300]);
  });
});

describe("F21 — rankings: lucro absoluto ≠ lucro por unidade ≠ margem %", () => {
  const rows = () => {
    const sales = [
      sale({ productId: "p1", productName: "Coxinha", units: 10, revenueCents: 2000, costMicros: c(1050) }), // lucro 950 · 95/un · 47,50 %
      sale({ productId: "p2", productName: "Brownie", units: 2, revenueCents: 1000, costMicros: c(200) }), // lucro 800 · 400/un · 80,00 %
      sale({ productId: "p3", productName: "Bala", units: 100, revenueCents: 5000, costMicros: c(4000) }), // lucro 1000 · 10/un · 20,00 %
    ];
    return buildSalesReport(input({ sales })).realized.byProduct;
  };

  it("cada ranking usa a sua medida", () => {
    const r = rows();
    const names = (by: Parameters<typeof rankProducts>[1]) => rankProducts(r, by, 10).map((x) => x.name);
    expect(names("units")).toEqual(["Bala", "Coxinha", "Brownie"]); // 100, 10, 2
    expect(names("revenue")).toEqual(["Bala", "Coxinha", "Brownie"]); // 5000, 2000, 1000
    expect(names("profit")).toEqual(["Bala", "Coxinha", "Brownie"]); // 1000, 950, 800
    expect(names("profitPerUnit")).toEqual(["Brownie", "Coxinha", "Bala"]); // 400, 95, 10
    expect(names("margin")).toEqual(["Brownie", "Coxinha", "Bala"]); // 8000, 4750, 2000 bp
  });

  it("respeita o limite e desempata por nome", () => {
    const tie = buildSalesReport(input({ sales: [sale({ productId: "pb", productName: "B", units: 1, revenueCents: 100, costMicros: c(50) }), sale({ productId: "pa", productName: "A", units: 1, revenueCents: 100, costMicros: c(50) })] })).realized.byProduct;
    expect(rankProducts(tie, "units", 1).map((x) => x.name)).toEqual(["A"]);
  });

  it("baixo giro mostra produto ativo SEM nenhuma venda como 0 unidade", () => {
    const sold = rows();
    const low = lowTurnover(sold, [{ productId: "p9", name: "Suco", categoryId: null }, { productId: "p2", name: "Brownie", categoryId: null }], 3);
    expect(low[0]).toEqual({ productId: "p9", name: "Suco", units: 0 });
    expect(low.map((x) => x.units)).toEqual([0, 2, 10]);
  });
});

describe("F21 — informação ausente é pendência, nunca zero", () => {
  const complete = () => sale({ productId: "p1", units: 4, revenueCents: 1000, costMicros: c(400) });
  const noCost = () => sale({ productId: "p1", units: 5, revenueCents: 500, costMicros: null });
  const noRevenue = () => sale({ productId: "p1", units: 2, revenueCents: null, costMicros: c(100) });

  it("venda sem custo: receita conta, CMV não, lucro fica PARCIAL só com o que é completo", () => {
    const t = buildSalesReport(input({ sales: [complete(), noCost()] })).realized.totals;
    expect(t.revenueCents).toBe(1500);
    expect(t.cogsCents).toBe(400);
    expect(t.missingCostUnits).toBe(5);
    expect(t.grossProfitCents).toBe(600); // 1000 − 400 (NÃO 1500 − 400 = 1100, que trataria o custo ausente como zero)
    expect(t.complete).toBe(false);
  });

  it("venda sem receita: custo conta, receita e lucro só do completo", () => {
    const t = buildSalesReport(input({ sales: [complete(), noRevenue()] })).realized.totals;
    expect([t.revenueCents, t.cogsCents, t.missingRevenueUnits, t.grossProfitCents, t.complete]).toEqual([1000, 500, 2, 600, false]);
  });

  it("resultado após perdas e taxas é parcial com pendência e definitivo sem ela", () => {
    const loss: LossFact = { id: "stockCosts/p1/movements/m1", date: "2026-10-04", productId: "p1", productName: "P1", categoryId: "cat_a", reasonCode: "expiry", units: 3, costMicros: c(300), origin: "x" };
    const base = input({ sales: [complete()], losses: [loss], fees: { effectiveCents: 150, unknownCount: 0, unknownGrossCents: 0, fictitiousCount: 0 } });
    const ok = buildSalesReport(base);
    // lucro 1000 − 400 = 600; perdas 300; taxas 150 → 150
    expect(ok.result).toMatchObject({ grossProfitCents: 600, lossCostCents: 300, feesCents: 150, resultCents: 150, definitive: true });
    const withUnknownFee = buildSalesReport({ ...base, fees: { effectiveCents: 150, unknownCount: 2, unknownGrossCents: 10000, fictitiousCount: 0 } });
    expect(withUnknownFee.result?.definitive).toBe(false);
    expect(withUnknownFee.result?.feesCents).toBe(150); // a taxa desconhecida NÃO virou zero escondido: a pendência acompanha o número
    expect(withUnknownFee.pendencies.map((p) => p.code)).toContain("fee_unknown");
    const lossNoCost = buildSalesReport({ ...base, losses: [{ ...loss, costMicros: null }] });
    expect(lossNoCost.result?.definitive).toBe(false);
    expect(lossNoCost.pendencies.map((p) => p.code)).toContain("loss_cost_missing");
  });

  it("fonte truncada ou documento ilegível tornam o resultado parcial", () => {
    const truncated = buildSalesReport(input({ sales: [complete()], truncated: ["movimentos de estoque"] }));
    expect(truncated.result?.definitive).toBe(false);
    expect(truncated.pendencies.map((p) => p.code)).toContain("truncated_movimentos de estoque");
    const unreadable = buildSalesReport(input({ sales: [complete()], unreadable: [{ source: "perdas", count: 2 }] }));
    expect(unreadable.result?.definitive).toBe(false);
  });

  it("baixa sem pedido/venda de origem aparece como origem não identificada, sem esconder", () => {
    const orphan = sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40), channel: "unknown", originFound: false, shiftId: null });
    const r = buildSalesReport(input({ sales: [orphan] }));
    expect(r.realized.byChannel[0]).toMatchObject({ key: "unknown", label: "Origem não identificada" });
    expect(r.pendencies.map((p) => p.code)).toContain("origin_missing");
  });
});

describe("F21 — recarga, compra de estoque, perda e cobrança retida não são receita nem CMV", () => {
  it("perdas, compras, retido e carteira ficam FORA da receita e do CMV", () => {
    const sales = [sale({ productId: "p1", units: 10, revenueCents: 2000, costMicros: c(1050) })];
    const losses: LossFact[] = [{ id: "stockCosts/p1/movements/m9", date: "2026-10-05", productId: "p1", productName: "P1", categoryId: "cat_a", reasonCode: "breakage", units: 2, costMicros: c(210), origin: "loss:1" }];
    const purchases: PurchaseFact[] = [{ id: "stockReceipts/r1", date: "2026-10-01", productId: "p1", productName: "P1", categoryId: "cat_a", kind: "purchase", units: 200, costMicros: c(21000) }];
    const ledger: LedgerFact[] = [{ id: "wallets/s1/entries/e1", date: "2026-10-01", type: "topup", amountCents: 5000 }];
    const r = buildSalesReport(input({ sales, losses, purchases, ledger, retained: [{ id: "orders/o9", date: "2026-10-06", shiftId: "turno_m", channel: "advance", amountCents: 700, units: 2 }] }));
    expect(r.realized.totals.revenueCents).toBe(2000); // recarga de R$ 50 e cobrança retida de R$ 7 não viram receita
    expect(r.realized.totals.cogsCents).toBe(1050); // perda (R$ 2,10) e compra (R$ 210) não entram no CMV
    expect(r.losses?.totals.costCents).toBe(210);
    expect(r.purchases?.netCostCents).toBe(21000);
    expect(r.retained).toEqual({ orders: 1, units: 2, amountCents: 700 });
    // resultado = 950 (lucro) − 210 (perdas) − 0 (taxas): a COMPRA de R$ 210,00 não é subtraída de novo
    expect(r.result?.resultCents).toBe(740);
  });

  it("estorno de entrada abate NO período do estorno; a compra do mês anterior não é reescrita", () => {
    const purchase = { id: "stockReceipts/a", date: "2026-09-20", productId: "p1", productName: "P1", categoryId: null, kind: "purchase", units: 10, costMicros: c(1000) };
    const reversal = { id: "stockCosts/p1/movements/m5", date: "2026-10-03", productId: "p1", productName: "P1", categoryId: null, units: 4, costMicros: c(400) };
    // setembro: só a compra (R$ 10,00); outubro: só o estorno (−R$ 4,00). Relatórios de setembro já exportados não mudam.
    const sep = buildSalesReport(input({ from: "2026-09-01", to: "2026-09-30", purchases: [purchase] })).purchases!;
    expect([sep.netCostCents, sep.reversals.facts]).toEqual([1000, 0]);
    const oct = buildSalesReport(input({ purchases: [], purchaseReversals: [reversal] })).purchases!;
    expect([oct.netCostCents, oct.reversals]).toEqual([-400, { facts: 1, units: 4, costMicros: c(400) }]);
    const both = buildSalesReport(input({ purchases: [purchase], purchaseReversals: [reversal] })).purchases!;
    expect(both.netCostCents).toBe(600);
    expect(both.byProduct).toEqual([{ productId: "p1", name: "P1", units: 6, costMicros: c(600) }]);
  });
});

describe("F21 — pedidos pagos a realizar, cancelamentos e carteira", () => {
  const order = (id: string, date: string, lines: PendingOrderFact["lines"]): PendingOrderFact => ({ id: `orders/${id}`, consumptionDate: date, shiftId: "turno_m", channel: "advance", status: "paid", lines });
  const line = (productId: string, units: number, valueCents: number) => ({ productId, name: productId.toUpperCase(), categoryId: "cat_a", units, valueCents });

  it("separa por data de consumo em relação a hoje (limites exatos)", () => {
    expect(pendingBucket("2026-10-08", TODAY, "2026-10-16")).toBe("overdue");
    expect(pendingBucket("2026-10-09", TODAY, "2026-10-16")).toBe("today");
    expect(pendingBucket("2026-10-16", TODAY, "2026-10-16")).toBe("next7");
    expect(pendingBucket("2026-10-17", TODAY, "2026-10-16")).toBe("later");
    const r = buildSalesReport(input({ pending: [order("a", "2026-10-08", [line("p1", 1, 300)]), order("b", "2026-10-09", [line("p1", 2, 500)]), order("c", "2026-10-16", [line("p2", 3, 700)]), order("d", "2026-10-17", [line("p2", 1, 900)])] })).pending!;
    expect(r.buckets.map((b) => [b.bucket, b.units, b.valueCents])).toEqual([["overdue", 1, 300], ["today", 2, 500], ["next7", 3, 700], ["later", 1, 900]]);
    expect(r.totals).toEqual({ orders: 4, units: 7, valueCents: 2400 });
  });

  it("margem ESTIMADA usa o custo médio atual e avisa o que ficou sem custo (não é CMV)", () => {
    const avg = new Map<string, number | null>([["p1", c(250)], ["p2", null]]); // R$ 2,50 por unidade; p2 sem custo médio
    const r = buildSalesReport(input({ avgCost: avg, pending: [order("a", "2026-10-09", [line("p1", 3, 1000)]), order("b", "2026-10-10", [line("p2", 4, 800)])] }));
    // custo estimado só de p1: 3 × 2,50 = 7,50 → 750 centavos; p2 (4 un.) sem custo; valor total 1800
    expect(r.pending!.estimate).toMatchObject({ costCents: 750, missingCostUnits: 4 });
    expect(r.pendencies.map((p) => p.code)).toContain("pending_cost_unknown");
    expect(r.result?.definitive).toBe(true); // a estimativa não bloqueia o resultado realizado
  });

  it("cancelamentos e reembolsos por tipo; conferem com os lançamentos order_refund", () => {
    const cancellations: CancellationFact[] = [
      { id: "orders/o1/cancellations/c1", date: "2026-10-03", orderId: "o1", kind: "family", shiftId: "turno_m", channel: "advance", lines: [{ productId: "p1", name: "P1", categoryId: "cat_a", units: 2, refundCents: 400 }] },
      { id: "orders/o2/cancellations/c2", date: "2026-10-04", orderId: "o2", kind: "operational", shiftId: "turno_m", channel: "advance", lines: [{ productId: "p1", name: "P1", categoryId: "cat_a", units: 1, refundCents: 200 }, { productId: "p2", name: "P2", categoryId: "cat_b", units: 3, refundCents: 600 }] },
    ];
    const ledger: LedgerFact[] = [
      { id: "wallets/s1/entries/c1_refund", date: "2026-10-03", type: "order_refund", amountCents: 400 },
      { id: "wallets/s2/entries/c2_refund", date: "2026-10-04", type: "order_refund", amountCents: 800 },
    ];
    const r = buildSalesReport(input({ cancellations, ledger }));
    expect(r.cancellations!.totals).toEqual({ events: 2, units: 6, refundCents: 1200 });
    expect(r.cancellations!.byKind).toEqual([{ kind: "family", events: 1, units: 2, refundCents: 400 }, { kind: "operational", events: 1, units: 4, refundCents: 800 }]);
    expect(r.checks.find((x) => x.id === "refunds_ledger")).toMatchObject({ expected: 1200, actual: 1200, ok: true });
    const wrong = buildSalesReport(input({ cancellations, ledger: [ledger[0]!] }));
    expect(wrong.checks.find((x) => x.id === "refunds_ledger")?.ok).toBe(false);
  });

  it("transferências entre alunos se anulam e carteira separa crédito, compra e reembolso", () => {
    const ledger: LedgerFact[] = [
      { id: "wallets/a/entries/1", date: "2026-10-01", type: "topup", amountCents: 5000 },
      { id: "wallets/a/entries/2", date: "2026-10-01", type: "transfer_out", amountCents: -1000 },
      { id: "wallets/b/entries/3", date: "2026-10-01", type: "transfer_in", amountCents: 1000 },
      { id: "wallets/b/entries/4", date: "2026-10-02", type: "advance_purchase", amountCents: -800 },
      { id: "wallets/b/entries/5", date: "2026-10-03", type: "order_refund", amountCents: 300 },
    ];
    const r = buildSalesReport(input({ ledger, walletBalanceCents: 4500, walletCount: 2 }));
    expect(r.ledger).toMatchObject({ creditedCents: 6300, spentCents: -1800, netCents: 4500, walletBalanceCents: 4500 });
    expect(r.checks.find((x) => x.id === "transfers_net_zero")?.ok).toBe(true);
  });
});

describe("F21 — achados da revisão: canal em todas as seções que o declaram, livro por lançamento, baixo giro e valor pago", () => {
  const advanceOrder = { id: "orders/a", consumptionDate: "2026-10-10", shiftId: "turno_m", channel: "advance" as const, status: "paid", lines: [{ productId: "p1", name: "P1", categoryId: "cat_a", units: 2, valueCents: 400 }] };
  const retained = { id: "orders/r", date: "2026-10-03", shiftId: "turno_m", channel: "advance" as const, amountCents: 700, units: 2 };
  const cancel = { id: "orders/o/cancellations/c", date: "2026-10-04", orderId: "o", kind: "family", shiftId: "turno_m", channel: "advance" as const, lines: [{ productId: "p1", name: "P1", categoryId: "cat_a", units: 1, refundCents: 150 }] };

  it("filtro de canal vale para a realizar, retido e cancelamentos (pedido antecipado); outro canal zera, sem mostrar o total da escola", () => {
    const base = { pending: [advanceOrder], retained: [retained], cancellations: [cancel] };
    const advance = buildSalesReport(input({ ...base, filters: { channel: "advance" } }));
    expect([advance.pending!.totals.units, advance.retained!.amountCents, advance.cancellations!.totals.refundCents]).toEqual([2, 700, 150]);
    for (const channel of ["counter", "direct"] as const) {
      const other = buildSalesReport(input({ ...base, filters: { channel } }));
      expect([other.pending!.totals.units, other.retained!.amountCents, other.cancellations!.totals.refundCents], channel).toEqual([0, 0, 0]);
    }
  });

  it("créditos e débitos do livro são somados POR LANÇAMENTO (ajuste com sinais opostos não vira só crédito)", () => {
    const ledger: LedgerFact[] = [
      { id: "wallets/a/entries/1", date: "2026-10-01", type: "adjustment", amountCents: 500 },
      { id: "wallets/a/entries/2", date: "2026-10-01", type: "adjustment", amountCents: -200 },
      { id: "wallets/a/entries/3", date: "2026-10-01", type: "order_exchange", amountCents: -100 },
      { id: "wallets/a/entries/4", date: "2026-10-01", type: "order_exchange", amountCents: 40 },
    ];
    expect(buildSalesReport(input({ ledger })).ledger).toMatchObject({ creditedCents: 540, spentCents: -300, netCents: 240 });
  });

  it("baixo giro: produto sem venda só aparece como zero na escola inteira; com filtro de turno/canal ele pode ter vendido em outro recorte", () => {
    const catalog = [{ productId: "p9", name: "Suco", categoryId: null }];
    const sales = [sale({ productId: "p1", productName: "Coxinha", units: 3, revenueCents: 300, costMicros: c(100) })];
    expect(buildSalesReport(input({ catalog, sales })).realized.rankings.lowTurnover.map((x) => x.name)).toEqual(["Suco", "Coxinha"]);
    expect(buildSalesReport(input({ catalog, sales, filters: { shiftId: "turno_m" } })).realized.rankings.lowTurnover.map((x) => x.name)).toEqual(["Coxinha"]);
    expect(buildSalesReport(input({ catalog, sales, filters: { channel: "counter" } })).realized.rankings.lowTurnover.map((x) => x.name)).toEqual(["Coxinha"]);
    expect(buildSalesReport(input({ catalog, sales, filters: { categoryId: "cat_a" } })).realized.rankings.lowTurnover.map((x) => x.name)).toEqual(["Coxinha"]); // catálogo sem categoria cat_a
  });

  it("conferência ENTRE FONTES: as baixas de um pedido nunca passam do valor pago registrado nele", () => {
    const ok = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 2, revenueCents: 400, costMicros: c(100), origin: "order:x" }), sale({ productId: "p2", units: 1, revenueCents: 100, costMicros: c(30), origin: "order:x" })], paidViolations: 0 }));
    expect(ok.checks.find((x) => x.id === "sold_within_paid")).toMatchObject({ kind: "cross", expected: 0, actual: 0, ok: true });
    const bad = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 2, revenueCents: 400, costMicros: c(100), origin: "order:y" })], paidViolations: 1 }));
    expect(bad.checks.find((x) => x.id === "sold_within_paid")).toMatchObject({ expected: 0, actual: 1, ok: false });
    const noOrigin = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 2, revenueCents: 400, costMicros: c(100), originFound: false })] })); // sem a medição, a conferência não acusa nada
    expect(noOrigin.checks.find((x) => x.id === "sold_within_paid")?.ok).toBe(true);
    expect(ok.checks.filter((x) => x.kind === "internal").length).toBeGreaterThan(10);
  });
});

describe("F21 — pedidos em aberto antigos: só contados, visíveis e sem bloquear o resultado realizado", () => {
  it("vira a pendência pending_older (também para a cantina) e não torna o resultado parcial", () => {
    const r = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40) })], pendingOlder: { count: 7, before: "2026-08-25" } }));
    const p = r.pendencies.find((x) => x.code === "pending_older")!;
    expect([p.count, p.blocksResult]).toEqual([7, false]);
    expect(p.detail).toContain("2026-08-25");
    expect(r.result?.definitive).toBe(true);
    expect(toOperational(r).pendencies.map((x) => x.code)).toContain("pending_older");
    expect(buildSalesReport(input({ pendingOlder: { count: 0, before: "2026-08-25" } })).pendencies.map((x) => x.code)).not.toContain("pending_older");
  });
});

describe("F21 — projeção diária na saída e nas tabelas", () => {
  it("estatística de origem dos dias vai na resposta, no resumo exportado e (sem custo) na visão da cantina", () => {
    const projection = { cachedDays: 3, builtDays: 1, liveDays: 1, building: [], staleDays: 0, repairedDays: 0, unstableDays: 0, cacheErrors: 0 };
    const r = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40) })], projection }));
    expect(r.projection).toEqual(projection);
    expect(toOperational(r).projection).toEqual(projection);
    expect(buildSalesReport(input()).projection).toBeNull();
    const row = buildSalesTables(r, [], "full").summary!.rows.find((x) => x[0] === "Projeção diária")!;
    expect(row[2]).toBe("3 / 1 / 1 / 0");
    const withReads = buildSalesReport(input({ projection: { ...projection, reads: { estimatedReads: 77, estimatedWrites: 0, byLabel: {} } } }));
    expect(buildSalesTables(withReads, [], "full").summary!.rows.find((x) => x[1] === "Leituras estimadas da abertura")![2]).toMatchObject({ value: 77 });
    expect(buildSalesTables(withReads, [], "operational").summary!.rows.some((x) => x[1] === "Leituras estimadas da abertura")).toBe(false);
    expect(r.pendencies.map((x) => x.code)).not.toContain("projection_building");
    const waiting = buildSalesReport(input({ projection: { cachedDays: 0, builtDays: 0, liveDays: 0, building: ["2026-10-01", "2026-10-02"], staleDays: 0, repairedDays: 0, unstableDays: 0, cacheErrors: 0 } }));
    expect(waiting.pendencies.find((x) => x.code === "projection_building")).toMatchObject({ count: 2, blocksResult: true });
    expect(waiting.result?.definitive).toBe(false);
    expect(toOperational(waiting).pendencies.map((x) => x.code)).toContain("projection_building");
  });
});

describe("F21 — recebimentos externos e liquidação (F20) como seção própria", () => {
  const receipts = { count: 2, grossCents: 7000, reversedCents: 1000, feeConfirmedCents: 100, feeInformedCents: 50, feeEstimatedCents: 150, feeUnknownCount: 1, feeEffectiveCents: 300, netExpectedCents: 6200, netRealCents: 5000, settledGrossCents: 2000, pendingGrossCents: 5000, overdueGrossCents: 1000 };

  it("entra sem virar receita de venda e some com filtro; a cantina nunca recebe", () => {
    const r = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40) })], receipts }));
    expect(r.receipts).toEqual(receipts);
    expect(r.realized.totals.revenueCents).toBe(100); // R$ 70,00 recebidos não são receita de venda
    expect(buildSalesReport(input({ filters: { channel: "direct" }, receipts })).receipts).toBeNull();
    expect(buildSalesReport(input()).receipts).toBeNull();
    expect(JSON.stringify(toOperational(r))).not.toContain("7000");
    const rows = buildSalesTables(r, [], "full").summary!.rows.map((x) => x.slice(0, 2).join("|"));
    expect(rows).toEqual(expect.arrayContaining(["Recebimentos externos (F20)|Recebido bruto (R$)", "Liquidação|Vencido (R$)"]));
  });
});

describe("F21 — reversões externas (reembolso/chargeback): posição de hoje, sem virar receita nem perda", () => {
  const rev = (id: string, status: string, opened: number, outstanding: number, recovered: number, writtenOff: number) => ({ id, status, openedCents: opened, outstandingCents: outstanding, recoveredCents: recovered, writtenOffCents: writtenOff });

  it("soma pendências abertas, recuperado e absorvido; pendência aberta avisa sem bloquear o resultado", () => {
    const r = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40) })], reversals: [rev("a", "open", 1000, 700, 300, 0), rev("b", "resolved", 500, 0, 0, 500), rev("c", "open", 200, 200, 0, 0)] }));
    expect(r.reversals).toEqual({ pendencies: 3, open: 2, openedCents: 1700, outstandingCents: 900, recoveredCents: 300, writtenOffCents: 500 });
    const p = r.pendencies.find((x) => x.code === "reversal_open")!;
    expect([p.count, p.blocksResult]).toEqual([2, false]);
    expect(r.result?.definitive).toBe(true); // reversão pendente não é perda ainda: o resultado realizado segue definitivo
    expect(r.realized.totals.revenueCents).toBe(100); // nem vira receita
  });

  it("sem pendência nada aparece; com filtro a seção da escola inteira é omitida", () => {
    expect(buildSalesReport(input()).pendencies.map((x) => x.code)).not.toContain("reversal_open");
    expect(buildSalesReport(input({ filters: { productId: "p1" }, reversals: [rev("a", "open", 1, 1, 0, 0)] })).reversals).toBeNull();
    expect(toOperational(buildSalesReport(input({ reversals: [rev("a", "open", 1, 1, 0, 0)] }))).pendencies.map((x) => x.code)).not.toContain("reversal_open");
  });
});

describe("F21 — filtros, bases e seções da escola inteira", () => {
  const sales = () => [
    sale({ productId: "p1", channel: "advance", shiftId: "turno_m", categoryId: "cat_a", units: 2, revenueCents: 400, costMicros: c(100) }),
    sale({ productId: "p2", channel: "counter", shiftId: "turno_t", categoryId: "cat_b", units: 3, revenueCents: 900, costMicros: c(300) }),
    sale({ productId: "p3", channel: "direct", shiftId: "turno_t", categoryId: "cat_b", units: 1, revenueCents: 250, costMicros: c(100) }),
  ];

  it("cada filtro recorta só o que lhe cabe", () => {
    expect(buildSalesReport(input({ sales: sales(), filters: { channel: "counter" } })).realized.totals.units).toBe(3);
    expect(buildSalesReport(input({ sales: sales(), filters: { shiftId: "turno_t" } })).realized.totals.units).toBe(4);
    expect(buildSalesReport(input({ sales: sales(), filters: { categoryId: "cat_b" } })).realized.totals.revenueCents).toBe(1150);
    expect(buildSalesReport(input({ sales: sales(), filters: { productId: "p1" } })).realized.totals.revenueCents).toBe(400);
  });

  it("seção da escola inteira é OMITIDA com motivo quando o filtro não vale para ela", () => {
    expect(skippedReason("realized", { productId: "p1" })).toBeNull();
    expect(skippedReason("result", { productId: "p1" })).toContain("produto");
    const r = buildSalesReport(input({ sales: sales(), filters: { shiftId: "turno_t" } }));
    expect(r.result).toBeNull();
    expect(r.ledger).toBeNull();
    expect(r.fees).toBeNull();
    expect(r.losses).toBeNull();
    expect(Object.keys(r.skipped).sort()).toEqual(["fees", "ledger", "losses", "purchases", "result", "reversals"]);
    const byProduct = buildSalesReport(input({ sales: sales(), filters: { productId: "p1" } }));
    expect(byProduct.losses).not.toBeNull();
    expect(byProduct.result).toBeNull();
  });

  it("agrupamentos conferem entre si (unidades, receita e CMV exato)", () => {
    const r = buildSalesReport(input({ sales: sales() }));
    expect(r.checks.every((x) => x.ok)).toBe(true);
    expect(reconcileSales(r)).toEqual(r.checks);
    expect(r.realized.byDay).toHaveLength(1);
    expect(r.realized.byCategory.map((x) => [x.label, x.units])).toEqual([["Salgados", 2], ["Doces", 4]]);
    expect(r.realized.byShift.map((x) => x.label)).toEqual(["Manhã", "Tarde"]);
  });

  it("reconstruir é determinístico: mesma entrada, qualquer ordem e com repetição = mesmo relatório", () => {
    const a = sales();
    const once = buildSalesReport(input({ sales: a }));
    const shuffled = buildSalesReport(input({ sales: [a[2]!, a[0]!, a[1]!, a[0]!, a[2]!] }));
    expect(shuffled.duplicatesIgnored).toBe(2);
    expect({ ...shuffled, duplicatesIgnored: 0 }).toEqual({ ...once, duplicatesIgnored: 0 });
  });
});

describe("F21 — visão da cantina não tem custo, margem, lucro, taxa nem carteira", () => {
  it("nenhuma CHAVE de custo/lucro/taxa/resultado/compra/carteira na visão operacional", () => {
    const full = buildSalesReport(
      input({
        sales: [sale({ productId: "p1", units: 2, revenueCents: 400, costMicros: c(100) })],
        losses: [{ id: "l1", date: "2026-10-04", productId: "p1", productName: "P1", categoryId: "cat_a", reasonCode: "expiry", units: 1, costMicros: c(50), origin: "x" }],
        purchases: [{ id: "r1", date: "2026-10-01", productId: "p1", productName: "P1", categoryId: null, kind: "purchase", units: 9, costMicros: c(900) }],
        ledger: [{ id: "e1", date: "2026-10-01", type: "topup", amountCents: 1000 }],
        fees: { effectiveCents: 33, unknownCount: 1, unknownGrossCents: 100, fictitiousCount: 1 },
        avgCost: new Map([["p1", c(50)]]),
        pending: [{ id: "orders/a", consumptionDate: TODAY, shiftId: "turno_m", channel: "advance", status: "paid", lines: [{ productId: "p1", name: "P1", categoryId: null, units: 1, valueCents: 200 }] }],
        walletBalanceCents: 777,
      }),
    );
    const op = toOperational(full);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(op);
    expect(keys.filter((k) => /cost|cogs|profit|margin|fee|result|purchase|ledger|wallet|estimate|check/i.test(k))).toEqual([]);
    expect(op.realized.totals).toMatchObject({ units: 2, revenueCents: 400, origins: 1, ticketAverageCents: 400 });
    expect(op.losses).toEqual({ rows: [{ productId: "p1", name: "P1", reasonCode: "expiry", units: 1 }], totalUnits: 1 });
    expect(JSON.stringify(op)).not.toContain("777");
  });
});

describe("F21 — consulta, escopo por papel e exportação", () => {
  it("período: 93 dias passa, 94 e invertido são recusados; chaves desconhecidas e filtros vazios", () => {
    expect(parseSalesQuery({ from: "2026-07-01", to: "2026-10-01", shiftId: "", channel: "" })).toEqual({ from: "2026-07-01", to: "2026-10-01", filters: {} });
    expect(() => parseSalesQuery({ from: "2026-07-01", to: "2026-10-02" })).toThrow(/Período máximo/);
    expect(() => parseSalesQuery({ from: "2026-10-02", to: "2026-10-01" })).toThrow(/invertido/);
    expect(() => parseSalesQuery({ from: "2026-10-01", to: "2026-10-02", extra: "x" })).toThrow();
    expect(() => parseSalesQuery({ from: "2026-02-30", to: "2026-03-02" })).toThrow();
    expect(parseSalesQuery({ from: "2026-10-01", to: "2026-10-02", channel: "direct", productId: "p_1" }).filters).toEqual({ channel: "direct", productId: "p_1" });
    expect(() => parseSalesQuery({ from: "2026-10-01", to: "2026-10-02", channel: "x" })).toThrow();
  });

  it("papel decide o corte: admin completo, cantina operacional, demais negados", () => {
    expect(reportScope({ uid: "a", role: "admin" })).toBe("full");
    expect(reportScope({ uid: "c", role: "cantina" })).toBe("operational");
    for (const role of ["secretaria", "guardian", "student", null] as const) expect(() => reportScope({ uid: "x", role }), String(role)).toThrow();
    expect(() => reportScope({ uid: "s", role: "secretaria", permissions: ["topup.reverse"] })).toThrow();
  });

  const exportReport = () => {
    const sales = [
      sale({ productId: "p1", productName: "=HYPERLINK(\"http://x\")", units: 10, revenueCents: 2000, costMicros: c(1050) }),
      sale({ productId: "p2", productName: "Brownie", units: 2, revenueCents: 1000, costMicros: null }),
    ];
    const report = buildSalesReport(input({ sales }));
    return { report, sales };
  };

  it("CSV neutraliza fórmula em texto, deixa custo desconhecido VAZIO e resumo = detalhe", () => {
    const { report, sales } = exportReport();
    const tables = buildSalesTables(report, sales, "full");
    const products = tableCsv(tables.products!);
    expect(products.startsWith("﻿")).toBe(true);
    expect(products).toContain("'=HYPERLINK("); // texto de usuário neutralizado com apóstrofo
    expect(products).not.toMatch(/(^|;)=HYPERLINK/m);
    const detail = tables.detail!;
    // soma do detalhe = linha TOTAL do resumo por produto (unidades 12, receita 3000,00)
    const col = (name: string) => detail.header.indexOf(name);
    const units = detail.rows.reduce((s, r) => s + (r[col("Unidades")] as { value: number }).value, 0);
    const revenue = detail.rows.reduce((s, r) => s + (r[col("Receita (R$)")] as { value: number }).value, 0);
    expect([units, revenue]).toEqual([12, 30]);
    const total = tables.products!.rows.at(-1)!;
    expect([(total[2] as { value: number }).value, (total[3] as { value: number }).value]).toEqual([12, 30]);
    // custo desconhecido = célula vazia (não "0,00") e situação explícita
    const noCost = detail.rows.find((r) => r[2] === "Brownie")!;
    expect(noCost[col("CMV exato (R$)")]).toBe("");
    expect(noCost[col("Situação")]).toBe("Sem custo registrado");
    // dinheiro em reais exatos: CMV exato da primeira linha = 10,50
    const first = detail.rows.find((r) => String(r[2]).startsWith("="))!;
    expect((first[col("CMV exato (R$)")] as { text: string }).text).toBe("10,50");
  });

  it("exportação da cantina não tem coluna de custo, margem, lucro nem taxa", () => {
    const { report, sales } = exportReport();
    const tables = buildSalesTables(report, sales, "operational");
    for (const table of Object.values(tables)) {
      expect(table!.header.filter((h) => /custo|CMV|lucro|margem|taxa/i.test(h)), table!.name).toEqual([]);
    }
    expect(tables.purchases).toBeUndefined();
    expect(tables.ledger).toBeUndefined();
    const summary = tableCsv(tables.summary!);
    expect(summary).not.toMatch(/CMV|Lucro|Margem|Taxa|Resultado|Carteiras/);
  });

  it("filtro ativo remove a tabela da seção omitida (sem arquivo enganoso)", () => {
    const { sales } = exportReport();
    const filtered = buildSalesReport(input({ sales, filters: { shiftId: "turno_m" } }));
    const tables = buildSalesTables(filtered, sales, "full");
    expect(tables.purchases).toBeUndefined();
    expect(tables.ledger).toBeUndefined();
    expect(tableCsv(tables.summary!)).toContain("Seções omitidas");
  });
});

describe("F21 — XLSX mínimo: texto nunca é fórmula, números são números, ZIP válido", () => {
  const table = { name: "Teste", header: ["Produto", "Valor"], rows: [["=1+1", { kind: "num" as const, text: "12,30", value: 12.3 }], ["@SOMA(A1)", ""], ["a & b <c>", { kind: "num" as const, text: "0,07", value: 0.07 }]] };

  it("planilha sem <f>, textos como inlineStr com apóstrofo de neutralização e XML escapado", () => {
    const xml = sheetXml(table);
    expect(xml).not.toContain("<f>");
    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain("<t xml:space=\"preserve\">'=1+1</t>");
    expect(xml).toContain("'@SOMA(A1)");
    expect(xml).toContain("a &amp; b &lt;c&gt;");
    expect(xml).toContain("<v>12.3</v>");
    expect(xml).toContain("<v>0.07</v>");
    expect(xml).toContain('<c r="B3"/>'); // vazio continua vazio
  });

  it("crc32 conhecido e ZIP legível por um leitor independente (diretório central, CRC e conteúdo)", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926); // vetor de teste padrão do CRC-32
    const zip = tableXlsx(table);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // fim do diretório central
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    const count = view.getUint16(eocd + 10, true);
    expect(count).toBe(6);
    let at = view.getUint32(eocd + 16, true);
    const names: string[] = [];
    for (let i = 0; i < count; i += 1) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const crc = view.getUint32(at + 16, true);
      const size = view.getUint32(at + 24, true);
      const nameLen = view.getUint16(at + 28, true);
      const localAt = view.getUint32(at + 42, true);
      names.push(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen)));
      const dataStart = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
      expect(crc32(zip.subarray(dataStart, dataStart + size))).toBe(crc);
      at += 46 + nameLen;
    }
    expect(names).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
  });

  it("saída determinística (mesma tabela, mesmos bytes)", () => {
    expect(Buffer.from(tableXlsx(table)).equals(Buffer.from(tableXlsx(table)))).toBe(true);
  });
});
