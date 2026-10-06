// Recarga online contra o SANDBOX REAL do Mercado Pago (F18), pela homologação (servidor local de staging ou aplicação
// publicada) com `PAYMENTS_*_PROVIDER=mercadopago` e `MERCADOPAGO_ENV=sandbox`. Sem sandbox configurado, todos os testes são
// PULADOS (e não contam como evidência). Prova, com o provedor de verdade: Pix criado pela nossa API com QR + copia e cola +
// validade, replay sem segunda order, mesma chave no provedor sem segunda order, busca por external_reference (conciliação),
// cartão 1x tokenizado com o cartão de TESTE documentado (aprovado = "em análise"; recusado = falha), tela com o QR e o
// componente oficial do cartão carregado. NÃO prova: confirmação/crédito (F19), webhook, nem pagamento real.
// Credenciais: só de TESTE, lidas de .env.staging.local (ou STAGING_ENV_FILE) e nunca impressas.
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { parseDotenv } from "../../scripts/staging/target.ts";
import { mercadoPagoPix } from "../../src/modules/payments/online/mercadopago.ts";
import { ProviderError } from "../../src/modules/payments/online/provider.ts";
import { bearer, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const MP_API = "https://api.mercadopago.com";
const tag = Math.random().toString(36).slice(2, 7);
let fam: Family;
let sandbox = false;
let publicKey = "";

type Json = Record<string, unknown> & { error?: string };
const call = async (request: APIRequestContext, user: TestUser, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: bearer(user.idToken), data, timeout: 45000 });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};

/** Access token de TESTE do arquivo local de homologação (o mesmo que o servidor usa); nunca registrado. */
function sandboxAccessToken(): string {
  const path = process.env.STAGING_ENV_FILE || ".env.staging.local";
  const file = existsSync(path) ? parseDotenv(readFileSync(path, "utf8")) : {};
  if (file.MERCADOPAGO_ENV?.trim() !== "sandbox") throw new Error("MERCADOPAGO_ENV do arquivo local não é sandbox.");
  return file.MERCADOPAGO_ACCESS_TOKEN?.trim() ?? "";
}

/** Orders do sandbox com esta referência (contagem direta, independente do adapter). */
async function ordersWithReference(reference: string, createdAt: Date) {
  const query = new URLSearchParams({ begin_date: new Date(createdAt.getTime() - 600_000).toISOString(), end_date: new Date(Date.now() + 60_000).toISOString(), external_reference: reference });
  const r = await fetch(`${MP_API}/v1/orders?${query.toString()}`, { headers: { authorization: `Bearer ${sandboxAccessToken()}` } });
  expect(r.status).toBe(200);
  return (((await r.json()) as { data?: { external_reference?: string }[] }).data ?? []).filter((o) => o.external_reference === reference);
}

/** Token de cartão de TESTE (cartões e nomes documentados pelo Mercado Pago para o sandbox), criado só com a chave pública. */
async function testCardToken(holder: "APRO" | "OTHE"): Promise<string> {
  const r = await fetch(`${MP_API}/v1/card_tokens?public_key=${encodeURIComponent(publicKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ card_number: "5031433215406351", security_code: "123", expiration_month: 11, expiration_year: 2030, cardholder: { name: holder, identification: { type: "CPF", number: "12345678909" } } }),
  });
  expect(r.status, "token de cartão de teste").toBe(201);
  return String(((await r.json()) as { id: string }).id);
}

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-mp-${tag}`);
  const cfg = await call(request, fam.guardian, "GET", "/api/topups/online/config");
  sandbox = cfg.body.providerEnv === "sandbox";
  publicKey = String(((cfg.body.card as Json | undefined)?.publicConfig as Json | null | undefined)?.publicKey ?? "");
});
test.beforeEach(() => test.skip(!sandbox, "homologação sem sandbox do Mercado Pago configurado (PAYMENTS_*_PROVIDER/MERCADOPAGO_*)"));

