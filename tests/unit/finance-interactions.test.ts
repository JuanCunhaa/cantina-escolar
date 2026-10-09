// Interações das telas do caixa e do financeiro (F20) SEM navegador: um mini-renderizador (tests/helpers/mini-react.ts) executa os
// componentes, dispara onChange/onClick/onSubmit e confere o que a pessoa vê depois. Prova a lógica de interface: só abre o caixa com
// saldo confirmado, fechamento em duas etapas (revisar → confirmar) com a diferença à vista, formulários de taxa com validação,
// conferência com motivo na correção e a mensagem de resultado SÓ pela resposta do servidor. Fluxo real no navegador: e2e/finance.spec.ts.
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type Harness } from "../helpers/mini-react";

const state = vi.hoisted(() => ({
  byPath: {} as Record<string, unknown>,
  submit: (async () => null) as (url: string, body: Record<string, unknown>) => Promise<unknown>,
  reloads: 0,
}));
vi.mock("@/modules/orders/use-operations", () => ({
  useServerQuery: (_user: unknown, path: string) => (state.byPath[path] as object) ?? { status: "loading", data: null, errorCode: null, refreshing: false, reload: () => undefined },
}));
vi.mock("@/modules/pos/use-pos", () => ({ usePosSubmit: () => ({ busy: false, uncertain: false, submit: (url: string, body: Record<string, unknown>) => state.submit(url, body) }) }));
vi.mock("next/link", () => ({ default: (props: { href: string; children: unknown }) => createElement("a", { href: props.href }, props.children as string) }));

import { CashDesk } from "@/modules/cash/components/cash-desk";
import { CashPointView } from "@/modules/cash/components/cash-point";
import { methodTotals } from "@/modules/cash/cash-model";
import { CashAdmin, CashAdminView, CashSessionDetail, SessionDetailView } from "@/modules/fees/components/cash-admin";
import { FeeConfigPage, FeeConfigView } from "@/modules/fees/components/fee-config";
import { ReconcilePage, ReconcileView } from "@/modules/fees/components/reconcile-list";
import { FinanceReportPage, ReportView } from "@/modules/reports/components/finance-report-view";
import { buildReport } from "@/modules/reports/finance-report";

const user = { uid: "u1", getIdToken: async () => "tok" } as never;
const ready = (data: unknown) => ({ status: "ready", data, errorCode: null, refreshing: false, reload: () => void (state.reloads += 1) });
const button = (h: Harness, label: string) => h.find((n) => n.type === "button" && n.children.map((c) => c.text ?? "").join("").includes(label));
const input = (h: Harness, id: string) => h.byId(id);

beforeEach(() => {
  state.byPath = {};
  state.submit = async () => null;
  state.reloads = 0;
});

const live = { receiptCount: 3, byMethod: methodTotals([{ ref: "topup:a", kind: "topup", method: "cash", grossCents: 5000, reversedCents: 0 }, { ref: "topup:b", kind: "topup", method: "pix", grossCents: 3000, reversedCents: 0 }]), expectedCashCents: 15_000, walletConsumption: { orderCount: 0, totalCents: 0 } };
const baseSession = { sessionId: "2026-10-09__secretaria__u1", date: "2026-10-09", point: "secretaria", operatorName: "Maria", status: "open", openingCents: 10_000, openedAt: null, closureNo: 0, reopenCount: 0, closure: null, review: null, live, afterClose: null, history: [], events: [] };

