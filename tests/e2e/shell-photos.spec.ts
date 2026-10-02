import { expect, test, type Locator, type Page } from "@playwright/test";
import { createTestUser } from "../helpers/auth-emulator";
import { makePng } from "../../scripts/lib/demo-seed.ts";
import { createTempProduct, prepareCatalog, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { warmRoutes } from "../helpers/dev-server.ts";
import { createFamily } from "../helpers/menu-fixtures.ts";

// Roda no emulador (catálogo semeado) e na homologação (catálogo compartilhado, garantido pela API no global-setup):
// as asserções miram os produtos "(exemplo)" por nome, nunca a contagem total, e nenhum teste altera esses produtos.
// Desde a F07 o portal mostra o cardápio do ALUNO (data/turno): cada teste cria a própria família com um aluno
// fictício na manhã de exemplo, e o portal abre na primeira data com compra permitida.

async function login(page: Page, path: string, email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill("senha-fake-123");
  await page.getByRole("button", { name: "Entrar" }).click();
}

const brl = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/ /g, " ");
const product = (page: Page, name: string) => page.getByTestId("product").filter({ hasText: name });
/** Preço exibido no item (centavos), para calcular o total esperado sem fixar o cadastro da homologação. */
async function priceOf(item: Locator): Promise<number> {
  const text = (await item.locator(".product-price").innerText()).replace(/[^\d,]/g, "");
  const [reais = "0", centavos = "00"] = text.split(",");
  return Number(reais) * 100 + Number(centavos.padEnd(2, "0"));
}

test.beforeAll(async ({ request }) => {
  await prepareCatalog();
  await warmRoutes(request, { post: ["/api/students", "/api/links", "/api/menu"], get: ["/api/catalog/photo?productId=x", "/api/menu", "/portal/cardapio"] });
});

test("portal: cardápio do aluno (fictício) com fotos, fallback, canal só balcão, turno e total em BRL (A36/A37)", async ({ page, request }) => {
  const family = (await createFamily(request, "e2e-familia")).guardian;
  await login(page, "/portal/cardapio", family.email);
  await expect(page.getByRole("heading", { name: "Cardápio", exact: true })).toBeVisible();
  // Aluno e turno sempre visíveis: o cardápio exibido é o do turno do aluno.
  await expect(page.getByTestId("menu-student")).toContainText("Manhã (exemplo)", { timeout: 20000 });

  // Produtos com foto: servida pelo servidor (bucket privado, blob com o ID token), nunca um endereço do bucket.
  for (const name of ["Suco de laranja (exemplo)", "Pão com queijo (exemplo)", "Salada de frutas (exemplo)"]) {
    const img = product(page, name).locator(".photo img");
    await expect(img).toHaveAttribute("src", /^blob:/, { timeout: 20000 });
    await expect(img).toHaveJSProperty("complete", true);
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await expect(img).toHaveAttribute("alt", name);
  }
  // Sem foto: fallback discreto; só de balcão: sem controle de quantidade no portal.
  const bolo = product(page, "Bolo de cenoura (exemplo)");
  await expect(bolo.locator('[data-fallback="true"]')).toBeVisible();
  await expect(page.getByRole("img", { name: /Bolo de cenoura.*sem foto/ })).toBeVisible();
  await expect(bolo.getByText("Só no balcão")).toBeVisible();
  await expect(page.getByRole("button", { name: /Aumentar Bolo de cenoura/ })).toHaveCount(0);
  // Salada é só da manhã: aparece para o aluno da manhã (o aluno da tarde não a vê — ver menu.spec).
  await expect(product(page, "Salada de frutas (exemplo)")).toBeVisible();
  // Produto desativado não aparece para a família; custo/fornecedor nunca chegam à tela.
  await expect(page.getByText("Pipoca (exemplo)")).toHaveCount(0);
  await expect(page.getByText("Fornecedor fictício")).toHaveCount(0);

  // Quantidade e total respondem imediatamente, com o preço exibido.
  const suco = await priceOf(product(page, "Suco de laranja (exemplo)"));
  const pao = await priceOf(product(page, "Pão com queijo (exemplo)"));
  await page.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" }).click();
  await page.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" }).click();
  await page.getByRole("button", { name: "Aumentar Pão com queijo (exemplo)" }).click();
  await expect(page.getByTestId("summary-total")).toContainText(brl(2 * suco + pao));
});

test("teclado: pular para o conteúdo, navegação e quantidade sem mouse (A37)", async ({ page, request }) => {
  const family = (await createFamily(request, "e2e-teclado")).guardian;
  await login(page, "/portal/cardapio", family.email);
  const plus = page.getByRole("button", { name: "Aumentar Salada de frutas (exemplo)" });
  await expect(plus).toBeVisible({ timeout: 20000 });

  // Nova carga (sessão persistida): o foco começa no topo do documento, como para quem chega pelo teclado.
  await page.goto("/portal/cardapio");
  await expect(plus).toBeVisible({ timeout: 20000 });
  const fruta = await priceOf(product(page, "Salada de frutas (exemplo)"));
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Pular para o conteúdo" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#conteudo")).toBeFocused();

  await plus.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("summary-total")).toContainText(brl(2 * fruta));
  // Foco visível: contorno de 3px no elemento focado.
  const outline = await plus.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(outline).toBe("3px");

  const current = page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Cardápio" });
  await expect(current).toHaveAttribute("aria-current", "page");
});

