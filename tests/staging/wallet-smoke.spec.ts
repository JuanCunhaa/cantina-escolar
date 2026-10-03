// Smoke DIRIGIDO da carteira na homologação (emulador ou aplicação publicada), SEM crédito artificial: carteiras novas
// (saldo 0, versão 0), recusas do servidor, isolamento pelas rotas e pelas Security Rules publicadas, arquivamento com
// saldo zero e a tela. Movimentação positiva de saldo NÃO é testada aqui (não há recarga real até F17–F19 e este projeto
// não recebe fixture de saldo). Estrutura criada pelas próprias rotas de administração; contas efêmeras saem no teardown.
import { expect, test } from "@playwright/test";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { bearer, fsRequest, newKey } from "./helpers";

const tag = Math.random().toString(36).slice(2, 7);
let admin: TestUser;
let famA: TestUser;
let famB: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let alfa = "";
let beta = "";
let gama = ""; // da família B
let delta = ""; // da família A, para arquivar com saldo zero
const names: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  [admin, famA, famB, cantina, secretaria] = await Promise.all([
    createTestUser("hml-wadm", "admin"),
    createTestUser("hml-wfama", "guardian"),
    createTestUser("hml-wfamb", "guardian"),
    createTestUser("hml-wcant", "cantina"),
    createTestUser("hml-wsec", "secretaria"),
  ]);
  const post = async (url: string, data: Record<string, unknown>) => {
    const response = await request.post(url, { headers: bearer(admin.idToken), data });
    expect(response.status(), `${url} ${JSON.stringify(data).slice(0, 80)}`).toBe(200);
    return (await response.json()) as Record<string, string>;
  };
  const classId = (await post("/api/school", { key: newKey("cls"), action: "create", kind: "class", name: `Cart ${tag}` })).id!;
  const shiftId = (await post("/api/school", { key: newKey("shf"), action: "create", kind: "shift", name: `Turno cart ${tag}` })).id!;
  const student = async (label: string, n: number) => {
    const name = `${label} ${tag}`;
    const id = (await post("/api/students", { key: newKey("stu"), action: "create", enrollment: `W${tag}${n}`, name, classId, shiftId })).studentId!;
    names[id] = name;
    return id;
  };
  alfa = await student("Alfa", 1);
  beta = await student("Beta", 2);
  gama = await student("Gama", 3);
  delta = await student("Delta", 4);
  for (const id of [alfa, beta, delta]) await post("/api/links", { key: newKey("lnk"), action: "add", studentId: id, guardianEmail: famA.email, reason: "Homologação" });
  await post("/api/links", { key: newKey("lnk"), action: "add", studentId: gama, guardianEmail: famB.email, reason: "Homologação" });
});

const get = (request: import("@playwright/test").APIRequestContext, user: TestUser | null, id: string) =>
  request.get(`/api/wallets?studentId=${id}`, { headers: user ? bearer(user.idToken) : {} });
const transfer = (request: import("@playwright/test").APIRequestContext, user: TestUser | null, from: string, to: string, amountCents: number, key: string = newKey("trf")) =>
  request.post("/api/wallets/transfer", { headers: user ? bearer(user.idToken) : {}, data: { key, fromStudentId: from, toStudentId: to, amountCents } });

test("API: carteiras novas têm saldo 0 e versão 0; leem só o responsável vinculado e a administração (A01/A33)", async ({ request }) => {
  for (const id of [alfa, beta]) expect(await (await get(request, famA, id)).json()).toMatchObject({ balanceCents: 0, version: 0, entries: [] });
  expect((await get(request, admin, alfa)).status()).toBe(200);
  for (const user of [famB, cantina, secretaria]) expect((await get(request, user, alfa)).status()).toBe(403);
  expect((await get(request, famA, gama)).status()).toBe(403);
  expect((await get(request, null, alfa)).status()).toBe(401);
});

test("API: transferência sem saldo é recusada pelo servidor (409) sem escrever nada; entradas inválidas, papéis e outra família negados (A03/A18/A33)", async ({ request }) => {
  const refused = await transfer(request, famA, alfa, beta, 1);
  expect([refused.status(), await refused.json()]).toEqual([409, { error: "insufficient_balance" }]);
  expect((await transfer(request, famA, alfa, alfa, 100)).status()).toBe(400);
  expect((await transfer(request, famA, alfa, beta, 0)).status()).toBe(400);
  expect((await transfer(request, famA, alfa, beta, 1.5)).status()).toBe(400);
  for (const user of [famB, admin, cantina, secretaria]) expect((await transfer(request, user, alfa, beta, 100)).status(), "papel/família sem vínculo").toBe(403);
  expect((await transfer(request, famA, alfa, gama, 100)).status()).toBe(403); // destino de outra família
  expect((await transfer(request, null, alfa, beta, 100)).status()).toBe(401);
  // Nada foi escrito: versão 0, sem movimento, e a reconciliação da administração fecha.
  for (const id of [alfa, beta, gama]) {
    const wallet = (await (await get(request, admin, id)).json()) as { balanceCents: number; version: number };
    expect(wallet).toMatchObject({ balanceCents: 0, version: 0 });
    const rec = await request.get(`/api/wallets/reconcile?studentId=${id}`, { headers: bearer(admin.idToken) });
    expect(await rec.json()).toMatchObject({ ok: true, entryCount: 0, problems: [] });
  }
  expect((await request.get(`/api/wallets/reconcile?studentId=${alfa}`, { headers: bearer(famA.idToken) })).status()).toBe(403);
});

