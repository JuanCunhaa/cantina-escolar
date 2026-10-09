import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createTestUser, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";
import { localDateOf } from "../../src/lib/dates/school-time.ts";

// Relatórios de vendas, CMV e margens (F21) pela interface, no emulador, com dados FICTÍCIOS: a administração vê receita, CMV, lucro
// bruto e margem de uma venda direta (A20: 10 × R$ 2,00 com custo médio R$ 1,05 → CMV R$ 10,50, lucro R$ 9,50), filtra por produto,
// troca o ranking e baixa o CSV; a cantina vê quantidades e valores SEM custo nem lucro (e sem o item de menu do Financeiro);
// a secretaria não acessa. Celular sem rolagem lateral. A matemática é provada nos testes unitários e de integração.

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_rel_${tag}`;
const CAT = `cat_rel_${tag}`;
const PRODUCT = `prd_rel_${tag}`;
let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
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
async function login(page: Page, email: string, path: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const auth = (u: TestUser) => ({ authorization: `Bearer ${u.idToken}` });

async function receive(request: APIRequestContext, quantity: number, unitCost: string) {
  const r = await request.post("/api/inventory/receipts", { headers: auth(admin), data: { key: randomUUID(), action: "create", productId: PRODUCT, kind: "purchase", quantity, unitCost } });
  expect(r.status(), await r.text()).toBe(200);
}

test.beforeAll(async ({ request }) => {
  [admin, cantina, secretaria] = await Promise.all([
    createTestUser(`e2e-rel-adm-${tag}`, "admin", { displayName: "Admin Relatórios E2E" }),
    createTestUser(`e2e-rel-can-${tag}`, "cantina", { displayName: "Cantina Relatórios E2E" }),
    createTestUser(`e2e-rel-sec-${tag}`, "secretaria", { displayName: "Secretaria Relatórios E2E" }),
  ]);
  const today = localDateOf(new Date());
  await track(`shifts/${SHIFT}`, { name: `Turno Rel ${tag}`, nameSlug: "turno-rel", status: "active" });
  await track(`categories/${CAT}`, { name: `Categoria Rel ${tag}`, status: "active" });
  await track(`calendarDays/${today}`, { kind: "extra" });
  await track(`products/${PRODUCT}`, { name: `Coxinha Rel ${tag}`, description: "", categoryId: CAT, priceCents: 200, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [SHIFT], availabilityMode: "physical", status: "active", version: 1 });
  await track(`defaultMenuRules/${PRODUCT}`, { shiftIds: [SHIFT], version: 1 });
  // Todas as rotas que o fluxo toca antes de abrir páginas (compilar no meio do fluxo recarrega a tela e perde o estado).
  await warmRoutes(request, {
    post: ["/api/inventory/receipts", "/api/pos/direct-sales"],
    get: ["/operacao/relatorios", "/api/reports/sales", "/api/reports/sales/export"],
  });
  // A20: 100 × R$ 1,00 + 100 × R$ 1,10 (média R$ 1,05); venda direta de 10 a R$ 2,00.
  await receive(request, 100, "1,00");
  await receive(request, 100, "1,10");
  const sale = await request.post("/api/pos/direct-sales", {
    headers: auth(cantina),
    data: { key: randomUUID(), shiftId: SHIFT, lines: [{ productId: PRODUCT, quantity: 10, expectedPriceCents: 200 }], paymentMethod: "cash", receivedConfirmed: true },
  });
  expect(sale.status(), await sale.text()).toBe(200);
});
test.afterAll(removeCreated);

test("administração vê receita, CMV, lucro bruto e margem, filtra por produto e troca o ranking", async ({ page }) => {
  await login(page, admin.email, "/operacao/relatorios");
  await expect(page.getByRole("heading", { name: "Relatórios de vendas" })).toBeVisible();
  await page.locator("#rs-product").selectOption(PRODUCT);
  const totals = page.getByTestId("sales-totals");
  await expect(totals).toContainText("10"); // unidades
  await expect(totals).toContainText(/R\$\s20,00/); // receita
  await expect(totals).toContainText(/R\$\s10,50/); // CMV
  await expect(page.getByTestId("sales-profit")).toContainText(/R\$\s9,50/);
  await expect(totals).toContainText("47,50 %");
  await expect(page.getByTestId("sales-by-channel")).toContainText("Venda direta");
  await expect(page.getByTestId("sales-fictitious")).toBeVisible(); // ambiente de teste identificado
  // seções da escola inteira somem com o filtro de produto, com o aviso
  await expect(page.getByTestId("sales-skipped")).toBeVisible();
  await page.locator("#rs-rank-by").selectOption("profitPerUnit");
  await expect(page.getByTestId("sales-ranking")).toContainText("Maior lucro por unidade");
  await expect(page.getByTestId("sales-ranking")).toContainText(`Coxinha Rel ${tag}`);
  await page.locator("#rs-product").selectOption("");
  await expect(page.getByTestId("sales-result")).toBeVisible(); // sem filtro: resultado, carteiras e conferências aparecem
  await expect(page.getByTestId("sales-ledger")).toBeVisible();
});

test("exportação do resumo em CSV baixa o arquivo do período", async ({ page }) => {
  await login(page, admin.email, "/operacao/relatorios");
  await page.locator("#rs-product").selectOption(PRODUCT);
  await expect(page.getByTestId("sales-totals")).toContainText(/R\$\s20,00/);
  await page.locator("#rs-export-view").selectOption("products");
  const download = page.waitForEvent("download");
  await page.getByTestId("sales-export").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^relatorio-products-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
});

test("cantina vê quantidades e valores, sem custo, CMV, lucro nem margem; secretaria não acessa", async ({ page, browser }) => {
  await login(page, cantina.email, "/operacao/relatorios");
  await expect(page.getByRole("heading", { name: "Relatórios de vendas" })).toBeVisible();
  await page.locator("#rs-product").selectOption(PRODUCT);
  await expect(page.getByTestId("sales-totals")).toContainText(/R\$\s20,00/);
  await expect(page.getByTestId("sales-totals")).toContainText("Ticket médio");
  const body = await page.locator("main, body").first().innerText();
  for (const word of ["CMV", "Lucro", "Margem", "Resultado após", "Compras de estoque", "Carteiras"]) expect(body, word).not.toContain(word);
  await expect(page.getByRole("link", { name: "Financeiro" })).toHaveCount(0);

  const other = await browser.newContext();
  const sec = await other.newPage();
  await login(sec, secretaria.email, "/operacao/relatorios");
  await expect(sec.getByText("Seu perfil não acessa os relatórios de vendas.")).toBeVisible();
  await other.close();
});

test("celular: relatório da administração sem rolagem lateral", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await login(page, admin.email, "/operacao/relatorios");
  await expect(page.getByRole("heading", { name: "Relatórios de vendas" })).toBeVisible();
  await expect(page.getByTestId("sales-totals")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});
