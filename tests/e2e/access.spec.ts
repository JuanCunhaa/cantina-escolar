import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { seedDemoCatalog, DEFAULT_TARGET } from "../../scripts/lib/demo-seed.ts";
import { isCloud, seedCloudCatalog } from "../helpers/cloud.ts";

async function login(page: Page, path: string, email: string, password: string = TEST_PASSWORD) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

/** Comando de administração pelo servidor Next (mesmo caminho da API real). */
async function changeAccess(request: APIRequestContext, admin: TestUser, body: Record<string, unknown>) {
  const response = await request.post("/api/admin/users", {
    headers: { authorization: `Bearer ${admin.idToken}` },
    data: { key: crypto.randomUUID(), reason: "Prova e2e de acesso", ...body },
  });
  expect(response.status()).toBe(200);
}

test.beforeAll(async () => {
  if (isCloud()) await seedCloudCatalog();
  else await seedDemoCatalog(DEFAULT_TARGET);
});

test("login e recuperação: mensagens genéricas, sem revelar se o email existe (A33)", async ({ page }) => {
  const user = await createTestUser("e2e-login", "guardian");
  await page.goto("/portal");

  // Erro de senha e de conta inexistente produzem a mesma mensagem.
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Senha").fill("senha-errada-999");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.locator("#conteudo").getByRole("alert")).toHaveText("Email ou senha inválidos.");
  await page.getByLabel("Email").fill("ninguem-existe@example.test");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.locator("#conteudo").getByRole("alert")).toHaveText("Email ou senha inválidos.");

  // Recuperação: email cadastrado e desconhecido recebem a mesma resposta.
  await page.getByRole("button", { name: "Esqueci minha senha" }).click();
  await expect(page.getByRole("heading", { name: "Recuperar senha" })).toBeVisible();
  await expect(page.getByLabel("Senha", { exact: true })).toHaveCount(0);
  // Em homologação real a recuperação de conta existente enviaria e-mail de verdade (fixture sem caixa): só o desconhecido.
  for (const email of isCloud() ? ["ninguem-existe@example.test"] : [user.email, "ninguem-existe@example.test"]) {
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Enviar instruções" }).click();
    await expect(page.getByRole("status")).toContainText("Se este email estiver cadastrado");
  }
  await page.getByRole("button", { name: "Voltar ao login" }).click();
  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();

  // Login correto entra na área do papel.
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Portal da família" })).toBeVisible({ timeout: 20000 });
});

test("conta autenticada sem perfil de acesso não recebe nada e pode sair (A30/A33)", async ({ page }) => {
  const user = await createTestUser("e2e-semperfil");
  await login(page, "/portal/cardapio", user.email);
  await expect(page.getByRole("heading", { name: "Acesso ainda não liberado" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navegação principal" })).toHaveCount(0);
  await expect(page.getByTestId("product")).toHaveCount(0);
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
});

test("aluno com login vai ao portal e não alcança a operação (A30)", async ({ page }) => {
  const user = await createTestUser("e2e-aluno", "student");
  await login(page, "/operacao", user.email);
  await expect(page.getByRole("heading", { name: "Área indisponível para o seu perfil" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("Aluno", { exact: false }).first()).toBeVisible();
  await expect(async () => {
    await page.getByRole("link", { name: "Ir para a minha área" }).click({ timeout: 2000 });
    await expect(page).toHaveURL(/\/portal$/, { timeout: 4000 });
  }).toPass({ timeout: 30000 });
  await expect(page.getByRole("heading", { name: "Portal da família" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("Carteira (em breve)")).toHaveCount(0); // item só do responsável
});

test("revogação ao vivo: rebaixar muda a tela; desativar encerra a sessão (A34)", async ({ browser, request }) => {
  const admin = await createTestUser("e2e-adm", "admin");
  const staff = await createTestUser("e2e-func", "cantina");
  const page = await (await browser.newContext()).newPage();
  await login(page, "/operacao/produtos", staff.email);
  await expect(page.getByTestId("photo-row")).toHaveCount(4);

  // Papel retirado: a tela reage sem recarregar (perfil ao vivo) e a lista de produtos some.
  await changeAccess(request, admin, { uid: staff.uid, role: "guardian" });
  await expect(page.getByRole("heading", { name: "Área indisponível para o seu perfil" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("photo-row")).toHaveCount(0);

  // Papel devolvido: volta ao normal na mesma sessão, ainda sem novo login.
  await changeAccess(request, admin, { uid: staff.uid, role: "cantina" });
  await expect(page.getByTestId("photo-row")).toHaveCount(4, { timeout: 15000 });

  // Desativada: a sessão local é encerrada e o login informa o motivo.
  await changeAccess(request, admin, { uid: staff.uid, status: "disabled" });
  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Seu acesso foi encerrado")).toBeVisible();
  await expect(page.getByTestId("photo-row")).toHaveCount(0);
  // Nem com a senha correta a conta desativada volta a entrar.
  await page.getByLabel("Email").fill(staff.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.locator("#conteudo").getByRole("alert")).toContainText("encerrado");
});

test("sair de todos os dispositivos: o servidor revoga o token e a sessão local encerra (A33)", async ({ page, request }) => {
  const user = await createTestUser("e2e-sairtudo", "guardian");
  await login(page, "/portal", user.email);
  await expect(page.getByRole("heading", { name: "Portal da família" })).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1100); // revogação tem granularidade de segundos
  await page.getByRole("button", { name: "Sair de todos os dispositivos" }).click();
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible({ timeout: 15000 });
  // Token emitido antes da revogação deixa de valer no servidor.
  const stale = await request.post("/api/session/revoke", { headers: { authorization: `Bearer ${user.idToken}` } });
  expect(stale.status()).toBe(401);
});
