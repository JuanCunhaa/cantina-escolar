// Interface do caixa e do financeiro (F20), por RENDERIZAÇÃO no servidor (react-dom/server): sem navegador, sem rede. Prova o que o
// operador e a administração VEEM em cada estado: dinheiro, Pix e cartão separados; consumo com carteira à parte (não é dinheiro
// recebido); divergência pendente com texto; movimentos posteriores identificados; regra FICTÍCIA identificada; taxa estimada ×
// conferida sem soma; nenhum percentual na tela do operador. O comportamento no navegador está em tests/e2e/finance.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CashAlerts, RecentClosings } from "@/modules/cash/components/cash-desk";
import { CashPointView } from "@/modules/cash/components/cash-point";
import { differenceText, parseCents } from "@/modules/cash/components/cash-text";
import type { LiveSummary, SessionView } from "@/modules/cash/cash-queries";
import { methodTotals, type CashAlert } from "@/modules/cash/cash-model";
import { CashAdminView, SessionDetailView } from "@/modules/fees/components/cash-admin";
import { FeeConfigView, parsePercentBp, percentText } from "@/modules/fees/components/fee-config";
import { ReconcileView } from "@/modules/fees/components/reconcile-list";
import { TerminalField } from "@/modules/fees/components/terminal-field";
import type { FeeConfig, ReceiptAdminView, ReconcileList } from "@/modules/fees/fee-queries";
import { ReportView } from "@/modules/reports/components/finance-report-view";
import { buildReport } from "@/modules/reports/finance-report";
import type { Receipt } from "@/modules/fees/receipts";

const noop = () => undefined;
const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);
const brl = (digits: string) => new RegExp(`R\\$\\s${digits}`);

const live = (over: Partial<LiveSummary> = {}): LiveSummary => {
  const byMethod = methodTotals([
    { ref: "topup:a", kind: "topup", method: "cash", grossCents: 5000, reversedCents: 1000 },
    { ref: "topup:b", kind: "topup", method: "pix", grossCents: 3000, reversedCents: 0 },
    { ref: "topup:c", kind: "topup", method: "card_credit", grossCents: 2000, reversedCents: 0 },
  ]);
  return { receiptCount: 3, byMethod, expectedCashCents: 14_000, walletConsumption: { orderCount: 0, totalCents: 0 }, ...over };
};
const session = (over: Partial<SessionView> = {}): SessionView => ({
  sessionId: "2026-10-09__secretaria__u1",
  date: "2026-10-09",
  point: "secretaria",
  operatorName: "Maria Teste",
  status: "open",
  openingCents: 10_000,
  openedAt: "2026-10-09T11:00:00.000Z",
  closureNo: 0,
  reopenCount: 0,
  closure: null,
  review: null,
  live: live(),
  afterClose: null,
  history: [],
  events: [],
  ...over,
});
const closedClosure = (over: Partial<NonNullable<SessionView["closure"]>> = {}) => ({
  no: 1,
  closedAtIso: "2026-10-09T20:00:00.000Z",
  byMethod: live().byMethod,
  expectedCashCents: 14_000,
  countedCashCents: 13_900,
  cashDifferenceCents: -100,
  declared: {},
  largestDifferenceCents: 100,
  hasDivergence: true,
  receiptCount: 3,
  walletConsumption: { orderCount: 0, totalCents: 0 },
  note: null,
  closedByName: "Maria Teste",
  ...over,
});

describe("auxiliares de valor e diferença", () => {
  it("aceita ZERO (gaveta vazia), vírgula e milhar; recusa lixo e vazio", () => {
    expect(parseCents("0")).toBe(0);
    expect(parseCents("0,00")).toBe(0);
    expect(parseCents("R$ 0")).toBe(0);
    expect(parseCents("120,5")).toBe(12_050);
    expect(parseCents("1.234,56")).toBe(123_456);
    for (const bad of ["", "  ", "abc", "1,234", "-5", "1e3"]) expect(parseCents(bad), bad).toBeNull();
  });
  it("diferença sempre com palavra (falta/sobra), nunca só com cor", () => {
    expect(differenceText(0)).toBe("Sem diferença");
    expect(differenceText(-100)).toMatch(/^Falta R\$\s1,00$/);
    expect(differenceText(250)).toMatch(/^Sobra R\$\s2,50$/);
  });
  it("percentual em pontos-base: duas casas, teto de 30%", () => {
    expect(parsePercentBp("3,00")).toBe(300);
    expect(parsePercentBp("0,99%")).toBe(99);
    expect(parsePercentBp("12")).toBe(1200);
    expect(parsePercentBp("30")).toBe(3000);
    expect(parsePercentBp("31")).toBeNull();
    expect(parsePercentBp("3,999")).toBeNull();
    expect(parsePercentBp("x")).toBeNull();
    expect(percentText(99)).toBe("0,99%");
  });
});

