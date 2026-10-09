// Contêineres das telas do caixa e do financeiro (F20) e as AÇÕES que eles disparam. Os contêineres renderizam no servidor com os
// hooks de leitura/envio SIMULADOS (sem rede, sem navegador): provam loading, erro e dados; as ações (abrir/fechar caixa, revisar,
// reabrir, taxas, conferência, exportação) são funções puras testadas com um `submit` simulado — o resultado só vem da RESPOSTA do
// servidor, resposta perdida/clique duplo não mostram sucesso, e o 4xx vira texto claro. O fluxo no navegador está em e2e/finance.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Loaded = { status: "loading" | "ready" | "error"; data: unknown; errorCode: string | null; refreshing: boolean; reload: () => void };
const state = vi.hoisted(() => ({ byPath: {} as Record<string, unknown>, session: { status: "signedOut" } as Record<string, unknown>, params: { id: "2026-10-09__secretaria__u1" } }));
vi.mock("@/modules/orders/use-operations", () => ({
  useServerQuery: (_user: unknown, path: string): Loaded => (state.byPath[path] as Loaded) ?? { status: "loading", data: null, errorCode: null, refreshing: false, reload: () => undefined },
}));
vi.mock("@/modules/pos/use-pos", () => ({ usePosSubmit: () => ({ busy: false, uncertain: false, submit: async () => null }) }));
vi.mock("@/modules/access/use-session", () => ({ useSession: () => state.session }));
vi.mock("next/navigation", () => ({ useParams: () => state.params }));
vi.mock("next/link", () => ({ default: (props: { href: string; children: unknown }) => createElement("a", { href: props.href }, props.children as string) }));

import { CashDesk } from "@/modules/cash/components/cash-desk";
import { CashAdmin, CashSessionDetail } from "@/modules/fees/components/cash-admin";
import { FeeConfigPage, parsePercentBp } from "@/modules/fees/components/fee-config";
import { ReconcilePage } from "@/modules/fees/components/reconcile-list";
import { FinanceReportPage } from "@/modules/reports/components/finance-report-view";
import { closeCashAction, openCashAction, exportAction, adminAction, FEE_ERRORS, RECONCILE_ERRORS, SESSION_ERRORS, type CloseDraft, type ExportDeps, type Submit } from "@/modules/fees/finance-actions";
import { closeDraftOf, openingOf } from "@/modules/cash/components/cash-point";
import { buildReport } from "@/modules/reports/finance-report";
import { methodTotals } from "@/modules/cash/cash-model";
import OperacaoCaixaPage from "@/app/operacao/caixa/page";
import OperacaoFinanceiroPage from "@/app/operacao/financeiro/page";
import OperacaoConferenciaPage from "@/app/operacao/financeiro/conferencia/page";
import OperacaoTaxasPage from "@/app/operacao/financeiro/taxas/page";
import OperacaoRelatorioPage from "@/app/operacao/financeiro/relatorio/page";
import OperacaoCaixaDetalhePage from "@/app/operacao/financeiro/caixas/[id]/page";

const user = { uid: "u1", getIdToken: async () => "token" } as never;
const ready = (data: unknown): Loaded => ({ status: "ready", data, errorCode: null, refreshing: false, reload: () => undefined });
const failed = (errorCode: string): Loaded => ({ status: "error", data: null, errorCode, refreshing: false, reload: () => undefined });
const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);

beforeEach(() => {
  state.byPath = {};
  state.session = { status: "signedOut" };
});

const live = { receiptCount: 1, byMethod: methodTotals([{ ref: "topup:a", kind: "topup", method: "cash", grossCents: 5000, reversedCents: 0 }]), expectedCashCents: 15_000, walletConsumption: { orderCount: 0, totalCents: 0 } };
const openSession = { sessionId: "2026-10-09__secretaria__u1", date: "2026-10-09", point: "secretaria", operatorName: "Maria", status: "open", openingCents: 10_000, openedAt: null, closureNo: 0, reopenCount: 0, closure: null, review: null, live, afterClose: null, history: [], events: [] };

