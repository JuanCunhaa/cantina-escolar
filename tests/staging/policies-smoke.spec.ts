// Smoke DIRIGIDO de políticas/limites/bloqueios (F09) na homologação (emulador ou aplicação publicada). Sem dinheiro e
// sem escrita direta no banco: a estrutura nasce das rotas de administração, as políticas das rotas autorizadas, e o
// comprometimento de consumo fica em zero (não há checkout/PDV até F11/F15, então a prova de concorrência e de teto
// exato é do emulador). Aqui: comandos e recusas do servidor, Security Rules publicadas (política, uso e exceções) e a tela.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { bearer, fsRequest, newKey } from "./helpers";

const tag = Math.random().toString(36).slice(2, 7);
let admin: TestUser;
let famA: TestUser;
let famB: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let alfa = "";
let gama = ""; // da família B
let categoryId = "";
let productId = "";

test.describe.configure({ mode: "serial" });

const post = (request: APIRequestContext, user: TestUser | null, url: string, data: Record<string, unknown>) =>
  request.post(url, { headers: user ? bearer(user.idToken) : {}, data });
const policy = (request: APIRequestContext, user: TestUser | null, studentId: string, change: Record<string, unknown>, key: string = newKey("pol")) =>
  post(request, user, "/api/policies", { key, studentId, ...change });
const exception = (request: APIRequestContext, user: TestUser | null, data: Record<string, unknown>) => post(request, user, "/api/policies/exceptions", { key: newKey("exc"), ...data });

/** Datas locais da escola a partir do relógio do servidor de teste (a janela é validada pelo servidor). */
const localDate = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
};

test.beforeAll(async ({ request }) => {
  [admin, famA, famB, cantina, secretaria] = await Promise.all([
    createTestUser("hml-padm", "admin"),
    createTestUser("hml-pfama", "guardian"),
    createTestUser("hml-pfamb", "guardian"),
    createTestUser("hml-pcant", "cantina"),
    createTestUser("hml-psec", "secretaria"),
  ]);
  const create = async (url: string, data: Record<string, unknown>) => {
    const response = await post(request, admin, url, data);
    expect(response.status(), `${url} ${JSON.stringify(data).slice(0, 80)}`).toBe(200);
    return (await response.json()) as Record<string, string>;
  };
  const classId = (await create("/api/school", { key: newKey("cls"), action: "create", kind: "class", name: `Pol ${tag}` })).id!;
  const shiftId = (await create("/api/school", { key: newKey("shf"), action: "create", kind: "shift", name: `Turno pol ${tag}` })).id!;
  alfa = (await create("/api/students", { key: newKey("stu"), action: "create", enrollment: `P${tag}1`, name: `Alfa ${tag}`, classId, shiftId })).studentId!;
  gama = (await create("/api/students", { key: newKey("stu"), action: "create", enrollment: `P${tag}2`, name: `Gama ${tag}`, classId, shiftId })).studentId!;
  await create("/api/links", { key: newKey("lnk"), action: "add", studentId: alfa, guardianEmail: famA.email, reason: "Homologação" });
  await create("/api/links", { key: newKey("lnk"), action: "add", studentId: gama, guardianEmail: famB.email, reason: "Homologação" });
  // Itens do catálogo já existentes (leitura pelas Rules; não cria nem altera catálogo).
  const firstId = async (collection: string) => {
    const listing = await fsRequest(famA.idToken, "GET", `${collection}?pageSize=1`);
    const name = ((listing.body.documents as { name: string }[] | undefined) ?? [])[0]?.name ?? "";
    return name.split("/").pop() ?? "";
  };
  categoryId = await firstId("categories");
  productId = await firstId("products");
  expect(categoryId && productId, "catálogo de homologação com ao menos uma categoria e um produto").toBeTruthy();
});

const intOf = (body: Record<string, unknown>, field: string) => (body.fields as Record<string, { integerValue?: string }> | undefined)?.[field]?.integerValue;