describe("caixa do operador", () => {
  const props = { point: "secretaria" as const, date: "2026-10-09", locked: false, onOpen: noop, onClose: noop };

  it("sem caixa aberto: pede o saldo inicial e a confirmação; o botão só habilita com os dois", () => {
    const out = html(createElement(CashPointView, { ...props, session: null, live: live({ receiptCount: 0, byMethod: methodTotals([]) }) }));
    expect(out).toContain("Sem caixa aberto");
    expect(out).toContain("Saldo inicial em dinheiro");
    expect(out).toContain("confirmo o saldo inicial");
    expect(out).toMatch(/data-testid="cash-open"[^>]*disabled|disabled=""[^>]*data-testid="cash-open"/);
  });

  it("sem caixa mas com recebimentos do dia: avisa que há recebimentos para conferir", () => {
    const out = html(createElement(CashPointView, { ...props, session: null, live: live() }));
    expect(out).toMatch(/Há 3 recebimento\(s\) seu\(s\) nesta data sem caixa aberto/);
  });

  it("aberto: dinheiro, Pix e cartão em linhas separadas; esperado = saldo inicial + dinheiro − estornado", () => {
    const out = html(createElement(CashPointView, { ...props, session: session(), live: live() }));
    expect(out).toContain("Aberto");
    for (const label of ["Dinheiro", "Pix", "Cartão de débito", "Cartão de crédito (1x)"]) expect(out).toContain(label);
    expect(out).toMatch(brl("140,00")); // esperado na gaveta
    expect(out).toMatch(brl("100,00")); // saldo inicial
    expect(out).toContain("Fechar o caixa");
    expect(out).toContain("Dinheiro contado na gaveta");
    expect(out).toContain("Revisar fechamento");
  });

  it("balcão: o consumo com carteira aparece à parte e diz que não é dinheiro recebido; na secretaria não aparece", () => {
    const wallet = live({ walletConsumption: { orderCount: 2, totalCents: 1500 } });
    const counter = html(createElement(CashPointView, { ...props, point: "counter", session: session({ point: "counter", live: wallet }), live: wallet }));
    expect(counter).toMatch(/Consumo com carteira no balcão: 2 compras/);
    expect(counter).toMatch(/não entra como dinheiro recebido/);
    expect(html(createElement(CashPointView, { ...props, session: session(), live: live() }))).not.toContain("Consumo com carteira");
  });

  it("fechado com divergência: mostra falta/sobra, pendência de revisão e movimentos posteriores sem reescrever o fechamento", () => {
    const closed = session({
      status: "closed",
      closureNo: 1,
      closure: closedClosure(),
      review: { status: "pending", closureNo: 1, note: null, byName: null, atIso: null, selfReview: false },
      live: null,
      afterClose: { count: 2, newReceipts: [{ ref: "topup:z", method: "cash", grossCents: 600 }], newReversals: [{ ref: "topup:a", method: "cash", addedCents: 1000 }] },
      history: [{ no: 1, closedAt: "2026-10-09T20:00:00.000Z", expectedCashCents: 14_000, countedCashCents: 13_900, cashDifferenceCents: -100, hasDivergence: true }],
    });
    const out = html(createElement(CashPointView, { ...props, session: closed, live: null }));
    expect(out).toContain("Fechamento 1");
    expect(out).toMatch(/Falta R\$\s1,00/);
    expect(out).toContain("Divergência pendente de revisão da administração");
    expect(out).toMatch(/2 movimento\(s\) lançado\(s\) depois do fechamento \(1 recebimento\(s\), 1 estorno\(s\)\)/);
    expect(out).toContain("Este fechamento não foi alterado");
    expect(out).not.toContain("Fechar o caixa");
  });

  it("reaberto volta a oferecer o fechamento e indica quantas vezes foi reaberto; histórico lista os fechamentos anteriores", () => {
    const reopened = session({
      status: "reopened",
      reopenCount: 1,
      closureNo: 1,
      history: [
        { no: 1, closedAt: "2026-10-09T20:00:00.000Z", expectedCashCents: 14_000, countedCashCents: 14_000, cashDifferenceCents: 0, hasDivergence: false },
        { no: 2, closedAt: "2026-10-09T21:00:00.000Z", expectedCashCents: 14_600, countedCashCents: 14_500, cashDifferenceCents: -100, hasDivergence: true },
      ],
    });
    const out = html(createElement(CashPointView, { ...props, session: reopened, live: live() }));
    expect(out).toContain("Reaberto");
    expect(out).toContain("reaberto 1×");
    expect(out).toContain("Fechar o caixa");
  });

  it("alertas do operador não bloqueiam e levam ao dia pendente; sem alertas nada aparece", () => {
    const alerts: CashAlert[] = [
      { kind: "open_not_closed", date: "2026-10-08", point: "secretaria", operatorUid: "u1", operatorName: "Maria", sessionId: "s1", detail: null },
      { kind: "receipts_without_session", date: "2026-10-07", point: "secretaria", operatorUid: "u1", operatorName: "Maria", sessionId: null, detail: "2" },
      { kind: "divergence_pending", date: "2026-10-06", point: "counter", operatorUid: "u1", operatorName: "Maria", sessionId: "s2", detail: null },
    ];
    const out = html(createElement(CashAlerts, { alerts, onPick: noop }));
    expect(out).toContain("Pendências de caixa (3)");
    expect(out).toContain("não impedem você de trabalhar hoje");
    expect(out.match(/Ir para este dia/g)).toHaveLength(2); // divergência pendente não é "ir para o dia": é da administração
    expect(html(createElement(CashAlerts, { alerts: [], onPick: noop }))).toBe("");
    expect(html(createElement(RecentClosings, { recent: [] }))).toBe("");
    expect(html(createElement(RecentClosings, { recent: [{ sessionId: "s", date: "2026-10-08", point: "counter", status: "closed", cashDifferenceCents: 0, reviewStatus: "not_required" }] }))).toContain("Sem diferença");
  });
});