describe("caixa do operador: abrir e fechar", () => {
  it("só abre com a contagem confirmada; valor inválido avisa; ZERO é válido", async () => {
    const opened: number[] = [];
    const h = mount(CashPointView as never, { point: "secretaria", date: "2026-10-09", session: null, live: null, locked: false, onOpen: (c: number) => opened.push(c), onClose: () => undefined });
    expect(h.text()).toContain("Sem caixa aberto");
    await h.change(input(h, "cash-opening"), "abc");
    expect(h.text()).toContain("Use um valor como 120,00");
    await h.change(input(h, "cash-opening"), "100");
    await h.submit(h.find((n) => n.type === "form")); // sem confirmar: nada acontece
    expect(opened).toEqual([]);
    await h.change(h.byTestId("cash-opening-confirm"), true);
    expect(h.text()).toContain("Contei R$ 100,00 na gaveta");
    await h.submit(h.find((n) => n.type === "form"));
    expect(opened).toEqual([10_000]);
    await h.change(input(h, "cash-opening"), "0");
    await h.submit(h.find((n) => n.type === "form"));
    expect(opened).toEqual([10_000, 0]);
  });

  it("fechamento em duas etapas: revisar mostra esperado, contado e diferença; voltar edita; confirmar envia o rascunho", async () => {
    const closed: unknown[] = [];
    const h = mount(CashPointView as never, { point: "secretaria", date: "2026-10-09", session: baseSession, live, locked: false, onOpen: () => undefined, onClose: (d: unknown) => closed.push(d) });
    expect(h.text()).toContain("Fechar o caixa");
    await h.submit(h.find((n) => n.type === "form")); // sem contagem: não avança
    expect(h.text()).not.toContain("Confirmar fechamento");
    await h.change(input(h, "cash-counted"), "149,99");
    await h.change(input(h, "cash-pix"), "30");
    await h.change(input(h, "cash-debit"), "0");
    await h.change(input(h, "cash-credit"), "5");
    await h.change(input(h, "cash-note"), " gaveta conferida ");
    await h.submit(h.find((n) => n.type === "form"));
    const review = h.text();
    expect(review).toContain("Dinheiro esperado na gaveta R$ 150,00");
    expect(review).toMatch(/Falta R\$\s0,01/);
    expect(review).toContain("Qualquer diferença, mesmo de 1 centavo, fica pendente de revisão");
    expect(review).toContain("Cartão de crédito (maquininha)");
    await h.click(button(h, "Voltar"));
    expect(h.text()).toContain("Revisar fechamento");
    await h.change(input(h, "cash-counted"), "150");
    await h.change(input(h, "cash-credit"), "");
    await h.change(input(h, "cash-debit"), "");
    await h.submit(h.find((n) => n.type === "form"));
    expect(h.text()).toContain("Sem diferença");
    await h.submit(h.find((n) => n.type === "form"));
    expect(closed).toEqual([{ countedCashCents: 15_000, declared: { pixCents: 3000 }, note: "gaveta conferida", expectedReceiptCount: 3 }]);
  });

  it("conferência inválida de Pix/cartão impede revisar", async () => {
    const h = mount(CashPointView as never, { point: "secretaria", date: "2026-10-09", session: baseSession, live, locked: false, onOpen: () => undefined, onClose: () => undefined });
    await h.change(input(h, "cash-counted"), "150");
    await h.change(input(h, "cash-pix"), "xx");
    expect(h.text()).toContain("Confira os valores de Pix e cartão");
    await h.submit(h.find((n) => n.type === "form"));
    expect(h.text()).not.toContain("Confirmar fechamento");
  });
});

