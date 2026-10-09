// Verificação DIRIGIDA da F21 na homologação (emulador no ensaio; Firebase `cantina-escolar-hml` no servidor local ou publicado), com
// dados FICTÍCIOS próprios e RECEBIMENTO SIMULADO pelo fluxo normal (nenhum dinheiro real, nenhum provedor, nenhuma taxa real):
// A20 com vendas reais (100×R$1,00 + 100×R$1,10; 10 a R$2,00 → receita R$20,00, CMV R$10,50, lucro bruto R$9,50), venda no balcão com
// saldo (recarga simulada ≠ receita), pedido futuro pago a realizar, cancelamento com reembolso, perda e compra de estoque fora do CMV,
// visão da cantina sem custo, exportação CSV/XLSX, autorização e Security Rules publicadas (movimentos e cancelamentos fechados ao
// cliente, inclusive por consulta de grupo, o que também exercita os `fieldOverrides` publicados). O Admin SDK não escreve nada.
// NÃO prova: taxas/prazos REAIS, pagamento real, produção, volume (teto de leitura), concorrência em escala nem latência.
// Fica na homologação (auditável e marcado como teste): o histórico de estoque, os pedidos e a recarga simulada; os produtos fictícios
// são ARQUIVADOS no fim e só as contas efêmeras saem no teardown.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DEMO_SHIFTS } from "../../scripts/lib/demo-seed.ts";
import { firestoreRest } from "../../scripts/staging/admin.ts";
import { PUBLISHED_STATE_FILE, loadTarget } from "../../scripts/staging/target.ts";
import { localDateOf } from "../../src/lib/dates/school-time";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { createTempProduct, fixtureIds, prepareCatalog, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest } from "./helpers";

test.describe.configure({ mode: "serial" });

const target = loadTarget();

const tag = Math.random().toString(36).slice(2, 7);
const TODAY = localDateOf(new Date());
const MARK = "TESTE HML F21 (recebimento simulado, sem dinheiro)";
let fam: Family;
let cantina: TestUser;
let secretaria: TestUser;
let morning = "";
let pa = ""; // A20
let pb = ""; // balcão, pedido futuro e cancelamento
let openedDay = false;
let openDate = "";
let orderId = "";

type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
/** Só as CHAVES do JSON (nomes de produto do cadastro de homologação podem conter qualquer palavra). */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : []);
const COST_KEYS = /cost|cogs|profit|margin|fee|result|purchase|ledger|wallet|estimate|check/i;
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: user ? bearer(user.idToken) : {}, data });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
const post = (request: APIRequestContext, user: TestUser | null, url: string, data: Record<string, unknown>, key = randomUUID()) => call(request, user, "POST", url, { key, ...data });
const report = (request: APIRequestContext, user: TestUser | null, params: string) => call(request, user, "GET", `/api/reports/sales?from=${TODAY}&to=${TODAY}&${params}`);
type Totals = { units: number; revenueCents: number; cogsCents: number; costMicros: number; grossProfitCents: number; marginBp: number | null; complete: boolean };
const realized = (r: { status?: number; body: Json }) => {
  expect(r.status, JSON.stringify(r.body)).toBe(200); // falha com o corpo do erro, não com TypeError
  return r.body.realized as { totals: Totals; byChannel: { key: string; units: number; revenueCents: number }[] };
};

