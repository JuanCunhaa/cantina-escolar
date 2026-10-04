import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addDays, localDateOf } from "../../src/lib/dates/school-time";
import { fundDemoWallet, readDemoDoc } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

// Checkout antecipado (F11) pela interface, no emulador (saldo SÓ por fixture). Mundo próprio e isolado: turno, produtos,
// cardápio, calendário e aluno criados aqui; nada depende do relógio de fechamento (usa datas a partir de amanhã).
// A confirmação da tela vem da RESPOSTA do servidor; o estado financeiro é conferido fora da tela (API e Firestore).

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_co_${tag}`;
const CAT = `cat_co_${tag}`;
const TODAY = localDateOf(new Date());
const d = (n: number) => addDays(TODAY, n);
const dayMonth = (date: string) => date.split("-").reverse().slice(0, 2).join("/");
let counter = 0;
let admin: TestUser;
let seedCounter = 0;
/** Documentos globais criados aqui (turno, categoria, calendário, produtos): removidos no fim para não vazar para outros specs. */
const created: string[] = [];
async function track(path: string, data: Record<string, string | number | boolean | null | string[]>) {
  created.push(path);
  await writeDemoDoc(targetFromEnv(), path, data);
}
async function removeCreated() {
  const target = targetFromEnv();
  for (const path of created.splice(0)) {
    await fetch(`http://${target.firestoreHost}/v1/projects/${target.project}/databases/(default)/documents/${path}`, { method: "DELETE", headers: { authorization: "Bearer owner" } });
  }
}