test("sandbox Pix: QR + copia e cola + validade; replay e mesma chave não criam 2ª order; busca por referência acha a order", async ({ request }) => {
  const body = { key: newKey("hml-mp-pix"), studentId: fam.studentId, amountCents: 5000, channel: "pix" };
  const first = await call(request, fam.guardian, "POST", "/api/topups/online", body);
  expect(first.status, String(first.body.error ?? "")).toBeLessThan(300);
  expect(first.body).toMatchObject({ channel: "pix", status: "awaiting_payment", providerMode: "live", credited: false, amountCents: 5000 });
  const pix = first.body.pix as { copyPaste: string; qrImagePngBase64: string | null; expiresAt: string };
  expect(pix.copyPaste).toMatch(/^000201/); // payload EMV do Pix
  expect(pix.qrImagePngBase64?.length ?? 0).toBeGreaterThan(100);
  expect(Date.parse(pix.expiresAt)).toBeGreaterThan(Date.now() + 20 * 60_000);

  const intentId = String(first.body.intentId);
  const createdAt = new Date(String(first.body.createdAt));
  const replay = await call(request, fam.guardian, "POST", "/api/topups/online", body);
  expect(replay.body).toMatchObject({ intentId, replayed: true });

  // Mesma chave direto no provedor (como um reenvio): não pode existir 2ª order.
  const adapter = mercadoPagoPix({ accessToken: sandboxAccessToken(), publicKey: "", env: "sandbox" });
  const again = await adapter
    .createPixCharge({ intentId, idempotencyKey: intentId, externalReference: intentId, amountCents: 5000, currency: "BRL", description: "Recarga de teste", payer: { name: "Teste", email: "x@example.test" }, expiresAt: new Date(Date.now() + 3_600_000) })
    .then(() => null, (e: unknown) => (e instanceof ProviderError ? e.kind : "other"));
  // Provedor devolve a mesma order ou recusa a chave repetida (409 → incerto); nunca recusa definitiva nem nova order.
  expect(again === null || again === "uncertain").toBe(true);
  expect(await ordersWithReference(intentId, createdAt)).toHaveLength(1);

  const found = await adapter.findCharge(intentId, createdAt);
  expect(found?.outcome).toMatch(/^(awaiting_payment|processing)$/);
});

test("sandbox cartão 1x: token de teste aprovado = em análise (sem crédito); titular de recusa = falha; 1 order por intenção", async ({ request }) => {
  const send = async (holder: "APRO" | "OTHE") =>
    call(request, fam.guardian, "POST", "/api/topups/online", {
      key: newKey(`hml-mp-card-${holder}`),
      studentId: fam.studentId,
      amountCents: 2500,
      channel: "card",
      installments: 1,
      cardToken: await testCardToken(holder),
      paymentMethodId: "master",
      payer: { email: "test@testuser.com", identification: { type: "CPF", number: "12345678909" } },
    });
  const ok = await send("APRO");
  expect(ok.status, String(ok.body.error ?? "")).toBeLessThan(300);
  expect(ok.body).toMatchObject({ channel: "card", status: "processing", providerMode: "live", credited: false, pix: null });
  expect(await ordersWithReference(String(ok.body.intentId), new Date(String(ok.body.createdAt)))).toHaveLength(1);

  const declined = await send("OTHE");
  expect(declined.body).toMatchObject({ channel: "card", status: "failed", credited: false });
});

test("tela: aviso de sandbox, Pix com QR e copia e cola no site; cartão abre o componente oficial do Mercado Pago", async ({ page }) => {
  await page.goto("/portal/carteira/recarga");
  await page.getByLabel("Email").fill(fam.guardian.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("topup-sandbox")).toBeVisible({ timeout: 30000 });

  const start = async (amount: string, channel: "pix" | "card") => {
    await page.getByLabel("Aluno").selectOption({ label: fam.studentName });
    await page.getByLabel("Valor (R$)").fill(amount);
    await page.getByTestId(`topup-channel-${channel}`).check();
    await page.getByRole("button", { name: "Revisar" }).click();
    await expect(page.getByTestId("topup-review")).toBeVisible();
  };
  await start("12,34", "pix");
  await page.getByRole("button", { name: "Gerar Pix" }).click();
  const panel = page.getByTestId("topup-intent");
  await expect(panel).toHaveAttribute("data-status", "awaiting_payment", { timeout: 45000 });
  await expect(panel.getByRole("img", { name: "QR Code Pix de R$ 12,34" })).toBeVisible();
  await expect(page.getByTestId("pix-copy")).toHaveValue(/^000201/);
  await expect(page.getByTestId("pix-expiry")).toContainText("Válido até");
  expect(page.url()).toContain("/portal/carteira/recarga"); // sem redirecionamento
  await page.screenshot({ path: "test-results/f18-sandbox-pix.png", fullPage: true });

  await page.goto("/portal/carteira/recarga");
  await expect(page.getByTestId("online-topup-form")).toBeVisible({ timeout: 30000 });
  await start("10", "card");
  await expect(page.getByTestId("mp-card-brick")).toHaveAttribute("data-state", "ready", { timeout: 45000 });
  await expect(page.locator("#mp-card-brick iframe").first()).toBeAttached();
  await page.screenshot({ path: "test-results/f18-sandbox-card-brick.png", fullPage: true });
});