test("Rules publicadas: o responsável vinculado lê a própria carteira e extrato; outra família, administração e anônimo não; ninguém escreve (A33)", async () => {
  // Carteira sem movimento = documento inexistente: permitido pela regra (404), negado a quem não tem vínculo (403).
  expect((await fsRequest(famA.idToken, "GET", `wallets/${alfa}`)).status).toBe(404);
  expect((await fsRequest(famA.idToken, "GET", `wallets/${alfa}/entries`)).status).toBe(200);
  for (const [label, token] of [["outra família", famB.idToken], ["administração", admin.idToken], ["cantina", cantina.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", `wallets/${alfa}`)).status, `${label}: documento`).toBe(403);
    expect((await fsRequest(token, "GET", `wallets/${alfa}/entries`)).status, `${label}: extrato`).toBe(403);
  }
  expect((await fsRequest(famA.idToken, "GET", "wallets")).status).toBe(403);
  expect((await fsRequest(famA.idToken, "GET", "walletTransfers")).status).toBe(403);
  const int = (value: number) => ({ integerValue: String(value) });
  expect((await fsRequest(famA.idToken, "PATCH", `wallets/${alfa}`, { balanceCents: int(999999), version: int(1) })).status).toBe(403);
  expect((await fsRequest(famA.idToken, "PATCH", `wallets/${alfa}/entries/x`, { amountCents: int(100) })).status).toBe(403);
  expect((await fsRequest(famA.idToken, "PATCH", `wallets/${beta}`, { balanceCents: int(1) })).status).toBe(403);
});

test("arquivar aluno com saldo zero é permitido; arquivado não recebe nem envia transferência; reativar é auditado e libera de novo", async ({ request }) => {
  const update = (status: "active" | "inactive") =>
    request.post("/api/students", { headers: bearer(admin.idToken), data: { key: newKey("upd"), action: "update", studentId: delta, status, reason: status === "inactive" ? "Smoke: saída" : "Smoke: reativação" } });
  expect((await update("inactive")).status()).toBe(200);
  const blocked = await transfer(request, famA, alfa, delta, 100);
  expect([blocked.status(), await blocked.json()]).toEqual([409, { error: "student_inactive" }]);
  expect((await update("active")).status()).toBe(200);
  const refused = await transfer(request, famA, alfa, delta, 100); // ativo de novo: chega à regra de saldo
  expect([refused.status(), await refused.json()]).toEqual([409, { error: "insufficient_balance" }]);
});

test("tela publicada: carteiras e total em R$ 0,00, leitura em tempo real e recusa por saldo insuficiente sem parecer falha de leitura", async ({ page }) => {
  await page.goto("/portal/carteira");
  await page.getByLabel("Email").fill(famA.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  const card = (id: string) => page.locator(`[data-testid="wallet-student"][data-student="${id}"]`);
  await expect(card(alfa)).toBeVisible({ timeout: 30000 });
  await expect(card(beta)).toBeVisible();
  await expect(card(alfa).getByTestId("wallet-balance")).toContainText("R$ 0,00");
  await expect(page.getByTestId("wallet-total")).toContainText("R$ 0,00");
  await expect(card(gama)).toHaveCount(0);
  // Leitura em tempo real (listener com as Rules publicadas), timeout padrão: observação registrada, não folga.
  await expect(card(alfa).getByTestId("wallet-reading")).toHaveAttribute("data-sync", "live");

  await page.locator("#transfer-from").selectOption({ label: names[alfa]! });
  await page.locator("#transfer-to").selectOption({ label: names[beta]! });
  await page.locator("#transfer-amount").fill("1,00");
  await page.getByRole("button", { name: "Transferir" }).click();
  await expect(page.getByTestId("transfer-status")).toHaveAttribute("data-phase", "refused");
  await expect(page.getByTestId("transfer-status")).toContainText("Saldo insuficiente");
  await expect(card(alfa).getByTestId("wallet-balance")).toContainText("R$ 0,00");
});