describe("CashDesk (contêiner)", () => {
  it("carregando, erro e dados: alertas, pontos do dia e últimos caixas", () => {
    expect(html(createElement(CashDesk, { user }))).toContain("Carregando…");
    state.byPath["/api/cash"] = failed("forbidden");
    expect(html(createElement(CashDesk, { user }))).toContain("não tem permissão");
    state.byPath["/api/cash"] = ready({
      date: "2026-10-09",
      points: [{ point: "secretaria", sessionId: openSession.sessionId, session: openSession, live }],
      alerts: [{ kind: "open_not_closed", date: "2026-10-08", point: "secretaria", operatorUid: "u1", operatorName: "Maria", sessionId: "s", detail: null }],
      recent: [{ sessionId: "s", date: "2026-10-08", point: "secretaria", status: "open", cashDifferenceCents: null, reviewStatus: null }],
    });
    const out = html(createElement(CashDesk, { user }));
    expect(out).toContain("Caixa");
    expect(out).toContain("Pendências de caixa (1)");
    expect(out).toContain("Fechar o caixa");
    expect(out).toContain("Seus últimos caixas");
    expect(out).toContain('max="');
  });
});

describe("Caixas da administração (contêineres)", () => {
  it("lista: carregando, erro e dados", () => {
    expect(html(createElement(CashAdmin, { user }))).toContain("Carregando…");
    state.byPath["/api/admin/finance/cash"] = ready({ from: "2026-10-03", to: "2026-10-09", truncated: false, alerts: [], sessions: [] });
    expect(html(createElement(CashAdmin, { user }))).toContain("Nenhum caixa no período");
    state.byPath["/api/admin/finance/cash"] = failed("internal");
    expect(html(createElement(CashAdmin, { user }))).toContain("notice-error");
  });

  it("detalhe: carregando, erro e dados (revisão e reabertura aparecem no fechado com divergência)", () => {
    const path = `/api/cash/${openSession.sessionId}`;
    expect(html(createElement(CashSessionDetail, { user, sessionId: openSession.sessionId }))).toContain("Carregando…");
    state.byPath[path] = failed("forbidden");
    expect(html(createElement(CashSessionDetail, { user, sessionId: openSession.sessionId }))).toContain("notice-error");
    state.byPath[path] = ready(openSession);
    expect(html(createElement(CashSessionDetail, { user, sessionId: openSession.sessionId }))).toContain("Recebido até agora");
  });
});

describe("Taxas, conferência e relatório (contêineres)", () => {
  it("taxas: carregando, erro e dados", () => {
    expect(html(createElement(FeeConfigPage, { user }))).toContain("Carregando…");
    state.byPath["/api/admin/finance/fees"] = failed("forbidden");
    expect(html(createElement(FeeConfigPage, { user }))).toContain("notice-error");
    state.byPath["/api/admin/finance/fees"] = ready({ today: "2026-10-09", production: false, sources: [{ sourceId: "default", kind: "default", name: "Padrão", methods: ["pix"], active: true, fictitious: false }], series: [] });
    expect(html(createElement(FeeConfigPage, { user }))).toContain("Provedores e maquininhas");
  });

  it("conferência: carregando, erro e dados", () => {
    expect(html(createElement(ReconcilePage, { user }))).toContain("Carregando…");
    state.byPath["/api/admin/finance/receipts"] = failed("forbidden");
    expect(html(createElement(ReconcilePage, { user }))).toContain("notice-error");
    state.byPath["/api/admin/finance/receipts"] = ready({ today: "2026-10-09", items: [], truncated: false });
    expect(html(createElement(ReconcilePage, { user }))).toContain("Nada pendente de conferência");
  });

  it("relatório: carregando, erro e dados", () => {
    expect(html(createElement(FinanceReportPage, { user }))).toContain("Carregando…");
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const path = `/api/admin/finance/report`;
    state.byPath[path] = failed("forbidden");
    expect(html(createElement(FinanceReportPage, { user }))).toContain("notice-error");
    state.byPath[path] = ready(buildReport([], { from: `${today.slice(0, 7)}-01`, to: today }, today, { truncated: false, production: false }));
    expect(html(createElement(FinanceReportPage, { user }))).toContain("Base de datas");
  });
});

describe("páginas: só quem tem a capacidade vê a tela", () => {
  const signed = (role: string, permissions: string[] = []) => ({ status: "signedIn", user, role, permissions });
  const pages: [string, () => ReturnType<typeof createElement>][] = [
    ["caixa", () => createElement(OperacaoCaixaPage)],
    ["financeiro", () => createElement(OperacaoFinanceiroPage)],
    ["conferência", () => createElement(OperacaoConferenciaPage)],
    ["taxas", () => createElement(OperacaoTaxasPage)],
    ["relatório", () => createElement(OperacaoRelatorioPage)],
    ["detalhe do caixa", () => createElement(OperacaoCaixaDetalhePage)],
  ];

  it("sem sessão nada aparece; responsável não vê nenhuma", () => {
    for (const [name, page] of pages) {
      state.session = { status: "signedOut" };
      expect(html(page()), name).toBe("");
      state.session = signed("guardian");
      expect(html(page()), name).toMatch(/Seu perfil não/);
    }
  });

  it("secretaria e cantina abrem só o caixa; as telas financeiras são só da administração", () => {
    for (const role of ["secretaria", "cantina"]) {
      state.session = signed(role);
      expect(html(createElement(OperacaoCaixaPage)), role).not.toMatch(/Seu perfil não/);
      for (const [name, page] of pages.slice(1)) expect(html(page()), `${role} ${name}`).toContain("Seu perfil não acessa o financeiro.");
    }
    state.session = signed("admin");
    for (const [name, page] of pages) expect(html(page()), name).not.toMatch(/Seu perfil não/);
  });
});

