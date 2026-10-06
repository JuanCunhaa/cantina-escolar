import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readDemoDoc } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

// Recarga online pelo responsável (F18), no emulador com o provedor de DEMONSTRAÇÃO (aceito só com APP_ENV=emulator; não
// cobra nem confirma): aluno → valor → meio → revisão → Pix com QR, copia e cola e validade; clique duplo gera UMA cobrança;
// criação incerta conciliada por consulta (e reenvio explícito do MESMO Pix); cartão 1x recusado/em análise; meio
// indisponível sem formulário. Nenhum estado credita a carteira (a confirmação é da F19).

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
let guardian: TestUser;
let counter = 0;
const created: string[] = [];

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
async function student(name: string) {
  const id = `stu_otp_${tag}_${++counter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid] });
  created.push(`students/${id}`, `studentPolicies/${id}`, `guardianStudentLinks/${guardian.uid}_${id}`);
  return { id, name };
}
const walletOf = async (id: string) => Number((await readDemoDoc(targetFromEnv(), `wallets/${id}`))?.balanceCents ?? 0);
async function intentsOf(request: APIRequestContext, id: string) {
  const r = await request.get(`/api/topups/online?studentId=${id}`, { headers: { authorization: `Bearer ${guardian.idToken}` } });
  return ((await r.json()) as { intents: { intentId: string; displayStatus: string; amountCents: number }[] }).intents;
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const panel = (page: Page) => page.getByTestId("topup-intent");

async function start(page: Page, s: { name: string }, amount: string, channel: "pix" | "card" = "pix") {
  await expect(page.getByTestId("online-topup-form")).toBeVisible({ timeout: 30000 });
  await page.getByLabel("Aluno").selectOption({ label: s.name });
  await page.getByLabel("Valor (R$)").fill(amount);
  await page.getByTestId(`topup-channel-${channel}`).check();
  await page.getByRole("button", { name: "Revisar" }).click();
  await expect(page.getByTestId("topup-review")).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  guardian = await createTestUser(`e2e-otp-g-${tag}`, "guardian");
  // Todas as rotas do fluxo (inclusive as das asserções): compilar no meio do teste recarrega a página.
  await warmRoutes(request, {
    post: ["/api/topups/online", "/api/topups/online/tpi_00000000000000000000/reconcile"],
    get: ["/portal/carteira/recarga", "/api/topups/online", "/api/topups/online/config", "/api/topups/online/tpi_00000000000000000000"],
  });
});
test.afterAll(removeCreated);

test.describe("recarga online no portal (F18)", () => {
  test("Pix: revisão, clique duplo gera UMA cobrança, QR + copia e cola + validade, saldo NÃO muda e histórico", async ({ page, request }) => {
    const ana = await student(`Ana Online ${tag}`);
    await student(`Bia Online ${tag}`);
    await login(page, guardian.email, "/portal/carteira/recarga");
    await expect(page.getByRole("heading", { name: "Recarregar carteira" })).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("topup-demo")).toContainText("Nenhum valor é cobrado");
    await start(page, ana, "50");
    const review = page.getByTestId("topup-review");
    await expect(review).toContainText(ana.name);
    await expect(review).toContainText("R$ 50,00");
    await expect(review).toContainText("depois da confirmação do pagamento");
    await review.getByRole("button", { name: "Gerar Pix" }).dblclick();

    await expect(panel(page)).toHaveAttribute("data-status", "awaiting_payment");
    await expect(page.getByTestId("topup-intent-status")).toContainText("Aguardando pagamento");
    await expect(panel(page).getByRole("img", { name: "QR Code Pix de R$ 50,00" })).toBeVisible();
    await expect(page.getByTestId("pix-copy")).toHaveValue(/^DEMONSTRACAO-SEM-COBRANCA-tpi_/);
    await expect(page.getByTestId("pix-expiry")).toContainText("Válido até");
    await expect(page.getByTestId("topup-history").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("topup-history")).toContainText("Aguardando pagamento");

    await page.screenshot({ path: "test-results/f18-pix-1280.png", fullPage: true });
    const intents = await intentsOf(request, ana.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ amountCents: 5000, displayStatus: "awaiting_payment" });
    expect(await walletOf(ana.id)).toBe(0);
  });

  test("criação incerta: conciliação encontra a cobrança; sem cobrança no provedor, só o reenvio EXPLÍCITO do mesmo Pix cria", async ({ page, request }) => {
    const caio = await student(`Caio Online ${tag}`);
    await login(page, guardian.email, "/portal/carteira/recarga");
    await start(page, caio, "13,13"); // demonstração: cria e perde a resposta
    await page.getByRole("button", { name: "Gerar Pix" }).click();
    await expect(page.getByTestId("topup-intent-status")).toContainText("Verificando a cobrança");
    await panel(page).getByRole("button", { name: "Conferir agora" }).click();
    await expect(panel(page)).toHaveAttribute("data-status", "awaiting_payment");
    await expect(page.getByTestId("pix-copy")).toHaveValue(/DEMONSTRACAO/);

    await start(page, caio, "14,14"); // demonstração: falha antes de criar
    await page.getByRole("button", { name: "Gerar Pix" }).click();
    await expect(page.getByTestId("topup-intent-status")).toContainText("Verificando a cobrança");
    await panel(page).getByRole("button", { name: "Conferir agora" }).click();
    await expect(panel(page)).toHaveAttribute("data-status", "creation_uncertain");
    await panel(page).getByRole("button", { name: "Tentar gerar o mesmo Pix" }).click();
    await expect(panel(page)).toHaveAttribute("data-status", "awaiting_payment");

    const intents = await intentsOf(request, caio.id);
    expect(intents.map((i) => i.amountCents).sort()).toEqual([1313, 1414]);
    expect(await walletOf(caio.id)).toBe(0);
  });

  test("cartão 1x (demonstração): recusado e 'em análise' sem crédito; celular sem rolagem lateral", async ({ page, request }) => {
    const davi = await student(`Davi Online ${tag}`);
    await page.setViewportSize({ width: 375, height: 800 });
    await login(page, guardian.email, "/portal/carteira/recarga");
    await start(page, davi, "20", "card");
    await expect(page.getByTestId("topup-review")).toContainText("Cartão de crédito em 1 parcela");
    await page.getByRole("button", { name: "Voltar" }).click();
    await page.getByLabel("Cartão de teste (demonstração)").selectOption("demo_tok_declined");
    await page.getByRole("button", { name: "Revisar" }).click();
    await page.getByRole("button", { name: "Pagar com cartão" }).click();
    await expect(panel(page)).toHaveAttribute("data-status", "failed");
    await expect(panel(page).getByRole("alert")).toContainText("recusado");

    await page.getByLabel("Cartão de teste (demonstração)").selectOption("demo_tok_approved");
    await page.getByLabel("Valor (R$)").fill("30");
    await page.getByRole("button", { name: "Revisar" }).click();
    await page.getByRole("button", { name: "Pagar com cartão" }).click();
    await expect(panel(page)).toHaveAttribute("data-status", "processing");
    await expect(panel(page)).toContainText("em análise");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/f18-cartao-375.png", fullPage: true });
    expect((await intentsOf(request, davi.id)).map((i) => i.displayStatus).sort()).toEqual(["failed", "processing"]);
    expect(await walletOf(davi.id)).toBe(0);
  });

  test("sem provedor configurado: os dois meios aparecem indisponíveis e não há formulário nem botão de simular", async ({ page }) => {
    await student(`Eva Online ${tag}`);
    // A configuração indisponível é provada no servidor (integração: 503 sem gravar); aqui só a tela para essa resposta.
    await page.route("**/api/topups/online/config", (route) => route.fulfill({ json: { pix: { available: false, mode: null }, card: { available: false, mode: null, installments: 1, publicConfig: null } } }));
    await login(page, guardian.email, "/portal/carteira/recarga");
    await expect(page.getByTestId("topup-unavailable")).toContainText("secretaria");
    await expect(page.getByTestId("online-topup-form")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /simular|gerar pix|pagar/i })).toHaveCount(0);
  });
});
