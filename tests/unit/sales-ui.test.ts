// Interface dos relatórios de vendas (F21) SEM navegador: renderização no servidor (o que a pessoa VÊ em cada estado) e o mini-renderizador
// (tests/helpers/mini-react.ts) para disparar filtros, ranking e exportação. Prova: lucro parcial/pendente nunca aparece como valor
// definitivo, a cantina não vê custo nem lucro, filtros e períodos prontos produzem a consulta certa, a exportação só é salva sem erro.
// Fluxo real no navegador: tests/e2e/sales-report.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type Harness } from "../helpers/mini-react";

const state = vi.hoisted(() => ({ session: { status: "loading" } as Record<string, unknown>, data: null as unknown, status: "ready" as string, exported: [] as unknown[], exportResult: null as string | null }));
vi.mock("@/modules/orders/use-operations", () => ({
  useServerQuery: () => ({ status: state.status, data: state.data, errorCode: state.status === "error" ? "internal" : null, refreshing: false, reload: () => undefined }),
}));
vi.mock("@/modules/access/use-session", () => ({ useSession: () => state.session }));
vi.mock("next/link", () => ({ default: (props: { href: string; children: unknown }) => createElement("a", { href: props.href }, props.children as string) }));
vi.mock("@/modules/reports/sales-actions", async (importActual) => {
  const actual = await importActual<typeof import("@/modules/reports/sales-actions")>();
  return { ...actual, exportSalesAction: async (...args: unknown[]) => (state.exported.push(args), state.exportResult) };
});

import { buildSalesReport, toOperational, type SaleFact, type SalesInput } from "@/modules/reports/sales-model";
import OperacaoRelatoriosPage from "@/app/operacao/relatorios/page";
import { EXPORT_ERRORS, exportSalesAction, presetRange, salesQuery } from "@/modules/reports/sales-actions";
import {
  ExportPanel,
  FilterBar,
  RankingSection,
  ReportNotices,
  SalesReportPage,
  SalesReportView,
  bpText,
  browserExport,
} from "@/modules/reports/components/sales-report-view";

const actualActions = await vi.importActual<typeof import("@/modules/reports/sales-actions")>("@/modules/reports/sales-actions");

const c = (cents: number) => cents * 1_000_000;
const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);
const brl = (digits: string) => new RegExp(`R\\$\\s${digits}`);
const noop = () => undefined;
let n = 0;
const sale = (over: Partial<SaleFact> & { productId: string }): SaleFact => ({
  id: `m${++n}`,
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
});
const input = (over: Partial<SalesInput> = {}): SalesInput => ({
  from: "2026-10-01",
  to: "2026-10-09",
  today: "2026-10-09",
  filters: {},
  production: false,
  labels: { categories: { cat_a: "Salgados" }, shifts: { turno_m: "Manhã" } },
  catalog: [{ productId: "p9", name: "Suco sem venda", categoryId: null }],
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
});

const a20 = () => buildSalesReport(input({ sales: [sale({ productId: "p1", productName: "Coxinha", units: 10, revenueCents: 2000, costMicros: c(1050) })] }));
const partial = () =>
  buildSalesReport(
    input({
      sales: [sale({ productId: "p1", productName: "Coxinha", units: 4, revenueCents: 1000, costMicros: c(400) }), sale({ productId: "p2", productName: "Brownie", units: 5, revenueCents: 500, costMicros: null })],
      fees: { effectiveCents: 150, unknownCount: 2, unknownGrossCents: 10_000, fictitiousCount: 1 },
      truncated: ["recebimentos"],
    }),
  );

const base = { params: { from: "2026-10-01", to: "2026-10-09", filters: {} }, onParams: noop, today: "2026-10-09", onExport: noop, exporting: false, message: null };
const view = (report: unknown, over: Record<string, unknown> = {}) => html(createElement(SalesReportView as never, { ...base, report, ...over }));

beforeEach(() => {
  state.session = { status: "loading" };
  state.data = null;
  state.status = "ready";
  state.exported = [];
  state.exportResult = null;
});