describe("administração: caixas, detalhe, revisão e reabertura", () => {
  it("lista com alertas, situação e diferença; vazio e período", () => {
    const list = {
      from: "2026-10-03",
      to: "2026-10-09",
      truncated: false,
      alerts: [{ kind: "movements_after_close", date: "2026-10-09", point: "secretaria", operatorUid: "u1", operatorName: "Maria Teste", sessionId: "2026-10-09__secretaria__u1", detail: "2" }] as CashAlert[],
      sessions: [{ sessionId: "2026-10-09__secretaria__u1", date: "2026-10-09", point: "secretaria" as const, operatorName: "Maria Teste", operatorUid: "u1", status: "closed" as const, openingCents: 10_000, expectedCashCents: 14_000, countedCashCents: 13_900, cashDifferenceCents: -100, hasDivergence: true, reviewStatus: "pending", closureNo: 1, reopenCount: 1 }],
    };
    const out = html(createElement(CashAdminView, { list, from: list.from, to: list.to, onRange: noop }));
    expect(out).toContain("Alertas (1)");
    expect(out).toContain("Movimentos depois do fechamento");
    expect(out).toContain("Maria Teste");
    expect(out).toMatch(/Falta R\$\s1,00/);
    expect(out).toContain("reaberto 1×");
    expect(out).toContain("Divergência pendente de revisão");
    const empty = html(createElement(CashAdminView, { list: { ...list, alerts: [], sessions: [] }, from: list.from, to: list.to, onRange: noop }));
    expect(empty).toContain("Nenhuma pendência de caixa");
    expect(empty).toContain("Nenhum caixa no período");
  });

  it("detalhe de caixa fechado com divergência: revisão sem ajuste, reabertura com motivo e posteriores identificados", () => {
    const s = session({ status: "closed", closureNo: 1, closure: closedClosure({ declared: { pix: { declaredCents: 2900, expectedCents: 3000, differenceCents: -100 } } }), review: { status: "pending", closureNo: 1, note: null, byName: null, atIso: null, selfReview: false }, live: null, afterClose: { count: 1, newReceipts: [{ ref: "topup:z", method: "cash", grossCents: 600 }], newReversals: [] }, events: [{ type: "opened", closureNo: null, reason: null, byName: "Maria Teste", at: "2026-10-09T11:00:00.000Z" }, { type: "closed", closureNo: 1, reason: null, byName: "Maria Teste", at: "2026-10-09T20:00:00.000Z" }] });
    const out = html(createElement(SessionDetailView, { session: s, message: null, locked: false, onReview: noop, onReopen: noop }));
    expect(out).toContain("Revisar a divergência");
    expect(out).toContain("Nada é lançado na carteira, nos recebimentos, no estoque nem no livro");
    expect(out).toContain("Reabrir o caixa");
    expect(out).toContain("continua guardado como versão anterior");
    expect(out).toContain("Movimentos depois do fechamento");
    expect(out).toContain("Conferido: Pix");
    expect(out).toContain("Caixa aberto");
    expect(out).toMatch(/data-testid="fin-review"[^>]*disabled|disabled=""[^>]*data-testid="fin-review"/); // sem nota, o botão fica desabilitado
  });

  it("sem divergência não há revisão; aberto não há reabertura; revisão do próprio caixa fica marcada", () => {
    const clean = session({ status: "closed", closureNo: 1, closure: closedClosure({ hasDivergence: false, cashDifferenceCents: 0, countedCashCents: 14_000, largestDifferenceCents: 0 }), review: { status: "not_required", closureNo: 1, note: null, byName: null, atIso: null, selfReview: false }, live: null });
    const out = html(createElement(SessionDetailView, { session: clean, message: null, locked: false, onReview: noop, onReopen: noop }));
    expect(out).not.toContain("Revisar a divergência");
    expect(out).toContain("Reabrir o caixa");
    const open = html(createElement(SessionDetailView, { session: session(), message: null, locked: false, onReview: noop, onReopen: noop }));
    expect(open).not.toContain("Reabrir o caixa");
    expect(open).toContain("Recebido até agora");
    const self = html(createElement(SessionDetailView, { session: session({ status: "closed", closure: closedClosure(), closureNo: 1, live: null, review: { status: "approved", closureNo: 1, note: "Conferido com a operadora", byName: "Admin", atIso: null, selfReview: true } }), message: { kind: "ok", text: "Feito" }, locked: false, onReview: noop, onReopen: noop }));
    expect(self).toContain("revisão do próprio caixa");
    expect(self).toContain("Divergência aprovada pela administração (sem ajuste)");
    expect(self).toContain("Feito");
  });
});