describe("CashDesk (contêiner): resposta do servidor decide a mensagem", () => {
  const data = { date: "2026-10-09", points: [{ point: "secretaria", sessionId: baseSession.sessionId, session: null, live: { ...live, receiptCount: 0 } }], alerts: [{ kind: "open_not_closed", date: "2026-10-08", point: "secretaria", operatorUid: "u1", operatorName: "M", sessionId: "s", detail: null }], recent: [] };

  it("abrir: sucesso, sessão já aberta e envio ignorado; o alerta leva ao dia pendente", async () => {
    state.byPath["/api/cash"] = ready(data);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    state.submit = async (url, body) => {
      calls.push({ url, body });
      return { ok: true, data: {} };
    };
    const h = mount(CashDesk as never, { user });
    await h.change(input(h, "cash-opening"), "100");
    await h.change(h.byTestId("cash-opening-confirm"), true);
    await h.submit(h.find((n) => n.type === "form"));
    expect(calls[0]).toMatchObject({ url: "/api/cash/open", body: { point: "secretaria", openingCents: 10_000, openingConfirmed: true } });
    expect(h.byTestId("cash-message").children[0]!.text).toMatch(/Caixa aberto com saldo inicial de R\$\s100,00/);
    expect(state.reloads).toBeGreaterThan(0);

    state.submit = async () => ({ ok: false, status: 409, error: "session_exists" });
    await h.submit(h.find((n) => n.type === "form"));
    expect(h.byTestId("cash-message").children[0]!.text).toContain("já foi aberto");

    state.submit = async () => null; // clique duplo: nenhuma mensagem nova
    await h.submit(h.find((n) => n.type === "form"));

    await h.click(button(h, "Ir para este dia"));
    expect(input(h, "cash-date").props.value).toBe("2026-10-08");
  });

  it("fechar: divergência vira aviso de erro com a falta; resumo velho pede conferir de novo", async () => {
    const session = { ...baseSession };
    state.byPath["/api/cash"] = ready({ ...data, alerts: [], points: [{ point: "secretaria", sessionId: session.sessionId, session, live }] });
    const h = mount(CashDesk as never, { user });
    await h.change(input(h, "cash-counted"), "149,99");
    await h.submit(h.find((n) => n.type === "form"));
    state.submit = async () => ({ ok: true, data: { hasDivergence: true, cashDifferenceCents: -1, closureNo: 1 } });
    await h.submit(h.find((n) => n.type === "form"));
    expect(h.byTestId("cash-message").children[0]!.text).toMatch(/divergência \(Falta R\$\s0,01\)/);
    const again = mount(CashDesk as never, { user });
    await again.change(input(again, "cash-counted"), "150");
    await again.submit(again.find((n) => n.type === "form"));
    state.submit = async () => ({ ok: false, status: 409, error: "stale_summary" });
    await again.submit(again.find((n) => n.type === "form"));
    expect(again.byTestId("cash-message").children[0]!.text).toContain("novos recebimentos");
  });
});