test.beforeAll(async ({ request }) => {
  await prepareCatalog();
  fam = await createFamily(request, `hml-rel-${tag}`);
  cantina = await createTestUser(`hml-rel-cant-${tag}`, "cantina");
  secretaria = await createTestUser(`hml-rel-sec-${tag}`, "secretaria");
  morning = (await fixtureIds()).shift(DEMO_SHIFTS[0].name);
  // O balcão só vende em dia de funcionamento: se hoje não for (ex.: fim de semana), abre uma exceção só durante a verificação.
  const window = await call(request, fam.guardian, "GET", `/api/school/calendar?shiftId=${morning}`);
  const today = ((window.body.days as { date: string; operating: boolean }[] | undefined) ?? []).find((d) => d.date === TODAY);
  if (today && !today.operating) {
    const set = await post(request, fam.admin, "/api/school/calendar", { action: "set", date: TODAY, kind: "extra", reason: "Verificação F21 (fictícia)" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    openedDay = true;
  }
  pa = await createTempProduct(request, fam.admin.idToken, `Relatório HML A ${tag}`, { priceCents: 200, shiftIds: [morning] });
  pb = await createTempProduct(request, fam.admin.idToken, `Relatório HML B ${tag}`, { priceCents: 300, shiftIds: [morning] });
  for (const id of [pa, pb]) {
    const menu = await post(request, fam.admin, "/api/menu", { action: "setDefault", productId: id, shiftIds: [morning], expectedVersion: 0 });
    expect(menu.status, JSON.stringify(menu.body)).toBe(200);
  }
  const week = (await call(request, fam.guardian, "GET", `/api/menu?studentId=${fam.studentId}`)).body as { today: string; days: { date: string; allowed: boolean }[] };
  openDate = week.days.filter((d) => d.allowed && d.date !== week.today)[0]?.date ?? "";
  expect(openDate, "uma data futura aberta para compra").not.toBe("");
});

test.afterAll(async ({ request }) => {
  for (const id of [pa, pb]) if (id) await retireTempProduct(request, fam.admin.idToken, id).catch(() => undefined);
  if (openedDay) await post(request, fam.admin, "/api/school/calendar", { action: "clear", date: TODAY }).catch(() => undefined);
});

test("autorização: administração completa; cantina só quantidades e valores; secretaria, família e anônimo negados", async ({ request }) => {
  expect((await report(request, null, "")).status).toBe(401);
  expect((await report(request, secretaria, "")).status).toBe(403);
  expect((await report(request, fam.guardian, "")).status).toBe(403);
  const a = await report(request, fam.admin, "");
  const c = await report(request, cantina, "");
  expect([a.status, a.body.scope, a.body.production]).toEqual([200, "full", false]);
  expect([c.status, c.body.scope]).toEqual([200, "operational"]);
  expect(keysOf(c.body).filter((k) => COST_KEYS.test(k))).toEqual([]);
  expect((await report(request, fam.admin, "from=2026-01-01&to=2026-12-31")).status).toBe(409); // período maior que o limite
});

test("A20 com vendas reais: 100×R$1,00 + 100×R$1,10; venda direta de 10 a R$2,00 → receita 20,00, CMV 10,50, lucro bruto 9,50", async ({ request }) => {
  for (const cost of ["1,00", "1,10"]) {
    const r = await post(request, fam.admin, "/api/inventory/receipts", { action: "create", productId: pa, kind: "purchase", quantity: 100, unitCost: cost });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const body = { shiftId: morning, lines: [{ productId: pa, quantity: 10, expectedPriceCents: 200 }], paymentMethod: "cash", receivedConfirmed: true };
  const key = randomUUID();
  const sale = await post(request, cantina, "/api/pos/direct-sales", body, key);
  expect(sale.status, JSON.stringify(sale.body)).toBe(200);
  const r = await report(request, fam.admin, `productId=${pa}`);
  expect(realized(r).totals).toMatchObject({ units: 10, revenueCents: 2000, cogsCents: 1050, costMicros: 1_050_000_000, grossProfitCents: 950, marginBp: 4750, complete: true });
  expect(realized(r).byChannel).toEqual([expect.objectContaining({ key: "direct", units: 10, revenueCents: 2000 })]);
  // repetir o mesmo comando não vende nem conta de novo
  expect((await post(request, cantina, "/api/pos/direct-sales", body, key)).body.replayed).toBe(true);
  expect(realized(await report(request, fam.admin, `productId=${pa}`)).totals).toMatchObject({ units: 10, revenueCents: 2000 });
  // mudar o preço atual não reescreve a baixa histórica
  const reprice = await post(request, fam.admin, "/api/catalog/products", { action: "setPrice", id: pa, priceCents: 350, expectedPriceVersion: 1, reason: `${MARK}: preço atual muda` });
  expect(reprice.status, JSON.stringify(reprice.body)).toBe(200);
  expect(realized(await report(request, fam.admin, `productId=${pa}`)).totals).toMatchObject({ units: 10, revenueCents: 2000, cogsCents: 1050 });
  // a cantina vê as mesmas quantidades e valores, sem custo
  const c = await report(request, cantina, `productId=${pa}`);
  expect(realized(c).totals).toMatchObject({ units: 10, revenueCents: 2000 });
  expect(keysOf(c.body).filter((k) => COST_KEYS.test(k))).toEqual([]);
});

test("recarga simulada não é receita; venda no balcão com saldo, pedido futuro a realizar e cancelamento com reembolso aparecem separados", async ({ request }) => {
  const entry = await post(request, fam.admin, "/api/inventory/receipts", { action: "create", productId: pb, kind: "purchase", quantity: 20, unitCost: "1,00" });
  expect(entry.status, JSON.stringify(entry.body)).toBe(200);
  const topup = await post(request, secretaria, "/api/topups", { studentId: fam.studentId, amountCents: 5000, method: "cash", receivedConfirmed: true, note: MARK });
  expect(topup.status, JSON.stringify(topup.body)).toBe(200);
  expect((await post(request, fam.guardian, "/api/policies", { studentId: fam.studentId, allowCounterPurchase: true, reason: "Verificação F21 (fictícia)" })).status).toBe(200);
  // balcão com saldo: 2 un. a R$ 3,00
  const counter = await post(request, cantina, "/api/pos/sales", { studentId: fam.studentId, expectedShiftId: morning, lines: [{ productId: pb, quantity: 2, expectedPriceCents: 300 }] });
  expect(counter.status, JSON.stringify(counter.body)).toBe(200);
  // pedido futuro pago: 2 un. (R$ 6,00) ainda NÃO realizados
  const order = await post(request, fam.guardian, "/api/orders/checkout", { studentId: fam.studentId, expectedShiftId: morning, days: [{ date: openDate, lines: [{ productId: pb, quantity: 2, expectedPriceCents: 300 }] }] });
  expect(order.status, JSON.stringify(order.body)).toBe(200);
  orderId = (order.body.orders as { orderId: string }[])[0]!.orderId;

  const before = await report(request, fam.admin, `productId=${pb}`);
  expect(realized(before).totals).toMatchObject({ units: 2, revenueCents: 600, cogsCents: 200, grossProfitCents: 400, complete: true }); // o futuro e a recarga NÃO são receita
  expect(realized(before).byChannel).toEqual([expect.objectContaining({ key: "counter", units: 2, revenueCents: 600 })]);
  const pending = before.body.pending as { totals: { orders: number; units: number; valueCents: number }; estimate: { costCents: number; marginCents: number } };
  expect(pending.totals).toEqual({ orders: 1, units: 2, valueCents: 600 });
  expect(pending.estimate).toMatchObject({ costCents: 200, marginCents: 400 });

  const cancel = await post(request, fam.guardian, `/api/orders/${orderId}/cancel`, { reason: `${MARK}: cancelamento` });
  expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
  const after = await report(request, fam.admin, `productId=${pb}`);
  expect((after.body.pending as { totals: { units: number } }).totals.units).toBe(0);
  expect(after.body.cancellations).toMatchObject({ totals: { events: 1, units: 2, refundCents: 600 }, byKind: [{ kind: "family", events: 1, units: 2, refundCents: 600 }] });
  expect(realized(after).totals).toMatchObject({ units: 2, revenueCents: 600 }); // cancelar não mexe na venda realizada
  const wallet = await call(request, fam.guardian, "GET", `/api/wallets?studentId=${fam.studentId}`);
  expect(wallet.body).toMatchObject({ balanceCents: 5000 - 600 });
});

test("perda e compra de estoque ficam fora do CMV e do resultado; cantina vê a perda só em unidades", async ({ request }) => {
  const loss = await post(request, cantina, "/api/inventory/losses", { productId: pb, quantity: 3, reason: "breakage", note: `${MARK}: quebra` });
  expect(loss.status, JSON.stringify(loss.body)).toBe(200);
  const r = await report(request, fam.admin, `productId=${pb}`);
  expect(r.body.losses).toMatchObject({ totals: { units: 3, costCents: 300 }, rows: [expect.objectContaining({ reasonCode: "breakage", units: 3, costMicros: 300_000_000 })] });
  expect(r.body.purchases).toMatchObject({ netCostCents: 2000, rows: [expect.objectContaining({ kind: "purchase", units: 20, costMicros: 2_000_000_000 })] });
  expect(realized(r).totals.cogsCents).toBe(200); // a perda (R$ 3,00) e a compra (R$ 20,00) não entram no CMV
  const c = await report(request, cantina, `productId=${pb}`);
  expect(c.body.losses).toMatchObject({ totalUnits: 3 });
  expect(keysOf(c.body.losses).filter((k) => COST_KEYS.test(k))).toEqual([]);
  expect(c.body.purchases).toBeUndefined();
  // sem filtro: resultado, carteiras e conferências existem; as conferências fecham
  const all = await report(request, fam.admin, "");
  expect(all.body.result).toMatchObject({ definitive: expect.any(Boolean) });
  const result = all.body.result as { resultCents: number; grossProfitCents: number; lossCostCents: number; feesCents: number };
  expect(result.resultCents).toBe(result.grossProfitCents - result.lossCostCents - result.feesCents);
  const checks = all.body.checks as { id: string; ok: boolean }[];
  expect(checks.filter((x) => /^(units|revenue|cost)_/.test(x.id)).every((x) => x.ok)).toBe(true);
  expect(all.body.ledger).not.toBeNull();
});

test("exportação: CSV com BOM e sem custo para a cantina; XLSX válido; compras e carteira só para a administração", async ({ request }) => {
  const url = `/api/reports/sales/export?from=${TODAY}&to=${TODAY}&productId=${pa}`;
  const csv = await request.fetch(`${url}&view=products`, { headers: bearer(fam.admin.idToken) });
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const bytes = await csv.body();
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(bytes.toString("utf8")).toContain(`Relatório HML A ${tag}`);
  const xlsx = await request.fetch(`${url}&view=detail&format=xlsx`, { headers: bearer(fam.admin.idToken) });
  expect(xlsx.status()).toBe(200);
  const zip = await xlsx.body();
  expect(String.fromCharCode(zip[0]!, zip[1]!)).toBe("PK");
  expect(zip.toString("latin1")).not.toContain("<f>");
  const op = await request.fetch(`${url}&view=products`, { headers: bearer(cantina.idToken) });
  expect(op.status()).toBe(200);
  expect(await op.text()).not.toMatch(/CMV|Lucro|Margem|custo/i);
  for (const view of ["purchases", "ledger"]) expect((await request.fetch(`${url}&view=${view}`, { headers: bearer(cantina.idToken) })).status(), view).toBe(403);
  expect((await request.fetch(`${url}&view=summary`, { headers: bearer(secretaria.idToken) })).status()).toBe(403);
  expect((await request.fetch(`${url}&view=summary`)).status()).toBe(401);
});

test("Security Rules publicadas: custo, receita e cancelamentos não saem pelo cliente, nem por consulta de grupo", async () => {
  const base = firestoreRest(loadTarget());
  const group = async (token: string | null, collectionId: string) => {
    const response = await fetch(`${base}:runQuery`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId, allDescendants: true }], limit: 1 } }),
    });
    return response.status;
  };
  for (const user of [fam.admin, cantina, secretaria, fam.guardian]) {
    expect(await group(user.idToken, "movements"), `movements ${user.email}`).toBe(403);
    expect(await group(user.idToken, "cancellations"), `cancellations ${user.email}`).toBe(403);
    expect((await fsRequest(user.idToken, "GET", `orders/${orderId}/cancellations/x`)).status, user.email).toBe(403);
    expect((await fsRequest(user.idToken, "GET", `stockCosts/${pa}/movements/m000000001`)).status, user.email).toBe(403);
  }
  expect(await group(null, "movements")).toBe(403);
});