describe("taxas e maquininhas", () => {
  const config = (over: Partial<FeeConfig> = {}): FeeConfig => ({
    today: "2026-10-09",
    production: false,
    sources: [
      { sourceId: "default", kind: "default", name: "Padrão (sem maquininha/provedor informado)", methods: ["pix", "card_debit", "card_credit"], active: true, fictitious: false },
      { sourceId: "term_abc", kind: "terminal", name: "[FICTÍCIA] Maquininha do balcão", methods: ["card_debit", "card_credit"], active: true, fictitious: true },
    ],
    series: [
      {
        seriesId: "term_abc__card_credit",
        sourceId: "term_abc",
        method: "card_credit",
        blockedInProduction: false,
        current: null,
        versions: [
          { n: 1, effectiveFrom: "2026-10-01", enabled: true, percentBp: 300, fixedCents: 0, settlementDays: 30, fictitious: true, reason: "Regra FICTÍCIA de homologação", createdByUid: "a", createdOn: "2026-10-01", createdAtIso: "2026-10-01T00:00:00.000Z", withdrawn: null, state: "in_effect" },
          { n: 2, effectiveFrom: "2026-10-20", enabled: true, percentBp: 500, fixedCents: 39, settlementDays: 2, fictitious: true, reason: "Regra FICTÍCIA futura", createdByUid: "a", createdOn: "2026-10-05", createdAtIso: "2026-10-05T00:00:00.000Z", withdrawn: null, state: "future" },
        ],
      },
    ],
    ...over,
  });
  const base = { message: null, locked: false, onCreateSource: noop, onToggleSource: noop, onPublish: noop, onWithdraw: noop };

  it("mostra cada versão com vigência, situação, percentual, fixa, prazo e a marca FICTÍCIA; só a futura pode ser retirada", () => {
    const out = html(createElement(FeeConfigView, { config: config(), ...base }));
    expect(out).toContain("Ambiente de homologação");
    expect(out).toContain("[FICTÍCIA] Maquininha do balcão");
    expect(out).toContain("v1");
    expect(out).toContain("Em vigor");
    expect(out).toContain("Futura");
    expect(out).toContain("3,00%");
    expect(out).toContain("5,00%");
    expect(out).toMatch(/R\$\s0,39/);
    expect(out).toContain("D+30");
    expect(out).toContain("FICTÍCIA");
    expect(out.match(/>Retirar</g)).toHaveLength(1);
    expect(out).toContain("Publicar nova versão de regra");
    expect(out).toContain("nunca é editada");
    expect(out).toContain("nada aqui é presumido");
  });

  it("sem regras: explica que a taxa fica sem estimativa; em produção não há aviso de homologação e a regra fictícia aparece bloqueada", () => {
    const empty = html(createElement(FeeConfigView, { config: config({ series: [] }), ...base }));
    expect(empty).toContain("Nenhuma regra cadastrada");
    const prod = config({ production: true });
    prod.series[0]!.blockedInProduction = true;
    const out = html(createElement(FeeConfigView, { config: prod, ...base }));
    expect(out).not.toContain("Ambiente de homologação");
    expect(out).toContain("regra fictícia ignorada em produção");
  });

  it("mensagem de resultado e botões travados durante o envio", () => {
    const out = html(createElement(FeeConfigView, { config: config(), ...base, locked: true, message: { kind: "error", text: "Vigência inválida" } }));
    expect(out).toContain('role="alert"');
    expect(out).toContain("Vigência inválida");
  });
});

