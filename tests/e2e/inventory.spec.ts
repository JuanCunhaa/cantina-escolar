import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createTestUser, TEST_PASSWORD } from "../helpers/auth-emulator";
import { createTempProduct, prepareCatalog, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { warmRoutes } from "../helpers/dev-server.ts";

async function login(page: Page, path: string, email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

const row = (page: Page, id: string) => page.getByTestId("stock-table").locator(`tr[data-product="${id}"]`);
async function openProduct(page: Page, id: string) {
  await expect(row(page, id)).toBeVisible({ timeout: 30000 });
  await row(page, id).getByRole("button", { name: /Abrir/ }).click();
  await expect(page.getByTestId("stock-detail")).toHaveAttribute("data-product", id);
}

test.beforeAll(async ({ request }) => {
  await prepareCatalog();
  await warmRoutes(request, {
    post: ["/api/catalog/products", "/api/inventory/receipts", "/api/inventory/losses", "/api/inventory/adjustments", "/api/inventory/capacity"],
    get: ["/operacao/estoque", "/api/inventory", "/api/inventory/product?productId=x", "/api/inventory/reconcile"],
  });
});

test("administração: duas compras viram duas entradas, custo médio R$ 1,05 e custo visível só a ela (A20)", async ({ browser, request }) => {
  test.setTimeout(150_000);
  const tag = randomUUID().slice(0, 6);
  const admin = await createTestUser("e2e-estoque-adm", "admin");
  const cantina = await createTestUser("e2e-estoque-cant", "cantina");
  const family = await createTestUser("e2e-estoque-fam", "guardian");
  const productId = await createTempProduct(request, admin.idToken, `Suco estoque ${tag}`);
  try {
    const page = await (await browser.newContext()).newPage();
    await login(page, "/operacao/estoque", admin.email);
    await expect(page.getByRole("heading", { name: "Estoque", exact: true })).toBeVisible({ timeout: 30000 });
    await openProduct(page, productId);

    const entry = page.getByTestId("entry-form");
    await entry.getByLabel("Quantidade (unidades)").fill("100");
    await entry.getByLabel("Custo unitário (R$)").fill("1,00");
    await entry.getByRole("button", { name: "Registrar entrada" }).click();
    await expect(page.getByTestId("entry-message")).toHaveText("Entrada registrada.");
    await expect(page.getByTestId("detail-onhand")).toHaveText("100");

    await entry.getByLabel("Quantidade (unidades)").fill("100");
    await entry.getByLabel("Custo unitário (R$)").fill("1,10");
    await entry.getByRole("button", { name: "Registrar entrada" }).click();
    await expect(page.getByTestId("detail-onhand")).toHaveText("200");
    await expect(page.getByTestId("detail-average")).toHaveText("R$ 1,05"); // média sobre o que está em estoque
    await expect(page.getByTestId("receipts-table").locator("tbody tr")).toHaveCount(2); // nada de editar o 1º custo
    await expect(page.getByTestId("stock-table").getByRole("columnheader", { name: "Custo médio" })).toBeVisible();

    // Entrada inválida: custo zero é recusado pelo servidor e não escreve nada.
    await entry.getByLabel("Quantidade (unidades)").fill("1");
    await entry.getByLabel("Custo unitário (R$)").fill("0");
    await entry.getByRole("button", { name: "Registrar entrada" }).click();
    await expect(page.getByTestId("entry-message")).toContainText("Custo unitário inválido");
    await expect(page.getByTestId("detail-onhand")).toHaveText("200");

    // Perda pela administração: motivo obrigatório, físico diminui uma vez, histórico preservado.
    const loss = page.getByTestId("loss-form");
    await loss.getByLabel("Quantidade").fill("10");
    await loss.getByLabel("Observação (obrigatória)").fill("caixa molhada");
    await loss.getByRole("button", { name: "Registrar perda" }).click();
    await expect(page.getByTestId("loss-message")).toHaveText("Perda registrada.");
    await expect(page.getByTestId("detail-onhand")).toHaveText("190");
    await expect(page.getByTestId("movements-table").locator("tbody tr")).toHaveCount(3);

    if (process.env.F10_SHOTS) await page.screenshot({ path: `${process.env.F10_SHOTS}/estoque-admin.png`, fullPage: true });

    // Reconciliação da administração fecha: saldo = livro = lotes.
    const reconcile = await request.get(`/api/inventory/reconcile?productId=${productId}`, { headers: { authorization: `Bearer ${admin.idToken}` } });
    expect(await reconcile.json()).toMatchObject({ ok: true });

    // Cantina: vê as quantidades e registra perda, mas nenhum custo nem formulário de entrada/ajuste.
    const cantinaPage = await (await browser.newContext()).newPage();
    await login(cantinaPage, "/operacao/estoque", cantina.email);
    await openProduct(cantinaPage, productId);
    await expect(cantinaPage.getByTestId("detail-onhand")).toHaveText("190");
    await expect(cantinaPage.getByRole("columnheader", { name: /Custo|Valor|Lucro/ })).toHaveCount(0);
    await expect(cantinaPage.getByTestId("detail-average")).toHaveCount(0);
    await expect(cantinaPage.getByTestId("entry-form")).toHaveCount(0);
    await expect(cantinaPage.getByTestId("count-forms")).toHaveCount(0);
    await expect(cantinaPage.getByTestId("receipts-table")).toHaveCount(0);
    await expect(cantinaPage.getByText(/R\$ 1,0/)).toHaveCount(0);
    const cantinaLoss = cantinaPage.getByTestId("loss-form");
    await cantinaLoss.getByLabel("Quantidade").fill("5");
    await cantinaLoss.getByLabel("Observação (obrigatória)").fill("quebra no balcão");
    await cantinaLoss.getByRole("button", { name: "Registrar perda" }).click();
    await expect(cantinaPage.getByTestId("detail-onhand")).toHaveText("185");

    // Celular estreito: sem rolagem lateral.
    await cantinaPage.setViewportSize({ width: 390, height: 800 });
    expect(await cantinaPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    if (process.env.F10_SHOTS) await cantinaPage.screenshot({ path: `${process.env.F10_SHOTS}/estoque-cantina-celular.png`, fullPage: true });

    // Família não acessa a API de estoque.
    for (const url of ["/api/inventory", `/api/inventory/product?productId=${productId}`]) {
      expect((await request.get(url, { headers: { authorization: `Bearer ${family.idToken}` } })).status()).toBe(403);
    }
  } finally {
    await retireTempProduct(request, admin.idToken, productId);
  }
});

test("produto planejado: sem cota não reserva, a cota aparece por data/turno e a entrada exige a data de disponibilidade", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const tag = randomUUID().slice(0, 6);
  const admin = await createTestUser("e2e-estoque-adm2", "admin");
  const productId = await createTempProduct(request, admin.idToken, `Hot-dog estoque ${tag}`, { availabilityMode: "planned" });
  try {
    const page = await (await browser.newContext()).newPage();
    await login(page, "/operacao/estoque", admin.email);
    await openProduct(page, productId);
    await expect(page.getByText("Planejado por data").first()).toBeVisible();
    await expect(page.getByText("Sem cota, o produto planejado não aceita reservas.")).toBeVisible();

    const capacity = page.getByTestId("capacity-form");
    await expect(capacity.getByLabel("Turno")).not.toBeEmpty({ timeout: 20000 });
    await capacity.getByLabel("Cota (unidades)").fill("20");
    await capacity.getByRole("button", { name: "Salvar cota" }).click();
    await expect(page.getByTestId("capacity-message")).toContainText("Cota salva");
    await expect(page.getByTestId("capacity-table").locator("tbody tr")).toHaveCount(1);
    await expect(page.getByTestId("capacity-table").locator("tbody tr").first()).toContainText("20");

    // Produzido hoje: a entrada de produto acabado vira estoque físico; o planejado sozinho nunca vira unidade.
    await expect(page.getByTestId("detail-onhand")).toHaveText("0");
    const entry = page.getByTestId("entry-form");
    await entry.getByLabel("Quantidade (unidades)").fill("12");
    await entry.getByLabel("Custo unitário (R$)").fill("2,50");
    await entry.getByRole("button", { name: "Registrar entrada" }).click();
    await expect(page.getByTestId("detail-onhand")).toHaveText("12");
    await expect(page.getByTestId("detail-average")).toHaveText("R$ 2,50");
  } finally {
    await retireTempProduct(request, admin.idToken, productId);
  }
});