describe("F21 — textos e consultas puras", () => {
  it("margem em pontos-base sem ponto flutuante", () => {
    expect(bpText(4750)).toBe("47,50 %");
    expect(bpText(-125)).toBe("-1,25 %");
    expect(bpText(5)).toBe("0,05 %");
    expect(bpText(null)).toBe("—");
  });

  it("períodos prontos usam a data local e viram o ano em janeiro", () => {
    expect(presetRange("month", "2026-10-09")).toEqual({ from: "2026-10-01", to: "2026-10-09" });
    expect(presetRange("last7", "2026-10-09")).toEqual({ from: "2026-10-03", to: "2026-10-09" });
    expect(presetRange("lastMonth", "2026-10-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("lastMonth", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("last7", "2026-03-03")).toEqual({ from: "2026-02-25", to: "2026-03-03" });
  });

  it("consulta leva só os filtros ativos, codificados", () => {
    expect(salesQuery({ from: "2026-10-01", to: "2026-10-09", filters: {} })).toBe("from=2026-10-01&to=2026-10-09");
    expect(salesQuery({ from: "2026-10-01", to: "2026-10-09", filters: { shiftId: "t 1", channel: "direct" } })).toBe("from=2026-10-01&to=2026-10-09&shiftId=t%201&channel=direct");
  });
});

describe("F21 — exportação pelo navegador: só salva arquivo completo", () => {
  const deps = (response: { ok: boolean; body?: unknown }) => {
    const saved: { name: string }[] = [];
    const urls: string[] = [];
    return {
      saved,
      urls,
      deps: {
        token: async () => "tok",
        fetchFn: async (url: string) => {
          urls.push(url);
          return { ok: response.ok, json: async () => response.body, blob: async () => new Blob(["x"]) };
        },
        save: (_blob: Blob, name: string) => void saved.push({ name }),
      },
    };
  };
  const params = { from: "2026-10-01", to: "2026-10-09", filters: { productId: "p1" } };

  it("sucesso salva com o nome do período e pede o formato certo", async () => {
    const t = deps({ ok: true });
    expect(await actualActions.exportSalesAction(t.deps, params, "products", "xlsx")).toBeNull();
    expect(t.urls).toEqual(["/api/reports/sales/export?from=2026-10-01&to=2026-10-09&productId=p1&view=products&format=xlsx"]);
    expect(t.saved).toEqual([{ name: "relatorio-products-2026-10-01_2026-10-09.xlsx" }]);
  });

  it("exportação truncada ou indisponível vira mensagem e NADA é salvo", async () => {
    const trunc = deps({ ok: false, body: { error: "export_truncated" } });
    expect(await actualActions.exportSalesAction(trunc.deps, params, "detail", "csv")).toBe(EXPORT_ERRORS.export_truncated);
    expect(trunc.saved).toEqual([]);
    const gone = deps({ ok: false, body: { error: "view_unavailable" } });
    expect(await actualActions.exportSalesAction(gone.deps, params, "ledger", "csv")).toBe(EXPORT_ERRORS.view_unavailable);
    const other = deps({ ok: false, body: { error: "forbidden" } });
    expect(typeof (await actualActions.exportSalesAction(other.deps, params, "detail", "csv"))).toBe("string");
    const broken = deps({ ok: false, body: undefined });
    expect(typeof (await actualActions.exportSalesAction(broken.deps, params, "detail", "csv"))).toBe("string");
  });

  it("falha de rede devolve mensagem, sem salvar", async () => {
    const saved: unknown[] = [];
    const message = await actualActions.exportSalesAction({ token: async () => "t", fetchFn: async () => Promise.reject(new Error("rede")), save: () => void saved.push(1) }, params, "summary", "csv");
    expect(typeof message).toBe("string");
    expect(saved).toEqual([]);
  });

  it("o salvamento do navegador cria o link temporário e libera a URL depois", () => {
    const link = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link });
    const create = vi.fn(() => "blob:fake");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    vi.useFakeTimers();
    try {
      browserExport({ getIdToken: async () => "t" } as never).save(new Blob(["x"]), "arquivo.csv");
      expect(link).toMatchObject({ href: "blob:fake", download: "arquivo.csv" });
      expect(link.click).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10_000);
      expect(revoke).toHaveBeenCalledWith("blob:fake");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("F21 — administração vê custo, lucro e margem; parcial nunca vira definitivo", () => {
  it("A20 na tela: receita R$ 20,00, CMV R$ 10,50, lucro bruto R$ 9,50, margem 47,50 %", () => {
    const out = view(a20());
    expect(out).toMatch(brl("20,00"));
    expect(out).toMatch(brl("10,50"));
    expect(out).toMatch(brl("9,50"));
    expect(out).toContain("47,50 %");
    expect(out).toContain("CMV (custo histórico das unidades vendidas)");
    expect(out).not.toContain("incompleto");
    expect(out).toContain("definitivo");
  });

  it("custo ausente: lucro 'incompleto', pendência listada, taxa desconhecida avisada e resultado PARCIAL", () => {
    const out = view(partial());
    expect(out).toContain("incompleto");
    expect(out).toContain("(parcial)");
    expect(out).toContain("Pendências (não tratadas como zero)");
    expect(out).toContain("Vendas sem custo");
    expect(out).toContain("PARCIAL — veja as pendências");
    expect(out).toContain("NÃO foi tratada como zero");
    expect(out).toContain("Relatório PARCIAL");
    expect(out).toContain("FICTÍCIOS");
    expect(out).toContain("1 recebimento(s) usam regra de taxa FICTÍCIA");
  });

  it("sem nenhuma baixa completa o lucro mostra 'pendente', não R$ 0,00", () => {
    const only = buildSalesReport(input({ sales: [sale({ productId: "p2", productName: "Brownie", units: 5, revenueCents: 500, costMicros: null })] }));
    const out = view(only);
    expect(out).toContain("pendente");
    expect(out).toContain("incompleto");
  });

  it("em produção não há aviso de ambiente fictício", () => {
    expect(view(buildSalesReport(input({ production: true, sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40) })] })))).not.toContain("FICTÍCIOS");
  });

  it("seções da escola inteira omitidas por filtro são explicadas; carteira, compras e conferências aparecem sem filtro", () => {
    const filtered = view(buildSalesReport(input({ filters: { shiftId: "turno_m" }, sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40) })] })));
    expect(filtered).toContain("foram omitidas");
    expect(filtered).not.toContain("Carteiras (livro de movimentos)");
    const full = view(
      buildSalesReport(
        input({
          sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40) })],
          purchases: [{ id: "r1", date: "2026-10-01", productId: "p1", productName: "P1", categoryId: null, kind: "purchase", units: 5, costMicros: c(500) }],
          ledger: [{ id: "e1", date: "2026-10-01", type: "topup", amountCents: 5000 }, { id: "e2", date: "2026-10-04", type: "order_refund", amountCents: 150 }],
          walletBalanceCents: 5000,
          walletCount: 3,
          losses: [{ id: "l1", date: "2026-10-02", productId: "p1", productName: "P1", categoryId: null, reasonCode: "breakage", units: 2, costMicros: c(80), origin: "x" }],
          pending: [{ id: "orders/a", consumptionDate: "2026-10-09", shiftId: "turno_m", channel: "advance", status: "paid", lines: [{ productId: "p1", name: "P1", categoryId: null, units: 1, valueCents: 200 }] }],
          avgCost: new Map([["p1", c(40)]]),
          retained: [{ id: "orders/r", date: "2026-10-03", shiftId: "turno_m", channel: "advance", amountCents: 700, units: 2 }],
          cancellations: [{ id: "orders/o/cancellations/c", date: "2026-10-04", orderId: "o", kind: "family", shiftId: "turno_m", channel: "advance", lines: [{ productId: "p1", name: "P1", categoryId: null, units: 1, refundCents: 150 }] }],
        }),
      ),
    );
    expect(full).toContain("Compras de estoque");
    expect(full).toContain("Aplicação de caixa em mercadoria, SEPARADA do CMV");
    expect(full).toContain("Carteiras (livro de movimentos)");
    expect(full).toContain("Crédito por recarga");
    expect(full).toMatch(brl("50,00"));
    expect(full).toContain("Quebra");
    expect(full).toContain("Margem estimada (não é resultado)");
    expect(full).toContain("Cobrança retida");
    expect(full).toContain("Pela família");
    expect(full).toContain("de consistência interna");
    expect(full).toContain("entre fontes independentes");
    expect(full).toContain("Baixo giro");
  });

  it("recebimentos externos e liquidação aparecem separados da venda", () => {
    const r = buildSalesReport(input({ sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: c(40) })], receipts: { count: 2, grossCents: 7000, reversedCents: 1000, feeConfirmedCents: 100, feeInformedCents: 50, feeEstimatedCents: 150, feeUnknownCount: 1, feeEffectiveCents: 300, netExpectedCents: 6200, netRealCents: 5000, settledGrossCents: 2000, pendingGrossCents: 5000, overdueGrossCents: 1000 } }));
    const out = view(r);
    expect(out).toContain("Recebimentos externos, taxas e liquidação");
    expect(out).toMatch(brl("70,00"));
    expect(out).toContain("Sem taxa conhecida");
    expect(out).toContain("não é receita de lanche");
    expect(view(toOperational(r))).not.toContain("Recebimentos externos");
  });

  it("conferência que diverge aparece como alerta com os números", () => {
    const r = a20();
    r.checks = [{ id: "units_produto", label: "Unidades por produto = total", kind: "internal", expected: 10, actual: 9, ok: false }];
    const out = view(r);
    expect(out).toContain("esperado 10, obtido 9");
    expect(out).toContain('role="alert"');
  });
});