describe("terminal na tela do operador: só o nome, nunca percentuais", () => {
  const terminals = [{ sourceId: "term_abc", name: "[FICTÍCIA] Maquininha do balcão", methods: ["card_debit" as const, "card_credit" as const] }, { sourceId: "term_pix", name: "Só Pix", methods: ["pix" as const] }];
  it("aparece só para cartão e só com as maquininhas do meio; nada para dinheiro/Pix ou sem maquininhas", () => {
    const out = html(createElement(TerminalField, { id: "t", terminals, method: "card_credit", value: "", disabled: false, onChange: noop }));
    expect(out).toContain("Maquininha usada (opcional)");
    expect(out).toContain("Não informada");
    expect(out).toContain("[FICTÍCIA] Maquininha do balcão");
    expect(out).not.toContain("Só Pix");
    expect(out).not.toMatch(/%|taxa|prazo/i);
    expect(html(createElement(TerminalField, { id: "t", terminals, method: "cash", value: "", disabled: false, onChange: noop }))).toBe("");
    expect(html(createElement(TerminalField, { id: "t", terminals, method: "pix", value: "", disabled: false, onChange: noop }))).toBe("");
    expect(html(createElement(TerminalField, { id: "t", terminals: [], method: "card_debit", value: "", disabled: false, onChange: noop }))).toBe("");
  });
});

