// Smoke DIRIGIDO do checkout antecipado (F11) na homologação (emulador ou aplicação publicada), SEM crédito artificial:
// a carteira do aluno fictício fica em R$ 0,00 (não há recarga real até F17–F19 e este projeto não recebe fixture de saldo).
// Prova o que é possível sem saldo: validações e recusas do servidor na ordem do comando (autorização, turno, calendário,
// cardápio, revisão de preço, política e saldo), "nada foi cobrado/reservado/gravado" depois de cada recusa, Rules publicadas
// de `orders` e a tela. NÃO prova compra com saldo, concorrência, cota nem último item no Firestore real: isso só existe
// no emulador (tests/integration/checkout-api.test.ts) e fica registrado como pendência.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { DEMO_SHIFTS } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { createTempProduct, fixtureIds, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
let famA: Family;
let famB: Family;
let cantina: TestUser;
let morning = "";
let onMenu = "";
let offMenu = "";
const PRICE = 350;
type Week = { today: string; days: { date: string; allowed: boolean; reason: string | null }[] };
let week: Week;

const checkout = (request: APIRequestContext, user: TestUser | null, body: Record<string, unknown>) =>
  request.post("/api/orders/checkout", { headers: user ? bearer(user.idToken) : {}, data: body });
const cart = (date: string, over: Record<string, unknown> = {}, productId = onMenu, price = PRICE) => ({
  key: newKey("co"),
  studentId: famA.studentId,
  expectedShiftId: morning,
  days: [{ date, lines: [{ productId, quantity: 1, expectedPriceCents: price }] }],
  ...over,
});
const wallet = async (request: APIRequestContext, token: string, id: string) => (await (await request.get(`/api/wallets?studentId=${id}`, { headers: bearer(token) })).json()) as { balanceCents: number; version: number; entries: unknown[] };
const addDays = (date: string, n: number) => new Date(new Date(`${date}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

test.beforeAll(async ({ request }) => {
  famA = await createFamily(request, `hml-co-a-${tag}`);
  famB = await createFamily(request, `hml-co-b-${tag}`);
  cantina = await createTestUser(`hml-co-cant-${tag}`, "cantina");
  const ids = await fixtureIds();
  morning = ids.shift(DEMO_SHIFTS[0].name);
  const admin = famA.admin;
  onMenu = await createTempProduct(request, admin.idToken, `Checkout HML ${tag}`, { priceCents: PRICE, shiftIds: [morning] });
  offMenu = await createTempProduct(request, admin.idToken, `Fora do cardápio ${tag}`, { priceCents: PRICE, shiftIds: [morning] });
  const menu = await request.post("/api/menu", { headers: bearer(admin.idToken), data: { key: randomUUID(), action: "setDefault", productId: onMenu, shiftIds: [morning], expectedVersion: 0 } });
  expect(menu.status(), await menu.text()).toBe(200);
  const stock = await request.post("/api/inventory/receipts", { headers: bearer(admin.idToken), data: { key: randomUUID(), action: "create", productId: onMenu, kind: "purchase", quantity: 20, unitCost: "1,00" } });
  expect(stock.status(), await stock.text()).toBe(200);
  week = (await (await request.get(`/api/menu?studentId=${famA.studentId}`, { headers: bearer(famA.guardian.idToken) })).json()) as Week;
});

test.afterAll(async ({ request }) => {
  for (const id of [onMenu, offMenu]) if (id) await retireTempProduct(request, famA.admin.idToken, id).catch(() => undefined);
});

const openDate = () => week.days.find((d) => d.allowed && d.date !== week.today)!.date;

test("sem saldo: o servidor recusa (409 insufficient_balance) e NADA é cobrado, reservado ou gravado (A17)", async ({ request }) => {
  const date = openDate();
  const refused = await checkout(request, famA.guardian, cart(date));
  const body = (await refused.json()) as { error: string; details: Record<string, number> };
  expect([refused.status(), body.error, body.details]).toEqual([409, "insufficient_balance", { balanceCents: 0, requiredCents: PRICE }]);
  expect(await wallet(request, famA.guardian.idToken, famA.studentId)).toMatchObject({ balanceCents: 0, version: 0, entries: [] });
  const stock = await request.get(`/api/inventory/product?productId=${onMenu}`, { headers: bearer(famA.admin.idToken) });
  expect(await stock.json()).toMatchObject({ reservedUnits: 0 });
  const rec = await request.get(`/api/wallets/reconcile?studentId=${famA.studentId}`, { headers: bearer(famA.admin.idToken) });
  expect(await rec.json()).toMatchObject({ ok: true, entryCount: 0, problems: [] });
});

test("revisão de preço: preço diferente do visto → 409 price_changed com o carrinho do servidor, sem cobrança; campos de valor no corpo são recusados (A16)", async ({ request }) => {
  const date = openDate();
  const changed = await checkout(request, famA.guardian, cart(date, {}, onMenu, 1));
  const body = (await changed.json()) as { error: string; details: { changes: unknown[]; cart: { totalCents: number } } };
  expect([changed.status(), body.error, body.details.cart.totalCents]).toEqual([409, "price_changed", PRICE]);
  expect(body.details.changes).toEqual([expect.objectContaining({ date, productId: onMenu, expectedPriceCents: 1, currentPriceCents: PRICE })]);
  for (const extra of [{ totalCents: 1 }, { balanceCents: 999 }, { priceCents: 1 }]) expect((await checkout(request, famA.guardian, cart(date, extra))).status()).toBe(400);
  expect((await wallet(request, famA.guardian.idToken, famA.studentId)).version).toBe(0);
});

test("calendário, janela e cardápio no servidor: data passada/além de hoje+7/dia sem funcionamento/produto fora do cardápio recusados", async ({ request }) => {
  const code = async (body: Record<string, unknown>) => ((await (await checkout(request, famA.guardian, body)).json()) as { error: string }).error;
  expect(await code(cart(addDays(week.today, -1)))).toBe("past_date");
  expect(await code(cart(addDays(week.today, 8)))).toBe("beyond_window");
  const closed = week.days.find((d) => !d.allowed && d.reason === "non_operating_day");
  if (closed) expect(await code(cart(closed.date))).toBe("non_operating_day");
  expect(await code(cart(openDate(), {}, offMenu))).toBe("item_unavailable");
  expect(await code(cart(openDate(), { expectedShiftId: "shf_outro" }))).toBe("shift_changed");
  expect((await wallet(request, famA.guardian.idToken, famA.studentId)).version).toBe(0);
});

test("política do aluno (F09) no checkout: limite excedido → 409 confirmation_required com o efeito; com confirmação chega ao saldo e continua sem cobrança", async ({ request }) => {
  const limit = await request.post("/api/policies", { headers: bearer(famA.guardian.idToken), data: { key: newKey("pol"), studentId: famA.studentId, allowSitePurchase: true, dailyLimitCents: 100 } });
  expect(limit.status(), await limit.text()).toBe(200);
  const date = openDate();
  const first = await checkout(request, famA.guardian, cart(date));
  const body = (await first.json()) as { error: string; details: { days: { key: string; limitCents: number; requestedCents: number; exceeds: boolean }[] } };
  expect([first.status(), body.error]).toEqual([409, "confirmation_required"]);
  expect(body.details.days).toEqual([expect.objectContaining({ key: date, limitCents: 100, requestedCents: PRICE, exceeds: true })]);
  const confirmed = await checkout(request, famA.guardian, cart(date, { confirmed: true }));
  expect([confirmed.status(), ((await confirmed.json()) as { error: string }).error]).toEqual([409, "insufficient_balance"]);
  expect((await wallet(request, famA.guardian.idToken, famA.studentId)).version).toBe(0);
  const lifted = await request.post("/api/policies", { headers: bearer(famA.guardian.idToken), data: { key: newKey("pol"), studentId: famA.studentId, dailyLimitCents: null } });
  expect(lifted.status(), await lifted.text()).toBe(200); // sem teto parental: a tela abaixo chega direto ao saldo
});

test("autorização: sem login 401; outra família, cantina e administração 403; corpo inválido 400", async ({ request }) => {
  const date = openDate();
  expect((await checkout(request, null, cart(date))).status()).toBe(401);
  for (const user of [famB.guardian, cantina, famA.admin]) expect((await checkout(request, user, cart(date))).status()).toBe(403);
  expect((await checkout(request, famA.guardian, { key: "curta" })).status()).toBe(400);
  expect((await checkout(request, famA.guardian, cart(date, { days: [] }))).status()).toBe(400);
  const many = { days: Array.from({ length: 9 }, (_, i) => ({ date: addDays(week.today, i), lines: [{ productId: onMenu, quantity: 1, expectedPriceCents: PRICE }] })) };
  expect((await checkout(request, famA.guardian, cart(date, many))).status()).toBe(400); // máximo de 8 datas
});

test("Rules publicadas: pedidos são só do servidor (nem a família dona lê ou escreve pelo cliente) e o cliente não grava débito (A33)", async () => {
  for (const [label, token] of [["responsável vinculado", famA.guardian.idToken], ["outra família", famB.guardian.idToken], ["administração", famA.admin.idToken], ["cantina", cantina.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", "orders/ord_inexistente")).status, `${label}: documento`).toBe(403);
    expect((await fsRequest(token, "GET", "orders")).status, `${label}: coleção`).toBe(403);
  }
  const int = (value: number) => ({ integerValue: String(value) });
  expect((await fsRequest(famA.guardian.idToken, "PATCH", "orders/ord_x", { totalCents: int(1) })).status).toBe(403);
  expect((await fsRequest(famA.guardian.idToken, "PATCH", `wallets/${famA.studentId}/entries/x`, { amountCents: int(-100) })).status).toBe(403);
});

test("tela publicada: carrinho → revisão → confirmação recusada por saldo insuficiente, sem parecer sucesso nem falha de leitura", async ({ page }) => {
  await page.goto("/portal/cardapio");
  await page.getByLabel("Email").fill(famA.guardian.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("menu-student")).toContainText(famA.studentName, { timeout: 30000 });
  const date = openDate();
  await page.locator("label.day-option").filter({ hasText: date.split("-").reverse().slice(0, 2).join("/") }).click();
  await page.getByRole("button", { name: `Aumentar Checkout HML ${tag}` }).click();
  await expect(page.getByTestId("summary-total")).toContainText(/R\$\s*3,50/);
  await page.getByTestId("open-review").click();
  await expect(page.getByRole("heading", { name: "Revisão da compra" })).toBeFocused();
  await expect(page.getByTestId("checkout-balance")).toContainText(/R\$\s*0,00/);
  await page.getByTestId("checkout-confirm").click();
  await expect(page.getByTestId("checkout-status")).toHaveAttribute("data-phase", "refused", { timeout: 30000 });
  await expect(page.getByTestId("checkout-status")).toContainText("Saldo insuficiente");
  await expect(page.getByTestId("checkout-status")).toContainText("Nada foi cobrado");
});