describe("F21 — a cantina não vê custo, margem, lucro, taxa, compras nem carteira", () => {
  it("tela operacional mostra quantidades e valores vendidos e o ticket médio", () => {
    const out = view(toOperational(a20()));
    expect(out).toMatch(brl("20,00"));
    expect(out).toContain("Ticket médio");
    expect(out).toContain("Pedidos/vendas distintos");
    for (const word of ["CMV", "Lucro", "Margem", "Resultado após", "Compras de estoque", "Carteiras", "Taxas", "custo"]) expect(out, word).not.toContain(word);
  });

  it("estado de erro e de carregamento", () => {
    expect(view(null)).toContain("Carregando…");
    expect(view(null, { error: "Sem conexão" })).toContain("Sem conexão");
  });

  it("abas do Financeiro só quando solicitadas (administração)", () => {
    expect(view(a20(), { tabs: true })).toContain("Vendas e margens");
    expect(view(a20(), { tabs: false })).not.toContain("Vendas e margens");
  });
});

describe("F21 — filtros, ranking e exportação por interação", () => {
  const full = a20();

  it("filtros mudam a consulta; 'Todos' remove o filtro; datas se ajustam entre si", async () => {
    const calls: unknown[] = [];
    const h = mount(FilterBar as never, { report: full, params: { from: "2026-10-01", to: "2026-10-09", filters: { shiftId: "turno_m" } }, onParams: (p: unknown) => calls.push(p), today: "2026-10-09" });
    await h.change(h.byId("rs-shift"), "");
    await h.change(h.byId("rs-channel"), "direct");
    await h.change(h.byId("rs-product"), "p1");
    await h.change(h.byId("rs-category"), "cat_a");
    await h.change(h.byId("rs-preset"), "lastMonth");
    await h.change(h.byId("rs-preset"), ""); // sem escolha: nada
    await h.change(h.byId("rs-from"), "2026-10-20"); // início depois do fim: o fim acompanha
    await h.change(h.byId("rs-to"), "2026-09-01"); // fim antes do início: o início acompanha
    await h.change(h.byId("rs-from"), ""); // vazio: ignorado
    expect(calls).toEqual([
      { from: "2026-10-01", to: "2026-10-09", filters: {} },
      { from: "2026-10-01", to: "2026-10-09", filters: { shiftId: "turno_m", channel: "direct" } },
      { from: "2026-10-01", to: "2026-10-09", filters: { shiftId: "turno_m", productId: "p1" } },
      { from: "2026-10-01", to: "2026-10-09", filters: { shiftId: "turno_m", categoryId: "cat_a" } },
      { from: "2026-09-01", to: "2026-09-30", filters: { shiftId: "turno_m" } },
      { from: "2026-10-20", to: "2026-10-20", filters: { shiftId: "turno_m" } },
      { from: "2026-09-01", to: "2026-09-01", filters: { shiftId: "turno_m" } },
    ]);
  });

  it("sem relatório carregado as listas de opções ficam vazias (só 'Todos')", () => {
    const out = html(createElement(FilterBar as never, { report: null, params: base.params, onParams: noop, today: "2026-10-09" }));
    expect(out).toContain("Todos");
    expect(out).not.toContain("Manhã");
  });

  it("ranking: cada medida é uma lista própria; a cantina só tem unidades, valor e baixo giro", async () => {
    const multi = buildSalesReport(
      input({
        sales: [
          sale({ productId: "p1", productName: "Coxinha", units: 10, revenueCents: 2000, costMicros: c(1050) }),
          sale({ productId: "p2", productName: "Brownie", units: 2, revenueCents: 1000, costMicros: c(200) }),
        ],
      }),
    );
    const h = mount(RankingSection as never, { report: multi });
    const first = () => h.findAll((nd) => nd.type === "th" && nd.props.scope === "row").map((nd) => nd.children.map((x) => x.text).join(""));
    expect(first()).toEqual(["Coxinha", "Brownie"]); // unidades 10, 2
    await h.change(h.byId("rs-rank-by"), "profitPerUnit");
    expect(first()).toEqual(["Brownie", "Coxinha"]); // 400 > 95 por unidade
    expect(h.text()).toContain("Maior lucro por unidade");
    await h.change(h.byId("rs-rank-by"), "profit");
    expect(first()).toEqual(["Coxinha", "Brownie"]); // 950 > 800 em valor absoluto
    await h.change(h.byId("rs-rank-by"), "lowTurnover");
    expect(first()).toEqual(["Suco sem venda", "Brownie", "Coxinha"]); // produto sem venda aparece com 0
    const op = mount(RankingSection as never, { report: toOperational(multi) });
    const options = op.findAll((nd) => nd.type === "option").map((nd) => nd.children.map((x) => x.text).join(""));
    expect(options).toEqual(["Mais vendidos (unidades)", "Mais vendidos (valor)", "Baixo giro (menos vendidos, inclusive sem venda)"]);
    const empty = mount(RankingSection as never, { report: buildSalesReport(input()) });
    expect(empty.text()).toContain("Nenhum produto com esta medida");
  });

  it("exportação: escolhe a visão e o formato; cantina não tem compras nem carteira", async () => {
    const calls: unknown[][] = [];
    const h = mount(ExportPanel as never, { scope: "full", exporting: false, message: null, onExport: (...a: unknown[]) => calls.push(a) });
    await h.click(h.byTestId("sales-export"));
    await h.change(h.byId("rs-export-view"), "purchases");
    await h.change(h.byId("rs-export-format"), "xlsx");
    await h.click(h.byTestId("sales-export"));
    await h.change(h.byId("rs-export-format"), "csv");
    await h.click(h.byTestId("sales-export"));
    expect(calls).toEqual([["summary", "csv"], ["purchases", "xlsx"], ["purchases", "csv"]]);
    const op = mount(ExportPanel as never, { scope: "operational", exporting: false, message: "Falhou", onExport: noop });
    const opts = op.findAll((nd) => nd.type === "option").map((nd) => nd.props.value);
    expect(opts).not.toContain("purchases");
    expect(opts).not.toContain("ledger");
    expect(op.text()).toContain("Falhou");
    expect(html(createElement(ExportPanel as never, { scope: "full", exporting: true, message: null, onExport: noop }))).toContain("disabled");
  });

  it("avisos: truncado, pendência e seções omitidas aparecem na visão operacional sem custo", () => {
    const op = toOperational(buildSalesReport(input({ filters: { productId: "p1" }, truncated: ["movimentos de estoque"], sales: [sale({ productId: "p1", units: 1, revenueCents: 100, costMicros: null, channel: "unknown", originFound: false })] })));
    const out = html(createElement(ReportNotices as never, { report: op }));
    expect(out).toContain("Relatório PARCIAL");
    expect(out).toContain("Baixas sem origem");
    expect(out).not.toMatch(/custo/i);
  });
});

