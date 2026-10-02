import { expect, test, type Page } from "@playwright/test";
import { createTestUser } from "../helpers/auth-emulator";
import { makePng, seedDemoCatalog, DEFAULT_TARGET } from "../../scripts/lib/demo-seed.ts";
import { isCloud, seedCloudCatalog } from "../helpers/cloud.ts";

async function login(page: Page, path: string, email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill("senha-fake-123");
  await page.getByRole("button", { name: "Entrar" }).click();
}

test.beforeAll(async () => {
  if (isCloud()) await seedCloudCatalog();
  else await seedDemoCatalog(DEFAULT_TARGET);
});

test("portal: catálogo real (fictício) com fotos, fallback, canal só balcão, turno e total em BRL (A36/A37)", async ({ page }) => {
  const family = await createTestUser("e2e-familia", "guardian");
  await login(page, "/portal/cardapio", family.email);

  await expect(page.getByRole("heading", { name: "Cardápio" })).toBeVisible();
  await expect(page.getByTestId("product")).toHaveCount(4);

  // Três produtos têm foto real servida pelo servidor (bucket privado, blob com o ID token); o quarto cai no fallback discreto.
  const photos = page.locator(".photo img");
  await expect(photos).toHaveCount(3);
  for (const img of await photos.all()) {
    await expect(img).toHaveJSProperty("complete", true);
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await expect(img).toHaveAttribute("alt", /\(exemplo\)/);
    await expect(img).toHaveAttribute("src", /^blob:/); // nunca um endereço direto do bucket
  }
  await expect(page.locator('[data-fallback="true"]')).toHaveCount(1);
  await expect(page.getByRole("img", { name: /Bolo de cenoura.*sem foto/ })).toBeVisible();
  await expect(page.getByText("Só no balcão")).toBeVisible();
  await expect(page.getByText("Só Manhã (exemplo)", { exact: true }).first()).toBeVisible();
  // Produto desativado não aparece para a família; custo/fornecedor nunca chegam à tela.
  await expect(page.getByText("Pipoca (exemplo)")).toHaveCount(0);
  await expect(page.getByText("Fornecedor fictício")).toHaveCount(0);

  // Quantidade e total respondem imediatamente; produto só de balcão não tem controle no portal.
  await page.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" }).click();
  await page.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" }).click();
  await page.getByRole("button", { name: "Aumentar Pão com queijo (exemplo)" }).click();
  await expect(page.getByTestId("summary-total")).toContainText("R$ 15,50");
  await expect(page.getByRole("button", { name: /Aumentar Bolo/ })).toHaveCount(0);
});

test("teclado: pular para o conteúdo, navegação e quantidade sem mouse (A37)", async ({ page }) => {
  const family = await createTestUser("e2e-teclado", "guardian");
  await login(page, "/portal/cardapio", family.email);
  await expect(page.getByTestId("product")).toHaveCount(4);

  // Nova carga (sessão persistida): o foco começa no topo do documento, como para quem chega pelo teclado.
  await page.goto("/portal/cardapio");
  await expect(page.getByTestId("product")).toHaveCount(4);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Pular para o conteúdo" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#conteudo")).toBeFocused();

  const plus = page.getByRole("button", { name: "Aumentar Salada de frutas (exemplo)" });
  await plus.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("summary-total")).toContainText("R$ 10,00");
  // Foco visível: contorno de 3px no elemento focado.
  const outline = await plus.evaluate((el) => getComputedStyle(el).outlineWidth);
  expect(outline).toBe("3px");

  const current = page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Cardápio" });
  await expect(current).toHaveAttribute("aria-current", "page");
});

test("celular: sem rolagem horizontal, alvos de toque e resumo fixo visível (A37)", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await context.newPage();
  const family = await createTestUser("e2e-celular", "guardian");
  await login(page, "/portal/cardapio", family.email);
  await expect(page.getByTestId("product")).toHaveCount(4);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await page.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" }).boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(40);
  expect(box?.height).toBeGreaterThanOrEqual(40);
  await expect(page.getByRole("complementary", { name: "Resumo da seleção" })).toBeInViewport();
  await context.close();
});

test("reduced motion: sem transições e a ação não depende de animação (A37)", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const family = await createTestUser("e2e-movimento", "guardian");
  await login(page, "/portal/cardapio", family.email);
  const plus = page.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" });
  await expect(plus).toBeVisible();
  const duration = await plus.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(duration).toBeLessThan(0.01);
  await plus.click({ timeout: 1000 });
  await expect(page.getByTestId("summary-total")).toContainText("R$ 4,50", { timeout: 1000 });
  await context.close();

  // Sem a preferência, a transição curta (150 ms) existe e também não bloqueia a ação.
  const normal = await (await browser.newContext({ reducedMotion: "no-preference" })).newPage();
  await login(normal, "/portal/cardapio", family.email);
  const button = normal.getByRole("button", { name: "Aumentar Suco de laranja (exemplo)" });
  expect(await button.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))).toBeCloseTo(0.15, 2);
  await button.click({ timeout: 1000 });
  await expect(normal.getByTestId("summary-total")).toContainText("R$ 4,50", { timeout: 1000 });
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

test("operação: funcionário envia foto válida; arquivo inválido e grande demais são recusados (A36)", async ({ page }) => {
  const staff = await createTestUser("e2e-cantina", "cantina");
  await login(page, "/operacao/produtos", staff.email);
  await expect(page.getByTestId("photo-row")).toHaveCount(4);
  await expect(page.locator('[data-fallback="true"]')).toHaveCount(1);

  // Tipo inválido: recusado antes de qualquer envio.
  await page.getByLabel("Enviar foto de Bolo de cenoura (exemplo)").setInputFiles({
    name: "nota.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("não sou imagem"),
  });
  await expect(page.locator("#conteudo").getByRole("alert")).toContainText("JPEG, PNG ou WebP");

  // Acima de 2 MB: recusado.
  await page.getByLabel("Enviar foto de Bolo de cenoura (exemplo)").setInputFiles({
    name: "grande.png",
    mimeType: "image/png",
    buffer: Buffer.concat([makePng(8, 8, [1, 2, 3]), Buffer.alloc(2 * 1024 * 1024)]),
  });
  await expect(page.locator("#conteudo").getByRole("alert")).toContainText("2 MB");
  await expect(page.locator('[data-fallback="true"]')).toHaveCount(1);

  // PNG válido: o servidor valida os bytes, grava no armazenamento privado e registra; o listener troca o fallback pela foto.
  await page.getByLabel("Enviar foto de Bolo de cenoura (exemplo)").setInputFiles({
    name: "bolo.png",
    mimeType: "image/png",
    buffer: makePng(240, 180, [200, 120, 60]),
  });
  await expect(page.getByRole("status").filter({ hasText: "Foto atualizada." })).toBeVisible();
  await expect(page.locator('[data-fallback="true"]')).toHaveCount(0);
  await expect(page.locator(".photo img")).toHaveCount(4);

  // Conteúdo que finge ser PNG passa na checagem do navegador (só tipo/tamanho), mas o servidor inspeciona os bytes e recusa.
  await page.getByLabel("Enviar foto de Suco de laranja (exemplo)").setInputFiles({
    name: "falso.png",
    mimeType: "image/png",
    buffer: Buffer.from("<svg onload=alert(1)></svg>"),
  });
  await expect(page.locator("#conteudo").getByRole("alert")).toContainText("servidor recusou");
});