test("celular: sem rolagem horizontal, alvos de toque e resumo fixo visível (A37)", async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await context.newPage();
  const family = (await createFamily(request, "e2e-celular")).guardian;
  await login(page, "/portal/cardapio", family.email);
  const plus = page.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" });
  await expect(plus).toBeVisible({ timeout: 20000 });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await plus.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(40);
  expect(box?.height).toBeGreaterThanOrEqual(40);
  await expect(page.getByRole("complementary", { name: "Resumo da seleção" })).toBeInViewport();
  await context.close();
});

test("reduced motion: sem transições e a ação não depende de animação (A37)", async ({ browser, request }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const family = (await createFamily(request, "e2e-movimento")).guardian;
  await login(page, "/portal/cardapio", family.email);
  const plus = page.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" });
  await expect(plus).toBeVisible({ timeout: 20000 });
  const suco = brl(await priceOf(product(page, "Suco de laranja (exemplo)")));
  const duration = await plus.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(duration).toBeLessThan(0.01);
  await plus.click({ timeout: 1000 });
  await expect(page.getByTestId("summary-total")).toContainText(suco, { timeout: 1000 });
  await context.close();

  // Sem a preferência, a transição curta (150 ms) existe e também não bloqueia a ação.
  const normal = await (await browser.newContext({ reducedMotion: "no-preference" })).newPage();
  await login(normal, "/portal/cardapio", family.email);
  const button = normal.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" });
  await expect(button).toBeVisible({ timeout: 20000 });
  expect(await button.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))).toBeCloseTo(0.15, 2);
  await button.click({ timeout: 1000 });
  await expect(normal.getByTestId("summary-total")).toContainText(suco, { timeout: 1000 });
});

test("perfis: responsável não acessa a operação; navegação mostra só o que o papel tem (A37)", async ({ page }) => {
  const family = await createTestUser("e2e-perfil", "guardian");
  await login(page, "/operacao/produtos", family.email);
  await expect(page.getByRole("heading", { name: "Área indisponível para o seu perfil" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navegação principal" })).toHaveCount(0);
  await expect(page.getByLabel(/Enviar foto/)).toHaveCount(0);
  // No dev server a 1ª compilação de /portal pode recarregar a página e descartar o clique: repete até navegar.
  await expect(async () => {
    await page.getByRole("link", { name: "Ir para a minha área" }).click({ timeout: 2000 });
    await expect(page).toHaveURL(/\/portal$/, { timeout: 4000 });
  }).toPass({ timeout: 30000 });
  await expect(page.getByRole("heading", { name: "Portal da família" })).toBeVisible({ timeout: 20000 }); // 1ª compilação da rota no dev server
  await expect(page.getByText("Meus pedidos (em breve)")).toBeVisible();
});

test("operação: funcionário envia foto válida; arquivo inválido e grande demais são recusados (A36)", async ({ page, request }) => {
  // Produto temporário criado pela administração (API): o envio de foto não altera os produtos de exemplo.
  const admin = await createTestUser("e2e-foto-adm", "admin");
  const name = `Foto e2e ${crypto.randomUUID().slice(0, 6)}`;
  const id = await createTempProduct(request, admin.idToken, name);
  try {
    const staff = await createTestUser("e2e-cantina", "cantina");
    await login(page, "/operacao/produtos", staff.email);
    const row = page.getByTestId("photo-row").filter({ hasText: name });
    await expect(row.locator('[data-fallback="true"]')).toBeVisible({ timeout: 20000 });
    const input = page.getByLabel(`Enviar foto de ${name}`);

    // Tipo inválido: recusado antes de qualquer envio.
    await input.setInputFiles({ name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("não sou imagem") });
    await expect(row.getByRole("alert")).toContainText("JPEG, PNG ou WebP");

    // Acima de 2 MB: recusado.
    await input.setInputFiles({ name: "grande.png", mimeType: "image/png", buffer: Buffer.concat([makePng(8, 8, [1, 2, 3]), Buffer.alloc(2 * 1024 * 1024)]) });
    await expect(row.getByRole("alert")).toContainText("2 MB");
    await expect(row.locator('[data-fallback="true"]')).toBeVisible();

    // Conteúdo que finge ser PNG passa na checagem do navegador (só tipo/tamanho), mas o servidor inspeciona os bytes e recusa.
    await input.setInputFiles({ name: "falso.png", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)></svg>") });
    await expect(row.getByRole("alert")).toContainText("servidor recusou");
    await expect(row.locator('[data-fallback="true"]')).toBeVisible();

    // PNG válido: o servidor valida os bytes, grava no armazenamento privado e registra; o listener troca o fallback pela foto.
    await input.setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: makePng(240, 180, [200, 120, 60]) });
    await expect(row.getByRole("status").filter({ hasText: "Foto atualizada." })).toBeVisible();
    await expect(row.locator(".photo img")).toHaveAttribute("src", /^blob:/, { timeout: 20000 });
    await expect(row.locator('[data-fallback="true"]')).toHaveCount(0);
  } finally {
    await retireTempProduct(request, admin.idToken, id);
  }
});