describe("F21 — página: consulta pelo servidor e exportação com mensagem", () => {
  const user = { uid: "u1", getIdToken: async () => "tok" } as never;

  it("mostra o relatório recebido e baixa o arquivo escolhido com o período atual", async () => {
    state.data = a20();
    const h = mount(SalesReportPage as never, { user, tabs: true });
    expect(h.text()).toContain("Relatórios de vendas");
    expect(h.text()).toContain("Coxinha");
    await h.change(h.byId("rs-export-view"), "products");
    await h.change(h.byId("rs-export-format"), "xlsx");
    await h.click(h.byTestId("sales-export"));
    expect(state.exported).toHaveLength(1);
    const args = state.exported[0] as [unknown, { filters: unknown }, string, string];
    expect(args[1].filters).toEqual({});
    expect(args.slice(2)).toEqual(["products", "xlsx"]);
    expect(h.text()).not.toContain("Há registros demais");
  });

  it("erro da exportação aparece na tela; erro de leitura aparece sem relatório", async () => {
    state.data = a20();
    state.exportResult = EXPORT_ERRORS.export_truncated!;
    const h = mount(SalesReportPage as never, { user, tabs: false });
    await h.click(h.byTestId("sales-export"));
    expect(h.text()).toContain("Há registros demais");
    state.data = null;
    state.status = "error";
    const failed = mount(SalesReportPage as never, { user, tabs: false });
    expect(failed.findAll((nd) => nd.props.role === "alert").length).toBeGreaterThan(0);
  });

  it("a ação real nunca é chamada pela página de teste (vale o mock)", () => {
    expect(exportSalesAction).not.toBe(actualActions.exportSalesAction);
  });
});