async function login(page: Page, email: string, path: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("tela publicada: administração vê CMV e lucro do produto A20, ambiente fictício identificado e celular sem rolagem lateral", async ({ page }) => {
  await login(page, fam.admin.email, "/operacao/relatorios");
  await expect(page.getByRole("heading", { name: "Relatórios de vendas" })).toBeVisible({ timeout: 45000 });
  await page.locator("#rs-product").selectOption(pa);
  const totals = page.getByTestId("sales-totals");
  await expect(totals).toContainText(/R\$\s20,00/, { timeout: 30000 });
  await expect(totals).toContainText(/R\$\s10,50/);
  await expect(page.getByTestId("sales-profit")).toContainText(/R\$\s9,50/);
  await expect(totals).toContainText("47,50 %");
  await expect(page.getByTestId("sales-fictitious")).toBeVisible();
  await page.locator("#rs-product").selectOption("");
  await expect(page.getByTestId("sales-result")).toBeVisible();
  await expect(page.getByTestId("sales-checks")).toBeVisible();
  await page.screenshot({ path: "test-results/f21-publicada-relatorio-admin.png", fullPage: true });
  await page.setViewportSize({ width: 360, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("tela publicada: cantina vê quantidades e valores sem custo, CMV, lucro nem margem; secretaria é recusada", async ({ page, browser }) => {
  await login(page, cantina.email, "/operacao/relatorios");
  await expect(page.getByRole("heading", { name: "Relatórios de vendas" })).toBeVisible({ timeout: 45000 });
  await page.locator("#rs-product").selectOption(pa);
  await expect(page.getByTestId("sales-totals")).toContainText(/R\$\s20,00/, { timeout: 30000 });
  await expect(page.getByTestId("sales-totals")).toContainText("Ticket médio");
  const body = await page.locator("body").innerText();
  for (const word of ["CMV", "Lucro", "Margem", "Resultado após", "Compras de estoque", "Carteiras"]) expect(body, word).not.toContain(word);
  await page.screenshot({ path: "test-results/f21-publicada-relatorio-cantina.png", fullPage: true });
  const sec = await browser.newContext(target.published ? { storageState: PUBLISHED_STATE_FILE } : {});
  const denied = await sec.newPage();
  await login(denied, secretaria.email, "/operacao/relatorios");
  await expect(denied.getByText("Seu perfil não acessa os relatórios de vendas.")).toBeVisible({ timeout: 45000 });
  await sec.close();
});