describe("administração: caixas, revisão e reabertura", () => {
  const closedSession = { ...baseSession, status: "closed", closureNo: 1, live: null, closure: { no: 1, closedAtIso: "2026-10-09T20:00:00.000Z", byMethod: live.byMethod, expectedCashCents: 15_000, countedCashCents: 14_900, cashDifferenceCents: -100, declared: {}, largestDifferenceCents: 100, hasDivergence: true, receiptCount: 3, walletConsumption: { orderCount: 0, totalCents: 0 }, note: null, closedByName: "Maria" }, review: { status: "pending", closureNo: 1, note: null, byName: null, atIso: null, selfReview: false } };

  it("lista: trocar o período chama onRange com a outra ponta preservada", async () => {
    const ranges: string[][] = [];
    const h = mount(CashAdminView as never, { list: { from: "2026-10-03", to: "2026-10-09", truncated: true, alerts: [], sessions: [] }, from: "2026-10-03", to: "2026-10-09", onRange: (f: string, t: string) => ranges.push([f, t]) });
    await h.change(input(h, "fin-from"), "2026-10-01");
    await h.change(input(h, "fin-to"), "2026-10-08");
    await h.change(input(h, "fin-to"), "");
    expect(ranges).toEqual([["2026-10-01", "2026-10-09"], ["2026-10-03", "2026-10-08"]]);
    expect(h.text()).toContain("Lista parcial");
  });

  it("contêiner da lista troca o período e relê", async () => {
    state.byPath["/api/admin/finance/cash"] = ready({ from: "2026-10-03", to: "2026-10-09", truncated: false, alerts: [], sessions: [] });
    const h = mount(CashAdmin as never, { user });
    await h.change(input(h, "fin-from"), "2026-09-01");
    expect(input(h, "fin-from").props.value).toBe("2026-09-01");
  });

  it("detalhe: revisar exige nota; escolher decisão; reabrir exige motivo; envia pelos comandos", async () => {
    const reviews: unknown[][] = [];
    const reopens: string[] = [];
    const h = mount(SessionDetailView as never, { session: closedSession, message: null, locked: false, onReview: (...a: unknown[]) => reviews.push(a), onReopen: (r: string) => reopens.push(r) });
    await h.change(input(h, "fin-note"), "curta");
    await h.submit(h.findAll((n) => n.type === "form")[0]!);
    await h.change(input(h, "fin-note"), "Troco conferido com a operadora");
    await h.change(h.findAll((n) => n.type === "input" && n.props.name === "fin-decision")[1]!, true);
    await h.submit(h.findAll((n) => n.type === "form")[0]!);
    expect(reviews).toEqual([["followup", "Troco conferido com a operadora"]]);
    await h.change(input(h, "fin-reason"), "Faltou lançar o troco devolvido");
    await h.submit(h.findAll((n) => n.type === "form")[1]!);
    expect(reopens).toEqual(["Faltou lançar o troco devolvido"]);
  });

  it("contêiner do detalhe: sucesso e erro mapeado vêm da resposta", async () => {
    state.byPath[`/api/cash/${closedSession.sessionId}`] = ready(closedSession);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    state.submit = async (url, body) => {
      calls.push({ url, body });
      return { ok: true, data: {} };
    };
    const h = mount(CashSessionDetail as never, { user, sessionId: closedSession.sessionId });
    await h.change(input(h, "fin-note"), "Troco conferido com a operadora");
    await h.submit(h.findAll((n) => n.type === "form")[0]!);
    expect(calls[0]).toMatchObject({ url: "/api/admin/finance/cash/review", body: { sessionId: closedSession.sessionId, closureNo: 1, decision: "approved" } });
    expect(h.byTestId("fin-message").children[0]!.text).toContain("aprovada, sem ajuste");
    state.submit = async () => ({ ok: false, status: 409, error: "not_closed" });
    await h.change(input(h, "fin-reason"), "Faltou lançar o troco devolvido");
    await h.submit(h.findAll((n) => n.type === "form")[1]!);
    expect(calls).toHaveLength(1);
    expect(h.byTestId("fin-message").children[0]!.text).toContain("não está fechado");
    state.submit = async () => ({ ok: true, data: {} });
    await h.submit(h.findAll((n) => n.type === "form")[1]!);
    expect(h.byTestId("fin-message").children[0]!.text).toContain("Caixa reaberto");
  });
});