describe("F21 — página /operacao/relatorios: quem entra", () => {
  const user = { uid: "u1", getIdToken: async () => "tok" };
  it("sem sessão pronta não mostra nada; secretaria, responsável e aluno veem a recusa", () => {
    expect(mount(OperacaoRelatoriosPage as never).text()).toBe("");
    state.session = { status: "signedIn", user, role: "secretaria", permissions: [] };
    expect(mount(OperacaoRelatoriosPage as never).text()).toContain("Seu perfil não acessa os relatórios de vendas.");
    state.session = { status: "signedIn", user, role: "guardian", permissions: [] };
    expect(mount(OperacaoRelatoriosPage as never).text()).toContain("Seu perfil não acessa os relatórios de vendas.");
  });

  it("cantina entra sem as abas do Financeiro; administração entra com elas", () => {
    state.data = a20();
    state.session = { status: "signedIn", user, role: "cantina", permissions: [] };
    expect(mount(OperacaoRelatoriosPage as never).text()).not.toContain("Vendas e margens");
    state.session = { status: "signedIn", user, role: "admin", permissions: [] };
    const h = mount(OperacaoRelatoriosPage as never);
    expect(h.text()).toContain("Relatórios de vendas");
    expect(h.text()).toContain("Vendas e margens");
  });
});

export type { Harness };