describe("conferência e relatório", () => {
  const item = (over: Partial<ReceiptAdminView> = {}): ReceiptAdminView => ({
    ref: "topup:tpm_1",
    kind: "topup",
    point: "secretaria",
    label: "Aluno Teste",
    operatorName: "Maria",
    method: "card_credit",
    sourceId: "term_abc",
    receivedOn: "2026-10-05",
    grossCents: 5000,
    reversedCents: 0,
    fee: { status: "pending", cents: null, source: "operator" },
    estimate: { cents: 150, seriesId: "term_abc__card_credit", ruleVersion: 1, effectiveFrom: "2026-10-01", percentBp: 300, fixedCents: 0, settlementDays: 30, fictitious: true, computedOn: "2026-10-05" },
    effective: { basis: "estimated", cents: 150, estimatedCents: 150, differenceCents: null },
    settlement: { status: "pending", expectedOn: "2026-10-04", settledOn: null, expectedSource: "rule" },
    overdue: true,
    financeVersion: 0,
    reference: null,
    ...over,
  });
  const list = (items: ReceiptAdminView[]): ReconcileList => ({ today: "2026-10-09", items, truncated: false });

  it("mostra estimada × real sem somar, a liquidação vencida e a marca FICTÍCIA", () => {
    const out = html(createElement(ReconcileView, { list: list([item(), item({ ref: "topup:tpm_2", fee: { status: "confirmed", cents: 148, source: "operator" }, effective: { basis: "confirmed", cents: 148, estimatedCents: 150, differenceCents: -2 }, overdue: false, settlement: { status: "settled", expectedOn: null, settledOn: "2026-10-08" } })]), message: null, locked: false, onSave: noop }));
    expect(out).toContain("A conferir (2) · 1 com liquidação vencida");
    expect(out).toContain("Estimada pela regra");
    expect(out).toContain("Conferida");
    expect(out).toContain("estimada");
    expect(out).toContain("vencida");
    expect(out).toContain("regra FICTÍCIA");
    expect(out).toContain("Liquidada em 08/10/2026");
    expect(out).toContain("O crédito do aluno não muda");
    expect(html(createElement(ReconcileView, { list: list([]), message: null, locked: false, onSave: noop }))).toContain("Nada pendente de conferência");
  });

  const rcpt = (id: string, over: Partial<Receipt> = {}): Receipt => ({ kind: "topup", id, ref: `topup:${id}`, point: "secretaria", operatorUid: "u", operatorName: "M", method: "card_credit", sourceId: "term_abc", receivedOn: "2026-10-05", receivedAtIso: null, grossCents: 5000, reversedCents: 0, fee: { status: "pending", cents: null, source: "operator" }, feeEstimate: { cents: 150, seriesId: "s", ruleVersion: 1, effectiveFrom: "2026-10-01", percentBp: 300, fixedCents: 0, settlementDays: 30, fictitious: true, computedOn: "2026-10-05" }, settlement: { status: "pending", expectedOn: "2026-10-01", settledOn: null }, financeVersion: 0, label: "A", reference: null, status: "confirmed", ...over });

  it("relatório: base de data explícita, totais, aviso de regra fictícia, exportação e o que NÃO entra", () => {
    const report = buildReport([rcpt("a"), rcpt("b", { method: "pix", fee: { status: "informed", cents: 20, source: "operator" }, feeEstimate: null, settlement: { status: "settled", expectedOn: null, settledOn: "2026-10-05" } })], { from: "2026-10-01", to: "2026-10-31" }, "2026-10-09", { truncated: false, production: false });
    const out = html(createElement(ReportView, { report, from: "2026-10-01", to: "2026-10-31", onRange: noop, onExport: noop, exporting: false, message: null }));
    expect(out).toContain("data do recebimento");
    expect(out).toContain("compra com saldo da carteira, transferência e reserva não aparecem aqui");
    expect(out).toContain("1 recebimento(s) com estimativa de regra FICTÍCIA");
    expect(out).toMatch(/Valor bruto recebido<\/dt><dd>R\$\s100,00/);
    expect(out).toMatch(/Taxa efetiva \(soma, sem repetir\)<\/dt><dd>R\$\s1,70/);
    expect(out).toContain("Exportar detalhe (CSV)");
    expect(out).toContain("1 vencida(s)");
    const prod = html(createElement(ReportView, { report: { ...report, production: true }, from: "2026-10-01", to: "2026-10-31", onRange: noop, onExport: noop, exporting: true, message: "Falhou" }));
    expect(prod).not.toContain("estimativa de regra FICTÍCIA");
    expect(prod).toContain("Falhou");
    const truncated = html(createElement(ReportView, { report: { ...report, truncated: true, rows: [] }, from: "2026-10-01", to: "2026-10-31", onRange: noop, onExport: noop, exporting: false, message: null }));
    expect(truncated).toContain("Relatório parcial");
    expect(truncated).toContain("Nenhum recebimento no período");
  });
});