test("API: limites e bloqueios gravados pelo servidor, versão +1, replay idempotente, sem teto = null; compromissos existentes vazios (A02/A09/A10)", async ({ request }) => {
  const key = newKey("pol");
  const body = { dailyLimitCents: 1000, weeklyLimitCents: 4000, blockedCategoryIds: [categoryId], blockedProductIds: [productId] };
  const first = await policy(request, famA, alfa, body, key);
  expect(first.status()).toBe(200);
  expect(await first.json()).toMatchObject({ changed: true, configVersion: 2, appliesTo: "new_purchases_only", existingCommitments: [], policy: { dailyLimitCents: 1000, weeklyLimitCents: 4000 } });
  const again = await policy(request, famA, alfa, body, key);
  expect(await again.json()).toMatchObject({ replayed: true, configVersion: 2 });
  expect((await policy(request, famA, alfa, { ...body, dailyLimitCents: 1001 }, key)).status()).toBe(409); // mesma chave, payload diferente
  // Segundo responsável (administração aqui) altera outro campo sem perder o resto.
  expect((await policy(request, admin, alfa, { allowCounterPurchase: true, expectedConfigVersion: 2 })).status()).toBe(200);
  const read = await fsRequest(famA.idToken, "GET", `studentPolicies/${alfa}`);
  expect(read.status).toBe(200);
  expect([intOf(read.body, "dailyLimitCents"), intOf(read.body, "weeklyLimitCents"), intOf(read.body, "configVersion")]).toEqual(["1000", "4000", "3"]);
  // Remover o teto: null.
  expect((await policy(request, famA, alfa, { weeklyLimitCents: null })).status()).toBe(200);
  expect(intOf((await fsRequest(famA.idToken, "GET", `studentPolicies/${alfa}`)).body, "weeklyLimitCents")).toBeUndefined();
});

test("API: entradas inválidas, item bloqueado inexistente, diário > semanal, versão velha e papéis/família sem vínculo (A02/A33)", async ({ request }) => {
  for (const bad of [{ dailyLimitCents: 0 }, { dailyLimitCents: 12.5 }, { weeklyLimitCents: 99_999_999 }, {}, { blockedProductIds: ["../x"] }]) {
    expect((await policy(request, famA, alfa, bad)).status(), JSON.stringify(bad)).toBe(400);
  }
  expect((await policy(request, famA, alfa, { blockedProductIds: ["prd_inexistente"] })).status()).toBe(404);
  const inverted = await policy(request, famA, alfa, { dailyLimitCents: 5000, weeklyLimitCents: 1000 });
  expect([inverted.status(), await inverted.json()]).toEqual([422, { error: "daily_exceeds_weekly" }]);
  expect((await policy(request, famA, alfa, { dailyLimitCents: 500, expectedConfigVersion: 1 })).status()).toBe(409);
  for (const user of [famB, cantina, secretaria]) expect((await policy(request, user, alfa, { dailyLimitCents: 1 })).status()).toBe(403);
  expect((await policy(request, famA, gama, { dailyLimitCents: 1 })).status()).toBe(403);
  expect((await policy(request, null, alfa, { dailyLimitCents: 1 })).status()).toBe(401);
  expect(intOf((await fsRequest(famA.idToken, "GET", `studentPolicies/${alfa}`)).body, "dailyLimitCents")).toBe("1000"); // nada mudou
});

test("API: exceção de uso único (responsável e administração com motivo), janela de datas, revogação e papéis negados (A09)", async ({ request }) => {
  const date = localDate(1);
  const created = await exception(request, famA, { action: "create", studentId: alfa, consumptionDate: date, maxCents: 650 });
  expect(created.status()).toBe(200);
  const { exceptionId } = (await created.json()) as { exceptionId: string };
  expect((await exception(request, admin, { action: "create", studentId: alfa, consumptionDate: date, maxCents: 650, reason: "curto" })).status()).toBe(422);
  expect((await exception(request, admin, { action: "create", studentId: alfa, consumptionDate: date, maxCents: 650, reason: "Autorização da direção (smoke)" })).status()).toBe(200);
  expect((await exception(request, famA, { action: "create", studentId: alfa, consumptionDate: localDate(9), maxCents: 100 })).status()).toBe(422);
  expect((await exception(request, famA, { action: "create", studentId: alfa, consumptionDate: localDate(-2), maxCents: 100 })).status()).toBe(422);
  for (const user of [famB, cantina, secretaria, null]) {
    expect((await exception(request, user, { action: "create", studentId: alfa, consumptionDate: date, maxCents: 100 })).status()).toBe(user ? 403 : 401);
    expect((await exception(request, user, { action: "revoke", studentId: alfa, exceptionId })).status()).toBe(user ? 403 : 401);
  }
  expect((await exception(request, famA, { action: "revoke", studentId: alfa, exceptionId })).status()).toBe(200);
  const read = await fsRequest(famA.idToken, "GET", `studentPolicies/${alfa}/exceptions/${exceptionId}`);
  expect(read.status).toBe(200);
  expect((read.body.fields as Record<string, { stringValue?: string }>).status?.stringValue).toBe("revoked");
});

