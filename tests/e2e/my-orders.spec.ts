import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addDays, localDateOf } from "../../src/lib/dates/school-time";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

// Meus pedidos, detalhe/recibo e extrato (F12) pela interface, no emulador. Os pedidos nascem do CHECKOUT REAL (F11) pela
// API — nunca gravados à mão —, com saldo só por fixture. Entrega/cancelamento/balcão não existem ainda (F13–F15): os
// grupos Concluídos/Cancelados são verificados só como "vazios"; o filtro por esses grupos é provado na integração.

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_mo_${tag}`;
const CAT = `cat_mo_${tag}`;
const TODAY = localDateOf(new Date());
const d = (n: number) => addDays(TODAY, n);
let admin: TestUser;
let counter = 0;
const created: string[] = [];
type Product = { id: string; name: string; priceCents: number };
const productDocs = new Map<string, Record<string, string | number | boolean | null | string[]>>();

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
async function login(page: Page, email: string, path = "/portal/pedidos") {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}
async function product(request: APIRequestContext, name: string, priceCents: number): Promise<Product> {
  const id = `prd_mo_${tag}_${++counter}`;
  const data = { name: `${name} ${tag}`, nameSlug: `${name.toLowerCase()}-${tag}-${counter}`, description: "Produto de teste (fictício).", categoryId: CAT, priceCents, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [SHIFT], availabilityMode: "physical", status: "active", version: 1 };
  productDocs.set(id, data);
  await track(`products/${id}`, data);
  await track(`defaultMenuRules/${id}`, { productId: id, shiftIds: [SHIFT], version: 1 });
  const response = await request.post("/api/inventory/receipts", { headers: { authorization: `Bearer ${admin.idToken}` }, data: { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: 500, unitCost: "1,00" } });
  expect(response.status(), await response.text()).toBe(200);
  return { id, name: data.name, priceCents };
}
async function student(guardians: TestUser[], label: string, cents: number, revoked: TestUser[] = []) {
  const id = `stu_mo_${tag}_${++counter}`;
  const name = `${label} ${tag}${counter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: guardians.map((g) => g.uid), revokedGuardianUids: revoked.map((g) => g.uid), allowSitePurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, status: "active", userUid: null, shiftId: SHIFT, version: 1 });
  await fundDemoWallet(targetFromEnv(), id, cents);
  return { id, name };
}
/** Compra REAL pelo checkout (uma data por pedido; datas distintas num único lote tudo-ou-nada). */
async function buy(request: APIRequestContext, guardian: TestUser, studentId: string, item: Product, dates: string[], quantity = 1) {
  const response = await request.post("/api/orders/checkout", {
    headers: { authorization: `Bearer ${guardian.idToken}` },
    data: { key: randomUUID(), studentId, expectedShiftId: SHIFT, days: dates.map((date) => ({ date, lines: [{ productId: item.id, quantity, expectedPriceCents: item.priceCents }] })) },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { orders: { orderId: string }[] };
}
const rows = (page: Page) => page.getByTestId("order-row");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeAll(async ({ request }) => {
  admin = await createTestUser(`e2e-mo-adm-${tag}`, "admin");
  await track(`shifts/${SHIFT}`, { name: `Manhã Pedidos ${tag}`, nameSlug: "manha", status: "active" });
  await track(`categories/${CAT}`, { name: `Categoria Pedidos ${tag}`, status: "active" });
  for (let i = 0; i <= 8; i++) await track(`calendarDays/${d(i)}`, { kind: "extra" });
  await warmRoutes(request, { post: ["/api/orders/checkout", "/api/inventory/receipts"], get: ["/portal/pedidos", "/portal/pedidos/aquecer", "/portal/carteira/extrato", "/api/orders", "/api/orders/aquecer", "/api/wallets/entries", "/api/menu", "/api/wallets"] });
});
test.afterAll(removeCreated);

test.describe("Meus pedidos — comportamento da interface (A26/A34/A37)", () => {
  test("pedidos reais do checkout: lista dos dois filhos, filtro por aluno, abas e situação 'pago aguardando entrega'", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-mo-g1-${tag}`, "guardian");
    const ana = await student([guardian], "Ana", 20000);
    const bia = await student([guardian], "Bia", 20000);
    const suco = await product(request, "Suco", 450);
    await buy(request, guardian, ana.id, suco, [d(1), d(2)]);
    await buy(request, guardian, bia.id, suco, [d(3)]);

    await login(page, guardian.email);
    await expect(rows(page)).toHaveCount(3, { timeout: 30000 });
    await expect(page.getByTestId("order-status").first()).toHaveText("Pago · aguardando entrega");
    await expect(page.getByTestId("order-status").first()).toHaveAttribute("data-payment", "paid");
    await expect(page.getByTestId("orders-tab-pending")).toHaveAttribute("aria-pressed", "true");
    await expect(rows(page).first()).toContainText("1× " + suco.name);
    await expect(rows(page).first()).toContainText(/R\$\s*4,50/);

    await page.getByLabel("Aluno").selectOption({ label: ana.name });
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId("orders-list")).not.toContainText(bia.name);
    await page.getByLabel("Aluno").selectOption({ label: "Todos os alunos" });
    await expect(rows(page)).toHaveCount(3);

    await page.getByTestId("orders-tab-completed").click();
    await expect(page.getByTestId("orders-empty")).toBeVisible();
    await page.getByTestId("orders-tab-cancelled").click();
    await expect(page.getByTestId("orders-empty")).toBeVisible();
    await page.getByTestId("orders-tab-all").click();
    await expect(rows(page)).toHaveCount(3);

    // período: só a data de amanhã+2 e depois
    await page.getByLabel("Consumo a partir de").fill(d(2));
    await expect(rows(page)).toHaveCount(2);
    await page.getByLabel("Consumo até").fill(d(2));
    await expect(rows(page)).toHaveCount(1);
    await page.getByLabel("Turno").selectOption({ label: `Manhã Pedidos ${tag}` });
    await expect(rows(page)).toHaveCount(1);
    await page.getByLabel("Canal").selectOption({ label: "Compra no balcão" });
    await expect(page.getByTestId("orders-empty")).toBeVisible();
  });

  test("snapshot: mudar nome, preço e disponibilidade do produto depois da compra não altera lista, detalhe nem recibo", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-mo-g2-${tag}`, "guardian");
    const f = await student([guardian], "Caio", 20000);
    const item = await product(request, "Quiche", 800);
    const bought = await buy(request, guardian, f.id, item, [d(1)], 2);
    const orderId = bought.orders[0]!.orderId;
    // produto renomeado, reajustado e desativado depois da compra
    await writeDemoDoc(targetFromEnv(), `products/${item.id}`, { ...productDocs.get(item.id)!, name: `Quiche RENOMEADA ${tag}`, priceCents: 1500, status: "inactive", version: 2 });

    await login(page, guardian.email);
    await expect(rows(page)).toHaveCount(1, { timeout: 30000 });
    await expect(rows(page).first()).toContainText(`2× ${item.name}`);
    await expect(rows(page).first()).toContainText(/R\$\s*16,00/);
    await expect(page.getByTestId("my-orders")).not.toContainText("RENOMEADA");

    await rows(page).first().getByRole("link", { name: "Detalhes e recibo" }).click();
    await expect(page.getByTestId("order-detail")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("order-items")).toContainText(item.name);
    await expect(page.getByTestId("order-items")).toContainText(/R\$\s*8,00/);
    await expect(page.getByTestId("order-total")).toHaveText(/R\$\s*16,00/);
    await expect(page.getByTestId("order-detail")).not.toContainText("RENOMEADA");
    await expect(page.getByTestId("order-receipt")).toContainText(/Valor debitado\s*R\$\s*16,00/);
    await expect(page.getByTestId("order-receipt")).toContainText(/Saldo após a compra\s*R\$\s*184,00/);
    await expect(page.getByTestId("order-timeline")).toContainText("Comprado por: Responsável");
    expect(page.url()).toContain(orderId);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    // extrato: o movimento aponta para o pedido
    await page.goto("/portal/carteira/extrato");
    await expect(page.getByTestId("statement-row").first()).toContainText("Compra antecipada", { timeout: 30000 });
    await expect(page.getByTestId("statement-row")).toHaveCount(2); // fixture de saldo (ajuste) + compra
    await page.getByLabel("Tipo").selectOption({ label: "Recarga" });
    await expect(page.getByTestId("statement-empty")).toBeVisible();
    await page.getByLabel("Tipo").selectOption({ label: "Ajuste" });
    await expect(page.getByTestId("statement-row")).toHaveCount(1);
    await page.getByLabel("Tipo").selectOption({ label: "Compra antecipada" });
    await expect(page.getByTestId("statement-row")).toHaveCount(1);
    await expect(page.getByTestId("statement-row").first().getByRole("link", { name: "pedido" })).toHaveAttribute("href", `/portal/pedidos/${orderId}`);
  });

  test("paginação por cursor: 24 pedidos em páginas de 20 + 4, sem duplicar nem omitir", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-mo-g3-${tag}`, "guardian");
    const f = await student([guardian], "Davi", 50000);
    const item = await product(request, "Pão", 100);
    const all: string[] = [];
    for (let n = 0; n < 4; n++) all.push(...(await buy(request, guardian, f.id, item, [d(1), d(2), d(3), d(4), d(5), d(6)])).orders.map((o) => o.orderId)); // hoje já passou do horário limite
    expect(new Set(all).size).toBe(24);

    await login(page, guardian.email);
    await expect(rows(page)).toHaveCount(20, { timeout: 30000 });
    await page.getByTestId("orders-more").click();
    await expect(rows(page)).toHaveCount(24);
    await expect(page.getByTestId("orders-more")).toHaveCount(0);
    const shown = await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-order")));
    expect(new Set(shown).size).toBe(24);
    expect([...shown].sort()).toEqual([...all].sort());
  });

  test("troca de conta e vínculo revogado: nada da conta/aluno anterior permanece; detalhe de pedido sem vínculo é negado", async ({ page, request }) => {
    const g1 = await createTestUser(`e2e-mo-g4a-${tag}`, "guardian");
    const g2 = await createTestUser(`e2e-mo-g4b-${tag}`, "guardian");
    const eva = await student([g1], "Eva", 20000);
    const fabio = await student([g1], "Fabio", 20000);
    const gil = await student([g2], "Gil", 20000);
    const item = await product(request, "Torta", 300);
    const evaOrder = (await buy(request, g1, eva.id, item, [d(1)])).orders[0]!.orderId;
    await buy(request, g1, fabio.id, item, [d(1)]);
    await buy(request, g2, gil.id, item, [d(1), d(2)]);

    await login(page, g1.email);
    await expect(rows(page)).toHaveCount(2, { timeout: 30000 });
    // vínculo com Fabio é revogado com a tela aberta: ele sai da lista (listener de vínculos) e a consulta é refeita sem ele
    await writeDemoDoc(targetFromEnv(), `guardianStudentLinks/${g1.uid}_${fabio.id}`, { guardianUid: g1.uid, studentId: fabio.id, status: "revoked" });
    await expect(rows(page)).toHaveCount(1, { timeout: 30000 });
    await expect(page.getByTestId("orders-list")).toContainText(eva.name);
    await expect(page.getByTestId("orders-list")).not.toContainText(fabio.name);

    // sair e entrar com OUTRA conta: só os pedidos dela
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await page.getByLabel("Email").fill(g2.email);
    await page.getByLabel("Senha").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(rows(page)).toHaveCount(2, { timeout: 30000 });
    await expect(page.getByTestId("orders-list")).toContainText(gil.name);
    await expect(page.getByTestId("my-orders")).not.toContainText(eva.name);

    // pedido de outra família por URL direta
    await page.goto(`/portal/pedidos/${evaOrder}`);
    await expect(page.getByTestId("order-error")).toContainText("não tem acesso", { timeout: 30000 });
    await expect(page.getByTestId("order-detail")).toHaveCount(0);
  });

  test("tempo real: compra feita depois que a tela abriu aparece sem recarregar; trocar o filtro descarta a resposta antiga em voo", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-mo-g5-${tag}`, "guardian");
    const f = await student([guardian], "Helo", 20000);
    const item = await product(request, "Bolo", 500);
    await buy(request, guardian, f.id, item, [d(1)]);
    await login(page, guardian.email);
    await expect(rows(page)).toHaveCount(1, { timeout: 30000 });
    await expect(page.getByTestId("my-orders")).toBeVisible();

    await buy(request, guardian, f.id, item, [d(2)]);
    await expect(rows(page)).toHaveCount(2, { timeout: 30000 }); // wallets/{aluno} (listener) → releitura reconciliada por versão

    // resposta antiga em voo: o filtro "Cancelados" é atrasado e NÃO pode sobrescrever o resultado do filtro seguinte ("Todos")
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/orders?*group=cancelled*", async (route) => {
      await gate;
      await route.continue();
    });
    await page.getByTestId("orders-tab-cancelled").click();
    await expect(page.getByTestId("orders-feedback")).toContainText("Carregando");
    await page.getByTestId("orders-tab-all").click();
    await expect(rows(page)).toHaveCount(2);
    release();
    await page.waitForTimeout(500);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId("orders-empty")).toHaveCount(0);
    await page.unroute("**/api/orders?*group=cancelled*");
  });

  test("estados: erro do servidor com nova tentativa, lista vazia e falha ao atualizar mantendo a lista com aviso", async ({ page, request }) => {
    const guardian = await createTestUser(`e2e-mo-g6-${tag}`, "guardian");
    const f = await student([guardian], "Ivo", 20000);
    const item = await product(request, "Esfiha", 400);
    await buy(request, guardian, f.id, item, [d(1)]);

    let fail = true;
    await page.route("**/api/orders?*", async (route) => {
      if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) });
      else await route.continue();
    });
    await login(page, guardian.email);
    await expect(page.getByTestId("orders-error")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("orders-empty")).toHaveCount(0); // erro nunca se passa por "vazio"
    fail = false;
    await page.getByRole("button", { name: "Tentar de novo" }).click();
    await expect(rows(page)).toHaveCount(1);
    await page.getByTestId("orders-tab-completed").click();
    await expect(page.getByTestId("orders-empty")).toBeVisible();
    await page.getByTestId("orders-tab-pending").click();
    await expect(rows(page)).toHaveCount(1);

    fail = true;
    await page.getByRole("button", { name: "Atualizar" }).click();
    await expect(page.getByTestId("orders-stale")).toBeVisible();
    await expect(rows(page)).toHaveCount(1); // lista anterior mantida, com aviso
    fail = false;
    await page.getByRole("button", { name: "Atualizar" }).click();
    await expect(page.getByTestId("orders-stale")).toHaveCount(0);
  });

  test("celular e teclado: sem rolagem horizontal, filtros por rótulo, abas operáveis por teclado, recibo legível", async ({ browser, request }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const page = await context.newPage();
    const guardian = await createTestUser(`e2e-mo-g7-${tag}`, "guardian");
    const a = await student([guardian], "Jana", 20000);
    await student([guardian], "Kaue", 20000);
    const item = await product(request, "Empada com recheio de frango e catupiry", 650);
    await buy(request, guardian, a.id, item, [d(1)], 3);
    await login(page, guardian.email);
    await expect(rows(page)).toHaveCount(1, { timeout: 30000 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    for (const label of ["Aluno", "Consumo a partir de", "Consumo até", "Canal", "Turno", "Situação detalhada"]) await expect(page.getByLabel(label)).toBeVisible();

    await page.getByTestId("orders-tab-completed").focus();
    await expect(page.getByTestId("orders-tab-completed")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("orders-tab-completed")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("orders-tab-pending")).toHaveAttribute("aria-pressed", "true");
    await expect(rows(page)).toHaveCount(1);

    await rows(page).first().getByRole("link", { name: "Detalhes e recibo" }).click();
    await expect(page.getByTestId("order-detail")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("order-total")).toHaveText(/R\$\s*19,50/);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.goto("/portal/carteira/extrato");
    await expect(page.getByTestId("statement-row").first()).toBeVisible({ timeout: 30000 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await context.close();
  });
});