describe("taxas e maquininhas: formulários e comandos", () => {
  const config = {
    today: "2026-10-09",
    production: false,
    sources: [
      { sourceId: "default", kind: "default", name: "Padrão", methods: ["pix", "card_debit", "card_credit"], active: true, fictitious: false },
      { sourceId: "term_abc", kind: "terminal", name: "[FICTÍCIA] Maquininha", methods: ["card_debit", "card_credit"], active: true, fictitious: true },
    ],
    series: [{ seriesId: "term_abc__card_credit", sourceId: "term_abc", method: "card_credit", blockedInProduction: false, current: null, versions: [{ n: 2, effectiveFrom: "2026-10-20", enabled: true, percentBp: 500, fixedCents: 0, settlementDays: 2, fictitious: true, reason: "r", createdByUid: "a", createdOn: "2026-10-05", createdAtIso: "x", withdrawn: null, state: "future" }] }],
  };

  it("cadastrar maquininha: valida código e meios; envia o corpo certo", async () => {
    const created: unknown[] = [];
    const h = mount(FeeConfigView as never, { config, message: null, locked: false, onCreateSource: (b: unknown) => created.push(b), onToggleSource: () => undefined, onPublish: () => undefined, onWithdraw: () => undefined });
    await h.change(input(h, "src-code"), "Maq 1"); // inválido
    await h.change(input(h, "src-name"), "Maquininha do balcão");
    await h.submit(h.findAll((n) => n.type === "form")[1]!);
    expect(created).toEqual([]);
    await h.change(input(h, "src-code"), "balcao1");
    const radios = h.findAll((n) => n.type === "input" && n.props.name === "src-kind");
    await h.change(radios[1]!, true); // provedor online: só Pix e crédito
    await h.change(radios[0]!, true);
    await h.submit(h.findAll((n) => n.type === "form")[1]!);
    expect(created).toEqual([{ kind: "terminal", code: "balcao1", name: "Maquininha do balcão", methods: ["card_debit", "card_credit"], fictitious: true }]);
  });

  it("publicar versão: percentual, fixo e prazo validados; troca de fonte ajusta meios; envia pontos-base", async () => {
    const published: unknown[] = [];
    const h = mount(FeeConfigView as never, { config, message: null, locked: false, onCreateSource: () => undefined, onToggleSource: () => undefined, onPublish: (b: unknown) => published.push(b), onWithdraw: () => undefined });
    await h.change(input(h, "rule-source"), "term_abc");
    await h.change(input(h, "rule-method"), "card_credit");
    await h.change(input(h, "rule-from"), "2026-10-30");
    await h.change(input(h, "rule-percent"), "3,00");
    await h.change(input(h, "rule-fixed"), "0,39");
    await h.change(input(h, "rule-days"), "30");
    await h.change(input(h, "rule-reason"), "curto");
    await h.submit(h.findAll((n) => n.type === "form")[0]!);
    expect(published).toEqual([]);
    await h.change(input(h, "rule-reason"), "Regra FICTÍCIA de homologação");
    const boxes = h.findAll((n) => n.type === "input" && n.props.type === "checkbox");
    await h.change(boxes.find((b) => b.props.checked === true && b.props.disabled === undefined)!, false); // desativa "Regra ativa" (a única marcada sem estar travada)
    await h.submit(h.findAll((n) => n.type === "form")[0]!);
    expect(published).toEqual([{ sourceId: "term_abc", method: "card_credit", effectiveFrom: "2026-10-30", enabled: false, percentBp: 300, fixedCents: 39, settlementDays: 30, fictitious: true, reason: "Regra FICTÍCIA de homologação" }]);
    await h.change(input(h, "rule-percent"), "31");
    await h.submit(h.findAll((n) => n.type === "form")[0]!);
    expect(published).toHaveLength(1);
  });

  it("arquivar maquininha e retirar versão futura pedem motivo de 10+ caracteres", async () => {
    const toggled: unknown[][] = [];
    const withdrawn: unknown[] = [];
    const h = mount(FeeConfigView as never, { config, message: null, locked: false, onCreateSource: () => undefined, onToggleSource: (...a: unknown[]) => toggled.push(a), onPublish: () => undefined, onWithdraw: (b: unknown) => withdrawn.push(b) });
    await h.click(button(h, "Arquivar"));
    const reason = h.find((n) => n.type === "input" && n.props["aria-label"] === "Motivo");
    await h.change(reason, "curto");
    await h.change(reason, "Maquininha devolvida ao banco");
    await h.click(button(h, "Confirmar"));
    expect(toggled).toEqual([["term_abc", false, "Maquininha devolvida ao banco"]]);
    await h.click(button(h, "Retirar"));
    const why = h.find((n) => n.type === "input" && n.props["aria-label"] === "Motivo da retirada");
    await h.change(why, "Publicada por engano antes da hora");
    await h.click(button(h, "Confirmar"));
    expect(withdrawn).toEqual([{ sourceId: "term_abc", method: "card_credit", version: 2, reason: "Publicada por engano antes da hora" }]);
  });

  it("contêiner: cada comando usa a rota certa e a mensagem vem da resposta (erro mapeado inclusive)", async () => {
    state.byPath["/api/admin/finance/fees"] = ready(config);
    const urls: string[] = [];
    state.submit = async (url) => {
      urls.push(url);
      return { ok: true, data: {} };
    };
    const h = mount(FeeConfigPage as never, { user });
    await h.change(input(h, "src-code"), "balcao2");
    await h.change(input(h, "src-name"), "Maquininha 2");
    await h.submit(h.findAll((n) => n.type === "form")[1]!);
    expect(urls).toEqual(["/api/admin/finance/sources"]);
    expect(h.byTestId("fees-message").children[0]!.text).toBe("Cadastro criado.");
    await h.change(input(h, "rule-percent"), "3");
    await h.change(input(h, "rule-reason"), "Regra FICTÍCIA de homologação");
    state.submit = async (url) => {
      urls.push(url);
      return { ok: false, status: 409, error: "effective_in_past" };
    };
    await h.submit(h.findAll((n) => n.type === "form")[0]!);
    expect(urls.at(-1)).toBe("/api/admin/finance/rules");
    expect(h.byTestId("fees-message").children[0]!.text).toContain("retroativas");
    state.submit = async (url) => {
      urls.push(url);
      return { ok: true, data: {} };
    };
    await h.click(button(h, "Arquivar"));
    await h.change(h.find((n) => n.type === "input" && n.props["aria-label"] === "Motivo"), "Maquininha devolvida ao banco");
    await h.click(button(h, "Confirmar"));
    await h.click(button(h, "Retirar"));
    await h.change(h.find((n) => n.type === "input" && n.props["aria-label"] === "Motivo da retirada"), "Publicada por engano antes da hora");
    await h.click(button(h, "Confirmar"));
    expect(urls.slice(-2)).toEqual(["/api/admin/finance/sources/active", "/api/admin/finance/rules/withdraw"]);
  });
});

