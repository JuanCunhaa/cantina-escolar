import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

const tag = Math.random().toString(36).slice(2, 7);
let n = 0;

async function login(page: Page, path: string, email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

type Family = { ana: { id: string; name: string }; bia: { id: string; name: string } };

/** Dois alunos ativos vinculados aos responsáveis informados, com saldo inicial por FIXTURE (recarga real é F17–F19). */
async function family(guardians: TestUser[], anaCents: number, biaCents: number): Promise<Family> {
  const make = async (label: string, cents: number) => {
    const id = `stu_${tag}_${label}_${++n}`;
    const name = `${label} ${tag}${n}`;
    await seedStudentAccess({ studentId: id, name, guardianUids: guardians.map((g) => g.uid) });
    if (cents > 0) await fundDemoWallet(targetFromEnv(), id, cents);
    return { id, name };
  };
  return { ana: await make("Ana", anaCents), bia: await make("Bia", biaCents) };
}

const card = (page: Page, id: string): Locator => page.locator(`[data-testid="wallet-student"][data-student="${id}"]`);
const balance = (page: Page, id: string) => card(page, id).getByTestId("wallet-balance");
const status = (page: Page) => page.getByTestId("transfer-status");

async function openWallet(page: Page, user: TestUser, f: Family) {
  await login(page, "/portal/carteira", user.email);
  await expect(card(page, f.ana.id)).toBeVisible({ timeout: 20000 });
  await expect(card(page, f.bia.id)).toBeVisible();
}

async function fillTransfer(page: Page, f: Family, amount: string) {
  await page.locator("#transfer-from").selectOption({ label: f.ana.name });
  await page.locator("#transfer-to").selectOption({ label: f.bia.name });
  await page.locator("#transfer-amount").fill(amount);
}

/** Verificação adicional pelo servidor (API autenticada) e pelo Admin/emulador, independente do que a tela mostra. */
async function serverWallet(request: APIRequestContext, token: string, id: string) {
  const response = await request.get(`/api/wallets?studentId=${id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  return (await response.json()) as { balanceCents: number; version: number; entries: { type: string; amountCents: number }[] };
}
async function reconciled(request: APIRequestContext, admin: TestUser, id: string) {
  const response = await request.get(`/api/wallets/reconcile?studentId=${id}`, { headers: { authorization: `Bearer ${admin.idToken}` } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, problems: [] });
}
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await warmRoutes(request, { post: ["/api/wallets/transfer"], get: ["/portal/carteira", "/api/wallets", "/api/wallets/reconcile"] });
});

test.describe("carteira — comportamento da interface", () => {
  test("saldos individuais, total consolidado e transferência confirmada pelo servidor (A01/A03)", async ({ page, request }) => {
    const admin = await createTestUser("e2e-w-adm", "admin");
    const guardian = await createTestUser("e2e-w-resp", "guardian");
    const f = await family([guardian], 5000, 2000);
    await openWallet(page, guardian, f);
    await expect(balance(page, f.ana.id)).toContainText("R$ 50,00");
    await expect(balance(page, f.bia.id)).toContainText("R$ 20,00");
    await expect(page.getByTestId("wallet-total")).toContainText("R$ 70,00");

    await fillTransfer(page, f, "12,50");
    await page.getByRole("button", { name: "Transferir" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed");
    await expect(status(page)).toContainText("Transferência confirmada pelo servidor");
    await expect(balance(page, f.ana.id)).toContainText("R$ 37,50");
    await expect(balance(page, f.bia.id)).toContainText("R$ 32,50");
    await expect(page.getByTestId("wallet-total")).toContainText("R$ 70,00"); // total conservado

    await card(page, f.ana.id).getByText("Extrato").click();
    await expect(card(page, f.ana.id).getByRole("cell", { name: "Transferência enviada" })).toBeVisible();
    await expect(card(page, f.bia.id).getByText("Extrato")).toBeVisible();

    // Verificação adicional por API e Admin: estado financeiro conferido fora da tela.
    expect(await serverWallet(request, guardian.idToken, f.ana.id)).toMatchObject({ balanceCents: 3750, version: 2 });
    expect(await serverWallet(request, guardian.idToken, f.bia.id)).toMatchObject({ balanceCents: 3250, version: 2 });
    await reconciled(request, admin, f.ana.id);
    await reconciled(request, admin, f.bia.id);
  });

  test("clique duplo não transfere duas vezes (A17)", async ({ page, request }) => {
    const guardian = await createTestUser("e2e-w-dbl", "guardian");
    const f = await family([guardian], 5000, 0);
    await openWallet(page, guardian, f);
    await fillTransfer(page, f, "10,00");
    await page.getByRole("button", { name: "Transferir" }).dblclick();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed");
    await expect(balance(page, f.ana.id)).toContainText("R$ 40,00");
    expect(await serverWallet(request, guardian.idToken, f.ana.id)).toMatchObject({ balanceCents: 4000, version: 2 });
    expect(await serverWallet(request, guardian.idToken, f.bia.id)).toMatchObject({ balanceCents: 1000, version: 1 });
  });

  test("saldo insuficiente: a recusa do servidor é mostrada e nada muda (A18)", async ({ page, request }) => {
    const guardian = await createTestUser("e2e-w-ins", "guardian");
    const f = await family([guardian], 1000, 0);
    await openWallet(page, guardian, f);
    await fillTransfer(page, f, "10,01");
    await page.getByRole("button", { name: "Transferir" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "refused");
    await expect(status(page)).toContainText("Saldo insuficiente");
    await expect(balance(page, f.ana.id)).toContainText("R$ 10,00");
    expect(await serverWallet(request, guardian.idToken, f.ana.id)).toMatchObject({ balanceCents: 1000, version: 1 });
    // Valor inválido nem chega ao servidor.
    await page.locator("#transfer-amount").fill("0");
    await page.getByRole("button", { name: "Transferir" }).click();
    await expect(status(page)).toContainText("valor em reais");
  });

  test("resposta perdida depois do commit: a interface repete a MESMA operação e confirma sem cobrar duas vezes", async ({ page, request }) => {
    const guardian = await createTestUser("e2e-w-lost", "guardian");
    const f = await family([guardian], 5000, 0);
    await openWallet(page, guardian, f);
    let calls = 0;
    await page.route("**/api/wallets/transfer", async (route) => {
      calls++;
      if (calls === 1) {
        await route.fetch(); // o servidor confirma e grava...
        await route.abort("failed"); // ...mas a resposta nunca chega ao navegador
      } else await route.continue();
    });
    await fillTransfer(page, f, "7,00");
    await page.getByRole("button", { name: "Transferir" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed");
    await expect(status(page)).toContainText("já tinha sido concluída");
    expect(calls).toBe(2);
    await expect(balance(page, f.ana.id)).toContainText("R$ 43,00");
    expect(await serverWallet(request, guardian.idToken, f.ana.id)).toMatchObject({ balanceCents: 4300, version: 2 });
    expect(await serverWallet(request, guardian.idToken, f.bia.id)).toMatchObject({ balanceCents: 700, version: 1 });
  });

  test("resultado incerto persistente aparece como INCERTO (não como falha), trava o formulário e a verificação confirma sem repetir", async ({ page, request }) => {
    const guardian = await createTestUser("e2e-w-unc", "guardian");
    const f = await family([guardian], 5000, 0);
    await openWallet(page, guardian, f);
    let calls = 0;
    await page.route("**/api/wallets/transfer", async (route) => {
      calls++;
      if (calls === 1) await route.fetch(); // só a primeira chega ao servidor e confirma
      await route.abort("failed");
    });
    await fillTransfer(page, f, "9,00");
    await page.getByRole("button", { name: "Transferir" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "uncertain");
    await expect(status(page)).toContainText("Ainda não sabemos");
    await expect(page.getByText("Transferência confirmada")).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: "Saldo insuficiente" })).toHaveCount(0);
    await expect(page.locator("#transfer-amount")).toBeDisabled(); // não dá para virar outra transferência
    expect(calls).toBe(3);

    await page.unroute("**/api/wallets/transfer");
    await page.getByRole("button", { name: "Verificar resultado" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed");
    await expect(status(page)).toContainText("já tinha sido concluída");
    await expect(balance(page, f.ana.id)).toContainText("R$ 41,00");
    expect(await serverWallet(request, guardian.idToken, f.ana.id)).toMatchObject({ balanceCents: 4100, version: 2 });
  });

  test("com a leitura em tempo real indisponível, o resultado confirmado aparece da resposta do servidor e fica marcado como atualizando (A34)", async ({ browser, request }) => {
    const guardian = await createTestUser("e2e-w-nolisten", "guardian");
    const f = await family([guardian], 5000, 2000);
    const context = await browser.newContext();
    const page = await context.newPage();
    // Bloqueia só o registro dos alvos da carteira no canal do Firestore (o perfil de sessão segue funcionando).
    await context.route("**/google.firestore.v1.Firestore/Listen/**", async (route) => {
      const body = decodeURIComponent(route.request().postData() ?? "");
      if (body.includes("/documents/wallets")) await route.abort("failed");
      else await route.continue();
    });
    await openWallet(page, guardian, f);
    await expect(balance(page, f.ana.id)).toContainText("R$ 50,00"); // carga inicial pelo servidor, sem listener
    await fillTransfer(page, f, "12,50");
    await page.getByRole("button", { name: "Transferir" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed");
    await expect(balance(page, f.ana.id)).toContainText("R$ 37,50");
    await expect(balance(page, f.bia.id)).toContainText("R$ 32,50");
    await expect(page.getByTestId("wallet-total")).toContainText("R$ 70,00");
    await expect(card(page, f.ana.id).getByTestId("wallet-reading")).not.toHaveAttribute("data-sync", "live");
    await expect(status(page)).not.toHaveAttribute("data-phase", "refused");
    await expect(page.locator("#conteudo").getByRole("alert")).toHaveCount(0); // nada parece falha
    expect(await serverWallet(request, guardian.idToken, f.ana.id)).toMatchObject({ balanceCents: 3750, version: 2 });
    await context.close();
  });

  test("isolamento: outra família não vê alunos nem carteiras, a API a nega e o logout não deixa dado na tela (A33/A34)", async ({ page, request }) => {
    const owner = await createTestUser("e2e-w-own", "guardian");
    const stranger = await createTestUser("e2e-w-out", "guardian");
    const f = await family([owner], 5000, 2000);
    await openWallet(page, owner, f);
    await expect(balance(page, f.ana.id)).toContainText("R$ 50,00");
    await page.getByRole("button", { name: "Sair", exact: true }).click();
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
    await expect(page.getByTestId("wallet-balance")).toHaveCount(0);

    await login(page, "/portal/carteira", stranger.email);
    await expect(page.getByText("Nenhum aluno vinculado")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("wallet-student")).toHaveCount(0);
    await expect(page.getByText(f.ana.name)).toHaveCount(0);

    const headers = { authorization: `Bearer ${stranger.idToken}` };
    expect((await request.get(`/api/wallets?studentId=${f.ana.id}`, { headers })).status()).toBe(403);
    const attempt = await request.post("/api/wallets/transfer", { headers, data: { key: `k${tag}${n}abcdefgh`, fromStudentId: f.ana.id, toStudentId: f.bia.id, amountCents: 100 } });
    expect(attempt.status()).toBe(403);
    expect(await serverWallet(request, owner.idToken, f.ana.id)).toMatchObject({ balanceCents: 5000, version: 1 });
  });
});

/**
 * PROPAGAÇÃO ENTRE SESSÕES (listener) — registrada À PARTE do comportamento da interface acima. Aqui só se observa se a
 * alteração feita numa sessão chega à outra pelo listener, com o timeout padrão do Playwright (sem folga). No emulador
 * não há o atraso de 24–30 s visto na homologação (docs/status/listener-delay-investigation.md); este teste não
 * representa a homologação.
 */
test.describe("carteira — propagação entre sessões pelo listener", () => {
  async function session(browser: Browser, user: TestUser, f: Family) {
    const page = await (await browser.newContext()).newPage();
    await openWallet(page, user, f);
    return page;
  }

  test("a transferência feita por um responsável chega ao outro responsável sem recarregar", async ({ browser }) => {
    const g1 = await createTestUser("e2e-w-s1", "guardian");
    const g2 = await createTestUser("e2e-w-s2", "guardian");
    const f = await family([g1, g2], 5000, 2000);
    const p1 = await session(browser, g1, f);
    const p2 = await session(browser, g2, f);
    await expect(balance(p2, f.ana.id)).toContainText("R$ 50,00");
    await expect(card(p2, f.ana.id).getByTestId("wallet-reading")).toHaveAttribute("data-sync", "live");

    await fillTransfer(p1, f, "12,50");
    await p1.getByRole("button", { name: "Transferir" }).click();
    await expect(status(p1)).toHaveAttribute("data-phase", "confirmed");
    await expect(balance(p1, f.ana.id)).toContainText("R$ 37,50"); // imediato, pela resposta

    await expect(balance(p2, f.ana.id)).toContainText("R$ 37,50"); // propagação pelo listener, timeout padrão
    await expect(balance(p2, f.bia.id)).toContainText("R$ 32,50");
    await expect(card(p1, f.ana.id).getByTestId("wallet-reading")).toHaveAttribute("data-sync", "live");
  });
});