describe("ações do caixa (resultado só pela resposta do servidor)", () => {
  const ok = <T>(data: T) => ({ ok: true as const, data });
  const bad = (status: number, error: string) => ({ ok: false as const, status, error });
  const draft: CloseDraft = { countedCashCents: 15_000, declared: { pixCents: 3000 }, note: "Gaveta conferida", expectedReceiptCount: 3 };
  const submitting = (result: unknown): Submit & { calls: { url: string; body: Record<string, unknown> }[] } => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fn = (async (url: string, body: Record<string, unknown>) => {
      calls.push({ url, body });
      return result;
    }) as Submit & { calls: typeof calls };
    fn.calls = calls;
    return fn;
  };

  it("abrir: confirma o saldo inicial no corpo; clique duplo e resposta perdida não mostram sucesso", async () => {
    const submit = submitting(ok({ sessionId: "s" }));
    expect(await openCashAction(submit, { point: "secretaria", date: "2026-10-09", openingCents: 10_000 })).toMatchObject({ kind: "ok", text: expect.stringMatching(/Caixa aberto com saldo inicial de R\$\s100,00/) });
    expect(submit.calls[0]).toEqual({ url: "/api/cash/open", body: { point: "secretaria", date: "2026-10-09", openingCents: 10_000, openingConfirmed: true } });
    expect(await openCashAction(submitting(null), { point: "secretaria", date: "2026-10-09", openingCents: 0 })).toBeNull(); // clique duplo
    expect(await openCashAction(submitting(bad(0, "network")), { point: "secretaria", date: "2026-10-09", openingCents: 0 })).toBeNull(); // sem resposta
    expect(await openCashAction(submitting(bad(503, "internal")), { point: "secretaria", date: "2026-10-09", openingCents: 0 })).toBeNull();
    expect(await openCashAction(submitting(bad(409, "session_exists")), { point: "secretaria", date: "2026-10-09", openingCents: 0 })).toMatchObject({ kind: "error", text: expect.stringContaining("já foi aberto") });
    expect(await openCashAction(submitting(bad(409, "invalid_date")), { point: "secretaria", date: "2026-10-09", openingCents: 0 })).toMatchObject({ text: expect.stringContaining("7 dias") });
    expect(await openCashAction(submitting(bad(403, "forbidden")), { point: "secretaria", date: "2026-10-09", openingCents: 0 })).toMatchObject({ kind: "error", text: expect.stringContaining("não tem permissão") });
  });

  it("fechar: corpo com a contagem pelo total, conferências e contagem de recebimentos; divergência vira aviso de erro", async () => {
    const submit = submitting(ok({ hasDivergence: false, cashDifferenceCents: 0, closureNo: 1 }));
    expect(await closeCashAction(submit, "s", draft)).toEqual({ kind: "ok", text: "Caixa fechado sem diferença." });
    expect(submit.calls[0]!.body).toEqual({ sessionId: "s", countedCashCents: 15_000, declared: { pixCents: 3000 }, note: "Gaveta conferida", expectedReceiptCount: 3 });
    const noNote = submitting(ok({ hasDivergence: false, cashDifferenceCents: 0, closureNo: 1 }));
    await closeCashAction(noNote, "s", { ...draft, note: "" });
    expect(noNote.calls[0]!.body).not.toHaveProperty("note");
    expect(await closeCashAction(submitting(ok({ hasDivergence: true, cashDifferenceCents: -1, closureNo: 1 })), "s", draft)).toMatchObject({ kind: "error", text: expect.stringMatching(/divergência \(Falta R\$\s0,01\).*pendente de revisão/) });
    expect(await closeCashAction(submitting(null), "s", draft)).toBeNull();
    expect(await closeCashAction(submitting(bad(0, "network")), "s", draft)).toBeNull();
    expect(await closeCashAction(submitting(bad(409, "stale_summary")), "s", draft)).toMatchObject({ text: expect.stringContaining("novos recebimentos") });
    expect(await closeCashAction(submitting(bad(409, "already_closed")), "s", draft)).toMatchObject({ text: expect.stringContaining("já está fechado") });
    expect(await closeCashAction(submitting(bad(403, "forbidden")), "s", draft)).toMatchObject({ kind: "error" });
    expect(await closeCashAction(submitting(bad(500, "internal")), "s", draft)).toBeNull();
  });

  it("rascunhos: saldo inicial só com a confirmação; fechamento só com contagem válida, conferências ausentes ficam de fora", () => {
    expect(openingOf("100", true)).toBe(10_000);
    expect(openingOf("0", true)).toBe(0);
    expect(openingOf("100", false)).toBeNull();
    expect(openingOf("abc", true)).toBeNull();
    expect(closeDraftOf({ counted: "150", pix: "30", debit: "", credit: "", note: " ok ", receiptCount: 4 })).toEqual({ countedCashCents: 15_000, declared: { pixCents: 3000 }, note: "ok", expectedReceiptCount: 4 });
    expect(closeDraftOf({ counted: "", pix: "", debit: "", credit: "", note: "", receiptCount: 0 })).toBeNull();
    expect(closeDraftOf({ counted: "10", pix: "xx", debit: "", credit: "", note: "", receiptCount: 0 })).toBeNull();
  });
});