describe("conferência e relatório: interações", () => {
  const item = { ref: "topup:tpm_1", kind: "topup", point: "secretaria", label: "Aluno", operatorName: "M", method: "card_credit", sourceId: "term_abc", receivedOn: "2026-10-05", grossCents: 5000, reversedCents: 0, fee: { status: "pending", cents: null, source: "operator" }, estimate: { cents: 150, seriesId: "s", ruleVersion: 1, effectiveFrom: "2026-10-01", percentBp: 300, fixedCents: 0, settlementDays: 30, fictitious: true, computedOn: "2026-10-05" }, effective: { basis: "estimated", cents: 150, estimatedCents: 150, differenceCents: null }, settlement: { status: "pending", expectedOn: "2026-10-04", settledOn: null }, overdue: true, financeVersion: 0, reference: null };

  it("conferir: taxa acima do valor é recusada; salvar envia a versão vista; correção exige motivo", async () => {
    const saved: unknown[] = [];
    const h = mount(ReconcileView as never, { list: { today: "2026-10-09", items: [item], truncated: true }, message: null, locked: false, onSave: (d: unknown) => saved.push(d) });
    await h.click(button(h, "Conferir"));
    await h.change(input(h, "fee-topup:tpm_1"), "60");
    expect(h.text()).toContain("A taxa precisa estar entre zero e");
    await h.submit(h.find((n) => n.type === "form"));
    expect(saved).toEqual([]);
    await h.change(input(h, "fee-topup:tpm_1"), "1,48");
    await h.change(input(h, "set-topup:tpm_1"), "2026-10-08");
    await h.submit(h.find((n) => n.type === "form"));
    expect(saved).toEqual([{ ref: "topup:tpm_1", expectedVersion: 0, actualFeeCents: 148, settledOn: "2026-10-08" }]);
    await h.click(button(h, "Fechar"));
    expect(h.text()).toContain("Lista parcial");
  });

  it("conferido: corrigir pede motivo", async () => {
    const saved: unknown[] = [];
    const confirmed = { ...item, fee: { status: "confirmed", cents: 148, source: "operator" }, effective: { basis: "confirmed", cents: 148, estimatedCents: 150, differenceCents: -2 }, financeVersion: 1, settlement: { status: "settled", expectedOn: null, settledOn: "2026-10-08" }, overdue: false };
    const h = mount(ReconcileView as never, { list: { today: "2026-10-09", items: [confirmed], truncated: false }, message: null, locked: false, onSave: (d: unknown) => saved.push(d) });
    await h.click(button(h, "Conferir"));
    await h.change(input(h, "fee-topup:tpm_1"), "1,40");
    await h.submit(h.find((n) => n.type === "form"));
    expect(saved).toEqual([]);
    await h.change(input(h, "why-topup:tpm_1"), "Valor lido errado do extrato");
    await h.submit(h.find((n) => n.type === "form"));
    expect(saved).toEqual([{ ref: "topup:tpm_1", expectedVersion: 1, actualFeeCents: 140, reason: "Valor lido errado do extrato" }]);
  });

  it("contêiner: salvar usa a rota e mostra a resposta; versão velha vira texto claro", async () => {
    state.byPath["/api/admin/finance/receipts"] = ready({ today: "2026-10-09", items: [item], truncated: false });
    const urls: string[] = [];
    state.submit = async (url) => {
      urls.push(url);
      return { ok: true, data: {} };
    };
    const h = mount(ReconcilePage as never, { user });
    await h.click(button(h, "Conferir"));
    await h.change(input(h, "fee-topup:tpm_1"), "1,48");
    await h.submit(h.find((n) => n.type === "form"));
    expect(urls).toEqual(["/api/admin/finance/reconcile"]);
    expect(h.byTestId("rec-message").children[0]!.text).toContain("Carteira e livro não foram alterados");
    state.submit = async () => ({ ok: false, status: 409, error: "stale_receipt" });
    await h.submit(h.find((n) => n.type === "form"));
    expect(h.byTestId("rec-message").children[0]!.text).toContain("conferido por outra operação");
  });

  it("relatório: período e exportação; contêiner baixa pelo navegador (fetch/URL/link simulados)", async () => {
    const today = "2026-10-09";
    const report = buildReport([], { from: "2026-10-01", to: today }, today, { truncated: false, production: false });
    const ranges: string[][] = [];
    const exported: string[] = [];
    const view = mount(ReportView as never, { report, from: "2026-10-01", to: today, onRange: (f: string, t: string) => ranges.push([f, t]), onExport: (v: string) => exported.push(v), exporting: false, message: null });
    await view.change(input(view, "rep-from"), "2026-09-01");
    await view.change(input(view, "rep-to"), "2026-10-05");
    await view.click(view.byTestId("rep-export-detail"));
    await view.click(view.byTestId("rep-export-summary"));
    expect(ranges).toEqual([["2026-09-01", today], ["2026-10-01", "2026-10-05"]]);
    expect(exported).toEqual(["detail", "summary"]);

    const clicks: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => ({ ok: true, json: async () => ({}), blob: async () => new Blob(["a;b"]), url }));
    vi.stubGlobal("document", { createElement: () => ({ click() { clicks.push("click"); }, set href(v: string) { clicks.push(`href:${v}`); }, set download(v: string) { clicks.push(`file:${v}`); } }) });
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:teste";
    URL.revokeObjectURL = () => undefined;
    try {
      state.byPath["/api/admin/finance/report"] = ready(report);
      const h = mount(FinanceReportPage as never, { user });
      await h.click(h.byTestId("rep-export-summary"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(clicks).toEqual(expect.arrayContaining(["click", "href:blob:teste"]));
      expect(clicks.find((c) => c.startsWith("file:"))).toMatch(/^file:financeiro-resumo-\d{4}-\d{2}\.csv$/);
      await h.change(input(h, "rep-from"), "2026-10-02");
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      vi.unstubAllGlobals();
    }
  });
});