test("Rules publicadas: política, uso por data/semana e exceções só para quem tem vínculo/papel; ninguém escreve (A33/A35)", async () => {
  const date = localDate(1);
  // Uso sem compra = documento inexistente: permitido pela regra (404), negado a quem não pode ler (403).
  for (const path of [`studentUsage/${alfa}/days/${date}`, `studentUsage/${alfa}/weeks/${date}`, `studentUsage/${alfa}/days`]) {
    expect((await fsRequest(famA.idToken, "GET", path)).status, `família vinculada ${path}`).toBe(path.endsWith("/days") ? 200 : 404);
    expect((await fsRequest(cantina.idToken, "GET", path)).status, `cantina ${path}`).toBe(path.endsWith("/days") ? 200 : 404);
    for (const [label, token] of [["outra família", famB.idToken], ["secretaria", secretaria.idToken], ["anônimo", null]] as const) {
      expect((await fsRequest(token, "GET", path)).status, `${label} ${path}`).toBe(403);
    }
  }
  expect((await fsRequest(famA.idToken, "GET", `studentPolicies/${alfa}/exceptions`)).status).toBe(200);
  expect((await fsRequest(admin.idToken, "GET", `studentPolicies/${alfa}/exceptions`)).status).toBe(200);
  for (const [label, token] of [["outra família", famB.idToken], ["cantina", cantina.idToken], ["secretaria", secretaria.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", `studentPolicies/${alfa}/exceptions`)).status, `exceções: ${label}`).toBe(403);
  }
  const int = (value: number) => ({ integerValue: String(value) });
  expect((await fsRequest(famA.idToken, "PATCH", `studentUsage/${alfa}/days/${date}`, { committedCents: int(0) })).status).toBe(403);
  expect((await fsRequest(famA.idToken, "PATCH", `studentPolicies/${alfa}`, { dailyLimitCents: int(999999) })).status).toBe(403);
  expect((await fsRequest(famA.idToken, "PATCH", `studentPolicies/${alfa}/exceptions/x`, { maxCents: int(99999) })).status).toBe(403);
  expect((await fsRequest(famB.idToken, "GET", `studentPolicies/${alfa}`)).status).toBe(403);
});

test("tela publicada: painel de limites com comprometimento zerado, bloqueios e sem rolagem horizontal; outra família não vê o aluno (A02/A09/A10)", async ({ page, browser }) => {
  await page.goto("/portal/alunos");
  await page.getByLabel("Email").fill(famA.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  const panel = page.locator(`[data-testid="policy-panel"][data-student="${alfa}"]`);
  await expect(panel).toBeVisible({ timeout: 30000 });
  await expect(panel.getByLabel("Limite diário (R$)")).toHaveValue("10,00");
  await expect(panel.getByLabel("Limite semanal (R$)")).toHaveValue("");
  await expect(panel.locator(`[data-date="${localDate(1)}"]`)).toContainText("R$ 0,00");
  await panel.getByLabel("Limite semanal (R$)").fill("25,00");
  await panel.getByRole("button", { name: "Salvar limites" }).click();
  await expect(panel.getByTestId("policy-message")).toContainText("Limites salvos");
  await expect(panel.getByTestId("existing-commitments")).toHaveCount(0);
  await expect(panel.getByLabel("Limite semanal (R$)")).toHaveValue("25,00");
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `sem rolagem horizontal em ${width}px`).toBe(true);
  }

  const stranger = await browser.newContext();
  const other = await stranger.newPage();
  await other.goto("/portal/alunos");
  await other.getByLabel("Email").fill(famB.email);
  await other.getByLabel("Senha").fill(TEST_PASSWORD);
  await other.getByRole("button", { name: "Entrar" }).click();
  await expect(other.locator(`[data-testid="policy-panel"][data-student="${gama}"]`)).toBeVisible({ timeout: 30000 });
  await expect(other.locator(`[data-testid="policy-panel"][data-student="${alfa}"]`)).toHaveCount(0);
  await stranger.close();
});
