import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createTestUser, TEST_PASSWORD } from "../helpers/auth-emulator";
import { fixtureIds, prepareCatalog, productIdByName } from "../helpers/catalog-fixtures.ts";
import { warmRoutes } from "../helpers/dev-server.ts";
import { adminPost, createFamily } from "../helpers/menu-fixtures.ts";

async function login(page: Page, path: string, email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

// Roda no emulador e na homologação: cria só os próprios dados (categoria/produto com sufixo aleatório) e os encerra pelo
// fluxo autorizado; os produtos "(exemplo)" são apenas lidos.
test.beforeAll(async ({ request }) => {
  await prepareCatalog();
  // TODAS as rotas do fluxo compiladas antes de abrir as páginas (a família recarrega com o painel da administração aberto).
  await warmRoutes(request, {
    post: ["/api/students", "/api/links", "/api/menu", "/api/catalog/categories", "/api/catalog/products"],
    get: ["/api/catalog/photo?productId=x", "/api/menu", "/portal/cardapio", "/operacao/produtos"],
  });
});

test("administração: categoria, produto, preço com histórico e desativação; família vê só o público (A16/A37)", async ({ browser, request }) => {
  const tag = randomUUID().slice(0, 6);
  const product = `Brigadeiro ${tag}`;
  const admin = await createTestUser("e2e-catalogo-adm", "admin");
  const family = (await createFamily(request, "e2e-catalogo-familia")).guardian;
  const morning = (await fixtureIds()).shift("Manhã (exemplo)");
  test.setTimeout(150_000);
  // Família entra primeiro: no dev server a 1ª compilação de uma rota recarrega as outras páginas abertas (HMR) e
  // descartaria o painel aberto da administração. O portal (F07) mostra o cardápio do aluno resolvido pelo servidor e
  // é recarregado para ver as mudanças.
  const familyPage = await (await browser.newContext()).newPage();
  await login(familyPage, "/portal/cardapio", family.email);
  await expect(familyPage.getByTestId("product").first()).toBeVisible({ timeout: 30000 });
  const page = await (await browser.newContext()).newPage();
  await login(page, "/operacao/produtos", admin.email);
  await expect(page.getByRole("heading", { name: "Produtos", exact: true })).toBeVisible({ timeout: 20000 });

  // Categoria nova pela tela.
  await page.locator("#new-category").fill(`Doces ${tag}`);
  await page.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(page.getByTestId("categories").getByText(`Doces ${tag}`)).toBeVisible();

  // Produto novo: preço digitado em reais vira centavos no servidor; fornecedor fica interno.
  await page.getByRole("button", { name: "Novo produto" }).click();
  await page.locator("#new-product-name").fill(product);
  await page.locator("#new-product-category").selectOption({ label: `Doces ${tag}` });
  await page.locator("#new-product-price").fill("8,00");
  await page.locator("#new-product-description").fill("Doce de chocolate (teste).");
  await page.getByRole("radio", { name: "Planejado por data/turno" }).check();
  await page.locator("#new-product-supplier").fill(`Fornecedor e2e ${tag}`);
  await page.getByRole("button", { name: "Cadastrar produto" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Produto cadastrado." })).toBeVisible();
  const row = page.getByTestId("photo-row").filter({ hasText: product });
  await expect(row.getByTestId("product-price")).toHaveText(/R\$\s8,00/);
  await expect(row).toContainText("Planejado por data/turno");

  // Preço: R$ 8 → R$ 9 com motivo; o histórico mantém a entrada de R$ 8.
  await row.getByRole("button", { name: `Gerenciar ${product}` }).click();
  await page.locator("#new-price").fill("9,00");
  await page.locator("#price-reason").fill("Reajuste e2e");
  await page.getByRole("button", { name: "Salvar preço" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Preço alterado para novas vendas." })).toBeVisible();
  await expect(row.getByTestId("product-price")).toHaveText(/R\$\s9,00/);
  await row.getByRole("button", { name: `Gerenciar ${product}` }).click();
  const historyList = page.getByTestId("price-history");
  await expect(historyList.getByRole("listitem")).toHaveCount(2);
  await expect(historyList.getByRole("listitem").first()).toContainText("Reajuste e2e");
  await expect(historyList.getByRole("listitem").last()).toContainText("Cadastro inicial");
  // O formulário de edição mostra o fornecedor interno só para a administração.
  await expect(page.getByLabel("Fornecedor padrão (interno)")).toHaveValue(`Fornecedor e2e ${tag}`);

  // Família: com o produto no cardápio padrão da manhã (F07), vê o preço novo e nada interno.
  await adminPost(request, admin, "/api/menu", { action: "setDefault", productId: await productIdByName(product), shiftIds: [morning], expectedVersion: 0 });
  await familyPage.reload();
  const item = familyPage.getByTestId("product").filter({ hasText: product });
  await expect(item).toContainText(/R\$\s9,00/, { timeout: 20000 });
  await expect(familyPage.getByText(`Fornecedor e2e ${tag}`)).toHaveCount(0);

  // Desativar: some das novas vendas (o portal recarregado não o mostra), continua consultável com histórico na operação.
  await page.locator("#deactivate-reason").fill("Fim da temporada");
  await page.getByRole("button", { name: "Desativar produto" }).click();
  await expect(page.getByRole("status").filter({ hasText: "O histórico foi mantido." })).toBeVisible();
  await expect(row).toHaveCount(0);
  await familyPage.reload();
  await expect(familyPage.getByTestId("product").first()).toBeVisible({ timeout: 20000 });
  await expect(item).toHaveCount(0);
  await page.locator("#product-status-filter").selectOption("inactive");
  await expect(row).toContainText("Desativado");
  await row.getByRole("button", { name: `Gerenciar ${product}` }).click();
  await expect(page.getByTestId("price-history").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Reativar produto" })).toBeVisible();

  // Sem produto ativo, a categoria pode ser arquivada pela tela (nada é apagado).
  const categories = page.getByTestId("categories");
  await categories.getByRole("button", { name: `Arquivar Doces ${tag}` }).click();
  await expect(categories.getByRole("status")).toContainText("Categoria arquivada.");
  await expect(categories.getByRole("listitem").filter({ hasText: `Doces ${tag}` })).toContainText("Arquivada");
});

test("cantina: consulta e troca foto, sem cadastro/preço; celular sem rolagem horizontal (A36/A37)", async ({ browser }) => {
  const staff = await createTestUser("e2e-catalogo-cantina", "cantina");
  const context = await browser.newContext({ viewport: { width: 375, height: 740 } });
  const page = await context.newPage();
  await login(page, "/operacao/produtos", staff.email);
  await expect(page.getByTestId("photo-row").filter({ hasText: "Suco de laranja (exemplo)" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Novo produto" })).toHaveCount(0);
  await expect(page.getByTestId("categories")).toHaveCount(0);
  await expect(page.getByLabel("Enviar foto de Suco de laranja (exemplo)")).toBeAttached();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Histórico de preço é consultável; formulário de preço não existe para a cantina.
  await page.getByRole("button", { name: "Histórico de preço de Suco de laranja (exemplo)" }).click();
  await expect(page.getByTestId("price-history").getByRole("listitem").last()).toContainText("Cadastro inicial");
  await expect(page.locator("#new-price")).toHaveCount(0);
  await expect(page.getByLabel("Fornecedor padrão (interno)")).toHaveCount(0);
  await context.close();
});