describe("ações da administração e exportação", () => {
  it("mensagem de sucesso, erro mapeado (taxas, conferência, caixa), erro geral e envio ignorado", async () => {
    const ok = async () => ({ ok: true as const, data: {} });
    const bad = (error: string) => async () => ({ ok: false as const, status: 409, error });
    expect(await adminAction(ok as Submit, "/x", {}, "Feito")).toEqual({ kind: "ok", text: "Feito" });
    expect(await adminAction(bad("effective_in_past") as Submit, "/x", {}, "Feito", FEE_ERRORS)).toMatchObject({ kind: "error", text: expect.stringContaining("retroativas") });
    expect(await adminAction(bad("stale_receipt") as Submit, "/x", {}, "Feito", RECONCILE_ERRORS)).toMatchObject({ text: expect.stringContaining("conferido por outra operação") });
    expect(await adminAction(bad("not_closed") as Submit, "/x", {}, "Feito", SESSION_ERRORS)).toMatchObject({ text: expect.stringContaining("não está fechado") });
    expect(await adminAction(bad("coisa_estranha") as Submit, "/x", {}, "Feito")).toMatchObject({ kind: "error" });
    expect(await adminAction((async () => null) as Submit, "/x", {}, "Feito")).toBeNull();
  });

  it("exportação: salva o CSV com o nome do mês; erro do servidor, mês grande demais e falha de rede viram texto", async () => {
    const saved: string[] = [];
    const deps = (response: { ok: boolean; body?: unknown } | "throw"): ExportDeps => ({
      token: async () => "t",
      fetchFn: async (url, init) => {
        expect(url).toBe("/api/admin/finance/export?month=2026-10&view=detail");
        expect(init.headers.authorization).toBe("Bearer t");
        if (response === "throw") throw new Error("rede");
        return { ok: response.ok, json: async () => response.body, blob: async () => new Blob(["a;b"]) };
      },
      save: (_blob, filename) => void saved.push(filename),
    });
    expect(await exportAction(deps({ ok: true }), "2026-10", "detail")).toBeNull();
    expect(saved).toEqual(["financeiro-detalhe-2026-10.csv"]);
    expect(await exportAction(deps({ ok: false, body: { error: "export_truncated" } }), "2026-10", "detail")).toContain("demais no mês");
    expect(await exportAction(deps({ ok: false, body: { error: "forbidden" } }), "2026-10", "detail")).toContain("não tem permissão");
    expect(await exportAction(deps({ ok: false, body: undefined }), "2026-10", "detail")).toContain("Não foi possível");
    expect(await exportAction(deps("throw"), "2026-10", "detail")).toContain("Sem conexão");
    const summary: string[] = [];
    await exportAction({ ...deps({ ok: true }), fetchFn: async () => ({ ok: true, json: async () => ({}), blob: async () => new Blob(["x"]) }), save: (_b, f) => void summary.push(f) }, "2026-09", "summary");
    expect(summary).toEqual(["financeiro-resumo-2026-09.csv"]);
  });

  it("percentual digitado: pontos-base de 0,01%", () => {
    expect(parsePercentBp("3,00")).toBe(300);
  });
});