async function login(page: Page, email: string) {
  await page.goto("/portal/cardapio");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

async function product(request: APIRequestContext, name: string, priceCents: number, stock = 100) {
  const id = `prd_co_${tag}_${++counter}`;
  await track(`products/${id}`, {
    name: `${name} ${tag}`,
    nameSlug: `${name.toLowerCase().replace(/\s+/g, "-")}-${tag}-${counter}`,
    description: "Produto de teste (fictício).",
    categoryId: CAT,
    priceCents,
    priceVersion: 1,
    channels: ["advance", "counter"],
    shiftIds: [SHIFT],
    availabilityMode: "physical",
    status: "active",
    version: 1,
  });
  await track(`defaultMenuRules/${id}`, { productId: id, shiftIds: [SHIFT], version: 1 });
  const response = await request.post("/api/inventory/receipts", { headers: { authorization: `Bearer ${admin.idToken}` }, data: { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: stock, unitCost: "1,00" } });
  expect(response.status(), await response.text()).toBe(200);
  return { id, name: `${name} ${tag}`, priceCents };
}

async function family(guardians: TestUser[], cents: number, opts: { daily?: number } = {}) {
  const id = `stu_co_${tag}_${++seedCounter}`;
  const name = `Aluno Checkout ${tag}${seedCounter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: guardians.map((g) => g.uid), allowSitePurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, status: "active", userUid: null, shiftId: SHIFT, version: 1 });
  if (opts.daily) await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: true, allowCounterPurchase: false, dailyLimitCents: opts.daily, configVersion: 1 });
  if (cents > 0) await fundDemoWallet(targetFromEnv(), id, cents);
  return { id, name };
}

const wallet = async (request: APIRequestContext, token: string, id: string) =>
  (await (await request.get(`/api/wallets?studentId=${id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balanceCents: number; version: number; entries: { type: string; amountCents: number }[] };
const purchases = (w: { entries: { type: string }[] }) => w.entries.filter((e) => e.type === "advance_purchase").length;

async function openDate(page: Page, date: string) {
  await page.locator("label.day-option").filter({ hasText: dayMonth(date) }).click();
}
const plus = (page: Page, name: string) => page.getByRole("button", { name: `Aumentar ${name}` });
const reviewOpen = (page: Page) => page.getByTestId("open-review");
const status = (page: Page) => page.getByTestId("checkout-status");

test.beforeAll(async ({ request }) => {
  admin = await createTestUser(`e2e-co-adm-${tag}`, "admin");
  await track(`shifts/${SHIFT}`, { name: `Manhã Checkout ${tag}`, nameSlug: "manha", status: "active" });
  await track(`categories/${CAT}`, { name: `Categoria Checkout ${tag}`, status: "active" });
  for (let i = 0; i <= 8; i++) await track(`calendarDays/${d(i)}`, { kind: "extra" });
  await warmRoutes(request, { post: ["/api/orders/checkout", "/api/inventory/receipts", "/api/catalog/products", "/api/policies"], get: ["/portal/cardapio", "/api/menu", "/api/wallets"] });
});

test.afterAll(removeCreated);

test.describe("checkout antecipado — comportamento da interface (A10/A16/A17/A35)", () => {
  test("duas datas no carrinho → revisão → confirmação pelo servidor: um pedido e um débito por data; carrinho e saldo atualizados", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-co-g1-${tag}`, "guardian");
    const f = await family([guardian], 5000);
    const suco = await product(request, "Suco", 450);
    const pao = await product(request, "Pão", 650);
    await login(page, guardian.email);
    await expect(page.getByTestId("menu-student")).toContainText(f.name, { timeout: 30000 });

    await openDate(page, d(1));
    await plus(page, suco.name).click();
    await plus(page, suco.name).click();
    await openDate(page, d(2));
    await plus(page, pao.name).click();
    await expect(page.getByTestId("summary-total")).toContainText(/R\$\s*15,50/);
    await expect(page.getByTestId("summary-total").locator("xpath=..")).toContainText("2 datas");

    await reviewOpen(page).click();
    await expect(page.getByRole("heading", { name: "Revisão da compra" })).toBeFocused();
    await expect(page.getByTestId("checkout-student")).toContainText(f.name);
    await expect(page.getByTestId("checkout-day")).toHaveCount(2);
    await expect(page.getByTestId("checkout-total")).toContainText(/R\$\s*15,50/);
    await expect(page.getByTestId("checkout-balance")).toContainText(/R\$\s*50,00/);
    await expect(page.getByTestId("checkout-balance")).toContainText(/após a compra: R\$\s*34,50/);

    await page.getByTestId("checkout-confirm").click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed", { timeout: 30000 });
    await expect(status(page)).toContainText("Confirmada pelo servidor");
    await expect(page.getByTestId("order-confirmed")).toHaveCount(2);
    await expect(page.getByTestId("order-confirmed").first()).toContainText("pedido pago e agendado");
    await expect(page.getByTestId("order-confirmed").first()).toContainText("Cancelamento pela família até 08:00");
    await expect(page.getByTestId("summary-total")).toContainText(/R\$\s*0,00/); // carrinho limpo

    const after = await wallet(request, guardian.idToken, f.id);
    expect(after).toMatchObject({ balanceCents: 3450, version: 3 });
    expect(purchases(after)).toBe(2);
    expect((await readDemoDoc(targetFromEnv(), `stockBalances/${suco.id}`))?.onHand).toBe(100); // reserva não é saída física

    // Um novo carrinho depois da compra confirmada abre a revisão do NOVO carrinho (não fica preso na confirmação antiga).
    await openDate(page, d(3));
    await plus(page, pao.name).click();
    await reviewOpen(page).click();
    await expect(page.getByTestId("checkout-total")).toContainText(/R\$\s*6,50/);
    await expect(page.getByTestId("checkout-confirm")).toBeVisible();
    await expect(page.getByTestId("order-confirmed")).toHaveCount(0);
  });

  test("clique duplo em Confirmar cobra uma única vez", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-co-g2-${tag}`, "guardian");
    const f = await family([guardian], 3000);
    const item = await product(request, "Bolo", 700);
    await login(page, guardian.email);
    await expect(page.getByTestId("menu-student")).toContainText(f.name, { timeout: 30000 });
    await openDate(page, d(1));
    await plus(page, item.name).click();
    await reviewOpen(page).click();
    await page.getByTestId("checkout-confirm").dblclick();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed", { timeout: 30000 });
    const after = await wallet(request, guardian.idToken, f.id);
    expect(after.balanceCents).toBe(2300);
    expect(purchases(after)).toBe(1);
  });

  test("preço alterado durante a revisão: nada é cobrado, o novo total é mostrado e só a nova confirmação cobra o valor novo (A16)", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-co-g3-${tag}`, "guardian");
    const f = await family([guardian], 3000);
    const item = await product(request, "Torta", 800);
    await login(page, guardian.email);
    await expect(page.getByTestId("menu-student")).toContainText(f.name, { timeout: 30000 });
    await openDate(page, d(1));
    await plus(page, item.name).click();
    await reviewOpen(page).click();
    await expect(page.getByTestId("checkout-total")).toContainText(/R\$\s*8,00/);

    const change = await request.post("/api/catalog/products", { headers: { authorization: `Bearer ${admin.idToken}` }, data: { key: randomUUID(), action: "setPrice", id: item.id, expectedPriceVersion: 1, priceCents: 900, reason: "Reajuste de teste" } });
    expect(change.status(), await change.text()).toBe(200);

    await page.getByTestId("checkout-confirm").click();
    await expect(status(page)).toHaveAttribute("data-phase", "price_changed", { timeout: 30000 });
    await expect(status(page)).toContainText("Nada foi cobrado");
    await expect(status(page)).toContainText(/R\$\s*8,00 → R\$\s*9,00/);
    await expect(page.getByTestId("checkout-total")).toContainText(/R\$\s*9,00/);
    expect((await wallet(request, guardian.idToken, f.id)).balanceCents).toBe(3000);

    await page.getByTestId("checkout-confirm").click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed", { timeout: 30000 });
    expect((await wallet(request, guardian.idToken, f.id)).balanceCents).toBe(2100);
  });

  test("resposta perdida: a tela fica INCERTA (nunca 'falhou'), e verificar repete a MESMA operação sem cobrar de novo", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-co-g4-${tag}`, "guardian");
    const f = await family([guardian], 3000);
    const item = await product(request, "Pizza", 600);
    await login(page, guardian.email);
    await expect(page.getByTestId("menu-student")).toContainText(f.name, { timeout: 30000 });
    await openDate(page, d(1));
    await plus(page, item.name).click();
    await reviewOpen(page).click();

    // O servidor processa as 3 tentativas automáticas, mas nenhuma resposta chega à tela.
    await page.route("**/api/orders/checkout", async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });
    await page.getByTestId("checkout-confirm").click();
    await expect(status(page)).toHaveAttribute("data-phase", "uncertain", { timeout: 40000 });
    await expect(status(page)).toContainText("Ainda não sabemos");
    await expect(page.getByRole("button", { name: "Verificar resultado" })).toBeVisible();
    const middle = await wallet(request, guardian.idToken, f.id);
    expect(middle.balanceCents).toBe(2400);
    expect(purchases(middle)).toBe(1);

    await page.unroute("**/api/orders/checkout");
    await page.getByRole("button", { name: "Verificar resultado" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed", { timeout: 30000 });
    await expect(status(page)).toContainText("nada foi cobrado de novo");
    const after = await wallet(request, guardian.idToken, f.id);
    expect(after.balanceCents).toBe(2400);
    expect(purchases(after)).toBe(1);
  });

  test("saldo insuficiente é recusado pelo servidor sem cobrança; limite excedido mostra o efeito e só o responsável confirma", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-co-g5-${tag}`, "guardian");
    const poor = await family([guardian], 200);
    const rich = await family([guardian], 5000, { daily: 500 });
    const item = await product(request, "Lasanha", 900);
    await login(page, guardian.email);
    await expect(page.getByTestId("menu-student")).toContainText(poor.name, { timeout: 30000 });
    await openDate(page, d(1));
    await plus(page, item.name).click();
    await reviewOpen(page).click();
    await expect(page.getByTestId("checkout-balance")).toContainText(/R\$\s*2,00/);
    await expect(page.getByRole("status").filter({ hasText: "O saldo exibido" })).toBeVisible();
    await page.getByTestId("checkout-confirm").click();
    await expect(status(page)).toHaveAttribute("data-phase", "refused", { timeout: 30000 });
    await expect(status(page)).toContainText("Saldo insuficiente");
    await expect(status(page)).toContainText("Nada foi cobrado");
    expect((await wallet(request, guardian.idToken, poor.id)).balanceCents).toBe(200);

    // Outro aluno (limite diário R$ 5,00): a compra de R$ 9,00 pede confirmação explícita com o efeito no orçamento.
    await page.getByLabel("Aluno", { exact: true }).selectOption({ label: rich.name });
    await expect(page.getByTestId("menu-student")).toContainText(rich.name, { timeout: 30000 });
    await openDate(page, d(1));
    await plus(page, item.name).click();
    await reviewOpen(page).click();
    await page.getByTestId("checkout-confirm").click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirm_limits", { timeout: 30000 });
    await expect(status(page)).toContainText(/teto R\$\s*5,00, já comprometido R\$\s*0,00, esta compra R\$\s*9,00/);
    expect((await wallet(request, guardian.idToken, rich.id)).balanceCents).toBe(5000);
    await page.getByTestId("checkout-confirm-limits").click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed", { timeout: 30000 });
    expect((await wallet(request, guardian.idToken, rich.id)).balanceCents).toBe(4100);
  });

  test("resposta perdida depois de 'Confirmar mesmo assim': verificar reenvia a MESMA operação (mesma chave, confirmed=true) e cobra uma única vez", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-co-g7-${tag}`, "guardian");
    const f = await family([guardian], 5000, { daily: 500 });
    const item = await product(request, "Quiche", 900);
    await login(page, guardian.email);
    await expect(page.getByTestId("menu-student")).toContainText(f.name, { timeout: 30000 });
    await openDate(page, d(1));
    await plus(page, item.name).click();
    await reviewOpen(page).click();
    await page.getByTestId("checkout-confirm").click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirm_limits", { timeout: 30000 });

    const keys: string[] = [];
    await page.route("**/api/orders/checkout", async (route) => {
      keys.push((route.request().postDataJSON() as { key: string }).key);
      await route.fetch(); // o servidor processa, a resposta nunca chega
      await route.abort("connectionreset");
    });
    await page.getByTestId("checkout-confirm-limits").click();
    await expect(status(page)).toHaveAttribute("data-phase", "uncertain", { timeout: 40000 });
    expect(new Set(keys).size).toBe(1); // as tentativas automáticas usam a mesma chave
    expect((await wallet(request, guardian.idToken, f.id)).balanceCents).toBe(4100);

    await page.unroute("**/api/orders/checkout");
    const verified = page.waitForRequest("**/api/orders/checkout");
    await page.getByRole("button", { name: "Verificar resultado" }).click();
    const sent = (await verified).postDataJSON() as { key: string; confirmed: boolean };
    expect(sent).toMatchObject({ key: keys[0], confirmed: true }); // MESMA operação, não uma nova
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed", { timeout: 30000 });
    await expect(status(page)).toContainText("nada foi cobrado de novo");
    const after = await wallet(request, guardian.idToken, f.id);
    expect(after.balanceCents).toBe(4100);
    expect(purchases(after)).toBe(1);
  });

  test("celular: revisão sem rolagem horizontal e botões acessíveis por teclado", async ({ browser, request }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const page = await context.newPage();
    const guardian = await createTestUser(`e2e-co-g6-${tag}`, "guardian");
    const f = await family([guardian], 3000);
    const item = await product(request, "Esfiha", 500);
    await login(page, guardian.email);
    await expect(page.getByTestId("menu-student")).toContainText(f.name, { timeout: 30000 });
    await openDate(page, d(1));
    await plus(page, item.name).click();
    await openDate(page, d(2));
    await plus(page, item.name).click();
    await reviewOpen(page).click();
    await expect(page.getByTestId("checkout-total")).toContainText(/R\$\s*10,00/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.getByTestId("checkout-confirm").focus();
    await expect(page.getByTestId("checkout-confirm")).toBeFocused();
    expect((await page.getByTestId("checkout-confirm").boundingBox())?.height).toBeGreaterThanOrEqual(40);
    await page.keyboard.press("Enter");
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed", { timeout: 30000 });
    await context.close();
  });
});
