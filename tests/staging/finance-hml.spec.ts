// Verificação DIRIGIDA da F20 na homologação (emulador no ensaio; Firebase `cantina-escolar-hml` no servidor local ou publicado),
// com dados FICTÍCIOS próprios e RECEBIMENTOS SIMULADOS pelo fluxo normal (nenhum dinheiro transferido, nenhum provedor real,
// nenhuma regra real): cadastro de maquininha e regra FICTÍCIAS, estimativa congelada no recebimento, conferência da taxa real e da
// liquidação, caixa por operador (abrir, fechar sem e com divergência, revisar sem ajuste, reabrir, alertas), relatório e CSV
// mensal, autorização e Rules publicadas. O Admin SDK só LÊ (auditoria); tudo o mais passa pelas rotas autorizadas.
// NÃO prova: taxa/prazo REAIS do Mercado Pago ou de maquininha, produção (a recusa de regra fictícia em produção é provada no
// emulador, pois a homologação roda com APP_ENV=staging), pagamento real, concorrência em escala nem latência.
// Fica na homologação (auditável e marcado como teste): a maquininha e a regra fictícias (a maquininha é ARQUIVADA no fim), as
// sessões de caixa e os recebimentos; só as contas efêmeras saem no teardown.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { admin as harnessAdmin } from "../../scripts/staging/admin.ts";
import { localDateOf, addDays } from "../../src/lib/dates/school-time.ts";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const code = `f20${tag}`.toLowerCase().replace(/[^a-z0-9]/g, "");
const TERMINAL = `term_${code}`;
const MARK = "TESTE HML F20 (recebimento simulado, sem dinheiro)";
const TODAY = localDateOf(new Date());
let fam: Family;
let secretaria: TestUser;
let secretaria2: TestUser;
let secretaria3: TestUser;
let cantina: TestUser;
let cardTopupId = "";
let ref = "";
let closedSession = "";

type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: user ? bearer(user.idToken) : {}, data });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
async function reconciled(request: APIRequestContext, balanceCents: number) {
  const r = await call(request, fam.admin, "GET", `/api/wallets/reconcile?studentId=${fam.studentId}`);
  expect(r.body, "reconciliação da carteira").toMatchObject({ ok: true, problems: [], balanceCents });
}
const wallet = async (request: APIRequestContext) => (await call(request, fam.guardian, "GET", `/api/wallets?studentId=${fam.studentId}`)).body as { balanceCents: number; version: number };
const audit = async (id: string) => (await harnessAdmin().db.doc(`auditLog/${id}`).get()).data();
const topup = (request: APIRequestContext, by: TestUser, body: Record<string, unknown>) => call(request, by, "POST", "/api/topups", { key: newKey("hml-f20"), studentId: fam.studentId, receivedConfirmed: true, note: MARK, ...body });
const open = (request: APIRequestContext, by: TestUser, over: Record<string, unknown> = {}) => call(request, by, "POST", "/api/cash/open", { key: newKey("hml-f20"), point: "secretaria", openingCents: 10_000, openingConfirmed: true, ...over });
const close = (request: APIRequestContext, by: TestUser, sessionId: string, over: Record<string, unknown> = {}) => call(request, by, "POST", "/api/cash/close", { key: newKey("hml-f20"), sessionId, countedCashCents: 0, ...over });
const sid = (date: string, user: TestUser) => `${date}__secretaria__${user.uid}`;

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-f20-${tag}`);
  [secretaria, secretaria2, secretaria3, cantina] = await Promise.all([
    createTestUser(`hml-f20-sec1-${tag}`, "secretaria", { displayName: "Secretaria HML F20 (teste)" }),
    createTestUser(`hml-f20-sec2-${tag}`, "secretaria", { displayName: "Secretaria 2 HML F20 (teste)" }),
    createTestUser(`hml-f20-sec3-${tag}`, "secretaria", { displayName: "Secretaria 3 HML F20 (teste)" }),
    createTestUser(`hml-f20-cant-${tag}`, "cantina", { displayName: "Cantina HML F20 (teste)" }),
  ]);
});

test.afterAll(async ({ request }) => {
  // A maquininha fictícia deixa de ser oferecida; a regra e os recebimentos ficam como histórico auditável.
  await call(request, fam.admin, "POST", "/api/admin/finance/sources/active", { key: newKey("hml-f20"), sourceId: TERMINAL, active: false, reason: `${MARK}: arquivar a maquininha fictícia` }).catch(() => undefined);
});

test("cadastro FICTÍCIO: maquininha e regra versionada, sem retroatividade; só a administração; o operador vê apenas o nome", async ({ request }) => {
  const source = { key: newKey("hml-f20"), kind: "terminal", code, name: `Maquininha F20 HML ${tag} (fictícia)`, methods: ["card_debit", "card_credit"], fictitious: true };
  for (const user of [secretaria, cantina, fam.guardian]) expect((await call(request, user, "POST", "/api/admin/finance/sources", source)).status, user.email).toBe(403);
  expect((await call(request, null, "POST", "/api/admin/finance/sources", source)).status).toBe(401);
  const created = await call(request, fam.admin, "POST", "/api/admin/finance/sources", source);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/sources", { ...source, key: newKey("hml-f20") })).body.error).toBe("source_exists");

  const rule = { key: newKey("hml-f20"), sourceId: TERMINAL, method: "card_credit", effectiveFrom: TODAY, enabled: true, percentBp: 300, fixedCents: 0, settlementDays: 30, settlementBasis: "calendar_days", fictitious: true, reason: `${MARK}: regra FICTÍCIA` };
  const v1 = await call(request, fam.admin, "POST", "/api/admin/finance/rules", rule);
  expect(v1, JSON.stringify(v1.body)).toMatchObject({ status: 200, body: { version: 1, effectiveFrom: TODAY, replayed: false } });
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/rules", rule)).body).toMatchObject({ replayed: true, version: 1 });
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/rules", { ...rule, key: newKey("hml-f20"), effectiveFrom: addDays(TODAY, -1) })).body.error).toBe("effective_in_past");
  // a base do prazo é explícita: prazo sem base, base sem prazo e dias úteis são recusados
  for (const bad of [{ settlementBasis: null }, { settlementDays: null }, { settlementBasis: "business_days" }]) expect((await call(request, fam.admin, "POST", "/api/admin/finance/rules", { ...rule, key: newKey("hml-f20"), effectiveFrom: addDays(TODAY, 20), ...bad })).status).toBe(400);
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/rules", { ...rule, key: newKey("hml-f20"), percentBp: 999 })).body.error).toBe("effective_not_after_last");
  // a v2 (futura) não tem prazo configurado: a previsão de liquidação ficará pendente quando ela valer
  const v2 = await call(request, fam.admin, "POST", "/api/admin/finance/rules", { ...rule, key: newKey("hml-f20"), effectiveFrom: addDays(TODAY, 10), percentBp: 500, settlementDays: null, settlementBasis: null });
  expect(v2.body).toMatchObject({ version: 2 });

  const cfg = await call(request, fam.admin, "GET", "/api/admin/finance/fees");
  const series = (cfg.body.series as { seriesId: string; versions: { n: number; state: string; percentBp: number; fictitious: boolean }[] }[]).find((s) => s.seriesId === `${TERMINAL}__card_credit`)!;
  expect(series.versions.map((v) => [v.n, v.state, v.percentBp, v.fictitious])).toEqual([[1, "in_effect", 300, true], [2, "future", 500, true]]);
  expect(cfg.body.production).toBe(false);

  const listed = await call(request, secretaria, "GET", "/api/finance/terminals");
  expect(listed.status).toBe(200);
  expect((listed.body.terminals as { sourceId: string; name: string }[]).find((t) => t.sourceId === TERMINAL)?.name).toBe(`[FICTÍCIA] ${source.name}`);
  expect(JSON.stringify(listed.body)).not.toMatch(/percent|settlementDays|feeEstimate/i);
  expect((await call(request, fam.guardian, "GET", "/api/finance/terminals")).status).toBe(403);
});

test("recebimento no cartão (simulado): crédito integral, estimativa congelada pela regra, nada vaza para a secretaria", async ({ request }) => {
  const r = await topup(request, secretaria, { amountCents: 5000, method: "card_credit", reference: `HML-F20-${tag}-NSU1`, sourceId: TERMINAL });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body).toMatchObject({ creditedCents: 5000, fee: { status: "pending", cents: null }, netCents: null, settlement: { status: "pending", expectedOn: addDays(TODAY, 30), expectedSource: "rule", expectedBasis: "calendar_days", expectedDays: 30, expectedRuleVersion: 1 } });
  expect(JSON.stringify(r.body)).not.toMatch(/feeEstimate|percentBp|ruleVersion|seriesId/);
  cardTopupId = String(r.body.topupId);
  ref = `topup:${cardTopupId}`;
  expect(await wallet(request)).toMatchObject({ balanceCents: 5000, version: 1 });
  await reconciled(request, 5000);

  const detail = await call(request, fam.admin, "GET", `/api/admin/finance/receipts?ref=${encodeURIComponent(ref)}`);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  expect(detail.body.receipt).toMatchObject({ ref, grossCents: 5000, sourceId: TERMINAL, effective: { basis: "estimated", cents: 150 }, estimate: { ruleVersion: 1, percentBp: 300, fictitious: true, cents: 150 } });
  expect((await call(request, secretaria, "GET", `/api/admin/finance/receipts?ref=${encodeURIComponent(ref)}`)).status).toBe(403);
  const pending = await call(request, fam.admin, "GET", "/api/admin/finance/receipts");
  expect((pending.body.items as { ref: string }[]).some((i) => i.ref === ref)).toBe(true);

  // maquininha inexistente e Pix com maquininha: recusados sem gravar
  const bad = await topup(request, secretaria, { amountCents: 100, method: "card_credit", reference: `HML-F20-${tag}-NSU2`, sourceId: "term_naoexiste" });
  expect([bad.status, bad.body.error]).toEqual([409, "invalid_source"]);
  expect((await wallet(request)).balanceCents).toBe(5000);
});

test("conferência da taxa real e da liquidação: vira a taxa efetiva, a estimada fica só para comparação; carteira e livro intactos; replay e versão antiga", async ({ request }) => {
  const body = { key: newKey("hml-f20"), ref, expectedVersion: 0, actualFeeCents: 148, settledOn: TODAY };
  expect((await call(request, secretaria, "POST", "/api/admin/finance/reconcile", body)).status).toBe(403);
  const done = await call(request, fam.admin, "POST", "/api/admin/finance/reconcile", body);
  expect(done, JSON.stringify(done.body)).toMatchObject({ status: 200, body: { financeVersion: 1, fee: { status: "confirmed", cents: 148 }, settlement: { status: "settled", settledOn: TODAY }, effective: { basis: "confirmed", cents: 148, estimatedCents: 150, differenceCents: -2 } } });
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/reconcile", body)).body).toMatchObject({ replayed: true, financeVersion: 1 });
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/reconcile", { ...body, key: newKey("hml-f20"), actualFeeCents: 140 })).body.error).toBe("stale_receipt");
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/reconcile", { ...body, key: newKey("hml-f20"), expectedVersion: 1, actualFeeCents: 140 })).body.error).toBe("correction_requires_reason");
  const corrected = await call(request, fam.admin, "POST", "/api/admin/finance/reconcile", { key: newKey("hml-f20"), ref, expectedVersion: 1, actualFeeCents: 149, reason: `${MARK}: correção do valor lido` });
  expect(corrected.body).toMatchObject({ financeVersion: 2, fee: { cents: 149 } });
  expect(await wallet(request)).toMatchObject({ balanceCents: 5000, version: 1 });
  await reconciled(request, 5000);
  expect(await audit(`${fam.admin.uid}__finance.reconcile__${body.key}`)).toMatchObject({ action: "finance.reconcile", after: { feeStatus: "confirmed", feeCents: 148, correction: false } });
  const events = await harnessAdmin().db.collection(`topups/${cardTopupId}/reconciliations`).orderBy("seq").get();
  expect(events.docs.map((d) => [d.get("seq"), d.get("correction"), d.get("after.fee.cents")])).toEqual([[1, false, 148], [2, true, 149]]);
});

test("caixa: abrir com saldo confirmado, receber, fechar SEM diferença; só o próprio caixa; dinheiro, Pix e cartão separados", async ({ request }) => {
  expect((await open(request, secretaria, { openingConfirmed: false })).status).toBe(400);
  expect((await open(request, fam.guardian)).status).toBe(403);
  const o = await open(request, secretaria, { openingCents: 10_000 });
  expect(o, JSON.stringify(o.body)).toMatchObject({ status: 200, body: { sessionId: sid(TODAY, secretaria), status: "open", openingCents: 10_000 } });
  expect((await open(request, secretaria)).body.error).toBe("session_exists");
  expect((await topup(request, secretaria, { amountCents: 2000, method: "cash" })).status).toBe(200);
  expect((await topup(request, secretaria, { amountCents: 3000, method: "pix", reference: `HML-F20-${tag}-PIX1` })).status).toBe(200);
  expect((await topup(request, secretaria, { amountCents: 1000, method: "card_debit", reference: `HML-F20-${tag}-NSU3` })).status).toBe(200);

  const mine = await call(request, secretaria, "GET", "/api/cash");
  const secPoint = (mine.body.points as { point: string; live: { receiptCount: number; expectedCashCents: number; byMethod: { method: string; netCents: number }[] } }[]).find((p) => p.point === "secretaria")!;
  // 4 recebimentos: o cartão de R$ 50,00 do teste anterior (mesma operadora) + dinheiro, Pix e débito deste; só o dinheiro entra na gaveta
  expect(secPoint.live).toMatchObject({ receiptCount: 4, expectedCashCents: 12_000 });
  expect(Object.fromEntries(secPoint.live.byMethod.map((m) => [m.method, m.netCents]))).toMatchObject({ cash: 2000, pix: 3000, card_debit: 1000, card_credit: 5000 });

  // outro operador não fecha este caixa; a administração também não
  expect((await close(request, secretaria2, sid(TODAY, secretaria))).status).toBe(403);
  expect((await close(request, fam.admin, sid(TODAY, secretaria))).status).toBe(403);
  const body = { key: newKey("hml-f20"), sessionId: sid(TODAY, secretaria), countedCashCents: 12_000, declared: { pixCents: 3000 }, note: MARK };
  const closed = await call(request, secretaria, "POST", "/api/cash/close", body);
  expect(closed, JSON.stringify(closed.body)).toMatchObject({ status: 200, body: { closureNo: 1, hasDivergence: false, reviewStatus: "not_required", expectedCashCents: 12_000, receiptCount: 4 } });
  expect((await call(request, secretaria, "POST", "/api/cash/close", body)).body).toMatchObject({ replayed: true, closureNo: 1 });
  expect((await close(request, secretaria, sid(TODAY, secretaria))).body.error).toBe("already_closed");
  expect(await audit(`${secretaria.uid}__cash.close__${body.key}`)).toMatchObject({ action: "cash.close", after: { closureNo: 1, hasDivergence: false } });
  expect((await call(request, secretaria2, "GET", `/api/cash/${sid(TODAY, secretaria)}`)).status).toBe(403);
  expect((await call(request, fam.admin, "GET", `/api/cash/${sid(TODAY, secretaria)}`)).status).toBe(200);
});

test("divergência de 1 centavo: pendente de revisão; aprovar NÃO cria ajuste; movimento posterior identificado; reabrir com motivo preserva a versão 1", async ({ request }) => {
  const id = sid(TODAY, secretaria2);
  expect((await open(request, secretaria2, { openingCents: 5000 })).status).toBe(200);
  const t = await topup(request, secretaria2, { amountCents: 1000, method: "cash" });
  expect(t.status).toBe(200);
  const walletBefore = await wallet(request);
  const c = await close(request, secretaria2, id, { countedCashCents: 5999 });
  expect(c.body).toMatchObject({ closureNo: 1, cashDifferenceCents: -1, hasDivergence: true, reviewStatus: "pending" });

  const list = await call(request, fam.admin, "GET", `/api/admin/finance/cash?from=${addDays(TODAY, -2)}&to=${TODAY}`);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  expect((list.body.alerts as { kind: string; operatorUid: string }[]).some((a) => a.kind === "divergence_pending" && a.operatorUid === secretaria2.uid)).toBe(true);
  for (const user of [secretaria, cantina, fam.guardian]) expect((await call(request, user, "GET", "/api/admin/finance/cash")).status, user.email).toBe(403);

  const review = { key: newKey("hml-f20"), sessionId: id, closureNo: 1, decision: "approved", note: `${MARK}: diferença de 1 centavo aceita` };
  expect((await call(request, secretaria2, "POST", "/api/admin/finance/cash/review", review)).status).toBe(403);
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/cash/review", review)).body).toMatchObject({ decision: "approved", adjustment: "none" });
  expect(await wallet(request)).toEqual(walletBefore); // aprovar a diferença não mexeu em nenhuma carteira
  await reconciled(request, walletBefore.balanceCents);

  // movimento posterior ao fechamento
  expect((await topup(request, secretaria2, { amountCents: 500, method: "cash" })).status).toBe(200);
  const view = await call(request, secretaria2, "GET", `/api/cash/${id}`);
  expect(view.body).toMatchObject({ status: "closed", closureNo: 1, afterClose: { count: 1 } });

  const reopen = { key: newKey("hml-f20"), sessionId: id, reason: `${MARK}: incluir o recebimento posterior` };
  expect((await call(request, secretaria2, "POST", "/api/admin/finance/cash/reopen", reopen)).status).toBe(403);
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/cash/reopen", { ...reopen, reason: "curto" })).status).toBe(400);
  expect((await call(request, fam.admin, "POST", "/api/admin/finance/cash/reopen", reopen)).body).toMatchObject({ status: "reopened", reopenCount: 1 });
  const again = await close(request, secretaria2, id, { countedCashCents: 6500 });
  expect(again.body).toMatchObject({ closureNo: 2, expectedCashCents: 6500, hasDivergence: false });
  const closures = await harnessAdmin().db.collection(`cashSessions/${id}/closures`).orderBy("no").get();
  expect(closures.docs.map((d) => [d.get("no"), d.get("expectedCashCents")])).toEqual([[1, 6000], [2, 6500]]);
  closedSession = id;
});

test("alerta de dia sem fechamento NÃO bloqueia o dia seguinte: caixa de ontem aberto e sem fechar aparece para a administração e para o operador", async ({ request }) => {
  const yesterday = addDays(TODAY, -1);
  const old = await open(request, secretaria3, { date: yesterday, openingCents: 100 });
  expect(old.status, JSON.stringify(old.body)).toBe(200);
  expect((await open(request, secretaria3, { openingCents: 200 })).status).toBe(200); // hoje abre normalmente
  expect((await open(request, secretaria3, { date: addDays(TODAY, -8) })).body.error).toBe("invalid_date");
  const adminView = await call(request, fam.admin, "GET", `/api/admin/finance/cash?from=${addDays(TODAY, -2)}&to=${TODAY}`);
  expect((adminView.body.alerts as { kind: string; operatorUid: string; date: string }[]).some((a) => a.kind === "open_not_closed" && a.operatorUid === secretaria3.uid && a.date === yesterday)).toBe(true);
  const mine = await call(request, secretaria3, "GET", "/api/cash");
  expect((mine.body.alerts as { kind: string; operatorUid: string }[]).filter((a) => a.kind === "open_not_closed")).toHaveLength(1);
  expect((await close(request, secretaria3, sid(yesterday, secretaria3), { countedCashCents: 100 })).status).toBe(200);
});

test("balcão: venda direta no cartão com a maquininha fictícia entra no caixa do balcão; a compra com saldo não é dinheiro recebido", async ({ request }) => {
  // O PDV exige cardápio/estoque do dia: aqui só a abertura/fechamento do balcão sem recebimentos é verificada na nuvem; as vendas diretas
  // com estoque ficam provadas no emulador (cash-api.test.ts) e no smoke do PDV (pos-smoke.spec.ts).
  const o = await call(request, cantina, "POST", "/api/cash/open", { key: newKey("hml-f20"), point: "counter", openingCents: 700, openingConfirmed: true });
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  expect((await call(request, cantina, "POST", "/api/cash/open", { key: newKey("hml-f20"), point: "secretaria", openingCents: 1, openingConfirmed: true })).status).toBe(403);
  const c = await call(request, cantina, "POST", "/api/cash/close", { key: newKey("hml-f20"), sessionId: String(o.body.sessionId), countedCashCents: 700 });
  expect(c.body).toMatchObject({ expectedCashCents: 700, hasDivergence: false, receiptCount: 0 });
});

test("relatório e exportação mensal na nuvem: recebimento estimado/conferido aparece uma vez; detalhe e resumo conferem; regra fictícia identificada", async ({ request }) => {
  const report = await call(request, fam.admin, "GET", `/api/admin/finance/report?from=${TODAY}&to=${TODAY}`);
  expect(report.status, JSON.stringify(report.body)).toBe(200);
  expect(report.body).toMatchObject({ dateBasis: "receivedOn", production: false, truncated: false });
  const totals = report.body.totals as Record<string, number>;
  expect(totals.grossCents).toBeGreaterThanOrEqual(5000 + 2000 + 3000 + 1000 + 1000 + 500);
  expect(totals.feeConfirmedCents).toBeGreaterThanOrEqual(149);
  expect(totals.feeConfirmedCents! + totals.feeInformedCents! + totals.feeEstimatedCents!).toBe(totals.feeEffectiveCents);
  expect(totals.fictitiousCount).toBeGreaterThanOrEqual(1);
  for (const user of [secretaria, cantina, fam.guardian]) expect((await call(request, user, "GET", `/api/admin/finance/report?from=${TODAY}&to=${TODAY}`)).status).toBe(403);

  const month = TODAY.slice(0, 7);
  const csv = async (view: string) => {
    const r = await request.get(`/api/admin/finance/export?month=${month}&view=${view}`, { headers: bearer(fam.admin.idToken) });
    expect(r.status(), await r.text()).toBe(200);
    expect(r.headers()["content-type"]).toContain("text/csv");
    return (await r.text()).replace(/^﻿/, "").trim().split("\r\n").map((l) => l.split(";"));
  };
  const detail = await csv("detail");
  const summary = await csv("summary");
  const col = (rows: string[][], name: string) => rows[0]!.indexOf(name);
  const mine = detail.find((r) => r[col(detail, "Referência interna")] === ref)!;
  expect(mine).toBeTruthy();
  expect(mine[col(detail, "Base da taxa")]).toBe("conferida");
  expect(mine[col(detail, "Taxa efetiva (R$)")]).toBe("1,49");
  expect(mine[col(detail, "Taxa estimada (R$)")]).toBe("1,50");
  expect(mine[col(detail, "Regra fictícia")]).toBe("Sim");
  const rows = detail.slice(1);
  const pt = (v: string | undefined) => (v ? Math.round(Number(v.replace(",", ".")) * 100) : 0);
  const total = summary.at(-1)!;
  expect(total[0]).toBe("TOTAL");
  expect(Number(total[col(summary, "Recebimentos")])).toBe(rows.length);
  expect(pt(total[col(summary, "Bruto (R$)")])).toBe(rows.reduce((n, r) => n + pt(r[col(detail, "Bruto (R$)")]), 0));
  expect(pt(total[col(summary, "Taxa efetiva (R$)")])).toBe(rows.reduce((n, r) => n + pt(r[col(detail, "Taxa efetiva (R$)")]), 0));
  expect((await request.get(`/api/admin/finance/export?month=${month}`, { headers: bearer(secretaria.idToken) })).status()).toBe(403);
});

test("Security Rules publicadas: caixa, regras e conferências são fechados ao cliente (nenhum papel lê ou escreve direto)", async () => {
  for (const user of [fam.admin, secretaria, cantina, fam.guardian]) {
    expect((await fsRequest(user.idToken, "GET", `cashSessions/${closedSession}`)).status, `cashSessions ${user.email}`).toBe(403);
    expect((await fsRequest(user.idToken, "GET", `feeSeries/${TERMINAL}__card_credit`)).status, `feeSeries ${user.email}`).toBe(403);
    expect((await fsRequest(user.idToken, "GET", `paymentSources/${TERMINAL}`)).status, `paymentSources ${user.email}`).toBe(403);
    expect((await fsRequest(user.idToken, "GET", `topups/${cardTopupId}/reconciliations/x`)).status).toBe(403);
  }
  expect((await fsRequest(secretaria.idToken, "PATCH", `cashSessions/${closedSession}`, { status: { stringValue: "open" } })).status).toBe(403);
  expect((await fsRequest(null, "GET", `cashSessions/${closedSession}`)).status).toBe(403);
});
