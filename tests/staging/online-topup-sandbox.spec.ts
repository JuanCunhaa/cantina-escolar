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
import { mercadoPagoCard, mercadoPagoPix } from "../../src/modules/payments/online/mercadopago.ts";
import { ProviderError } from "../../src/modules/payments/online/provider.ts";
import { bearer, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const MP_API = "https://api.mercadopago.com";
const tag = Math.random().toString(36).slice(2, 7);
let fam: Family;
let sandbox = false;
let publicKey = "";
/** Intenções criadas pelos testes de API, reaproveitadas na verificação de "pago no provedor ≠ crédito". */
let pixIntent: { id: string; createdAt: Date } | null = null;
const cardIntents: { id: string; createdAt: Date; expected: "processing" | "declined" }[] = [];

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

/**
 * Orders do sandbox com esta referência (contagem direta, independente do adapter). A busca tem atraso de indexação
 * (medido em 06/10/2026: vazia no instante 0, presente em ≤ 5 s; GET por ID é imediato): aguarda aparecer até 20 s.
 */
async function ordersWithReference(reference: string, createdAt: Date) {
  for (let waited = 0; ; waited += 2000) {
    const query = new URLSearchParams({ begin_date: new Date(createdAt.getTime() - 600_000).toISOString(), end_date: new Date(Date.now() + 60_000).toISOString(), external_reference: reference });
    const r = await fetch(`${MP_API}/v1/orders?${query.toString()}`, { headers: { authorization: `Bearer ${sandboxAccessToken()}` } });
    expect(r.status).toBe(200);
    const found = (((await r.json()) as { data?: { external_reference?: string }[] }).data ?? []).filter((o) => o.external_reference === reference);
    if (found.length > 0 || waited >= 20_000) return found;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** Token de cartão de TESTE (cartão e titulares documentados para a API Orders: Mastercard 5480…, APRO/OTHE), criado só com a chave pública. */
async function testCardToken(holder: "APRO" | "OTHE"): Promise<string> {
  const r = await fetch(`${MP_API}/v1/card_tokens?public_key=${encodeURIComponent(publicKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ card_number: "5480832801033311", security_code: "123", expiration_month: 11, expiration_year: 2030, cardholder: { name: holder, identification: { type: "CPF", number: "12345678909" } } }),
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
  pixIntent = { id: intentId, createdAt };
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
  expect(ok.body, JSON.stringify(ok.body.failure ?? null)).toMatchObject({ channel: "card", status: "processing", providerMode: "live", credited: false, pix: null });
  expect(await ordersWithReference(String(ok.body.intentId), new Date(String(ok.body.createdAt)))).toHaveLength(1);

  const declined = await send("OTHE");
  expect(declined.body).toMatchObject({ channel: "card", status: "failed", credited: false });
  cardIntents.push({ id: String(ok.body.intentId), createdAt: new Date(String(ok.body.createdAt)), expected: "processing" }, { id: String(declined.body.intentId), createdAt: new Date(String(declined.body.createdAt)), expected: "declined" });
});

test("pago no sandbox NÃO credita (F19): Pix aprovado pelo provedor, carteira e livro intactos; conciliação do cartão pelo adapter real", async ({ request }) => {
  test.setTimeout(240_000);
  expect(pixIntent, "depende do teste de Pix").not.toBeNull();
  const pixAdapter = mercadoPagoPix({ accessToken: sandboxAccessToken(), publicKey: "", env: "sandbox" });
  // O sandbox aprova sozinho o Pix do pagador APRO; a order passa a "processed" (mapeada como "em análise").
  await expect.poll(async () => (await pixAdapter.findCharge(pixIntent!.id, pixIntent!.createdAt))?.outcome, { timeout: 180_000, intervals: [5_000] }).toBe("processing");

  const intent = await call(request, fam.guardian, "GET", `/api/topups/online/${pixIntent!.id}`);
  expect(intent.body).toMatchObject({ intentId: pixIntent!.id, credited: false });
  expect(intent.body.status).not.toBe("credited");
  const wallet = await call(request, fam.guardian, "GET", `/api/wallets?studentId=${fam.studentId}`);
  expect(wallet.body).toMatchObject({ balanceCents: 0, entries: [] });
  const ledger = await call(request, fam.admin, "GET", `/api/wallets/reconcile?studentId=${fam.studentId}`);
  expect(ledger.body).toMatchObject({ ok: true, entryCount: 0, problems: [] });

  const cardAdapter = mercadoPagoCard({ accessToken: sandboxAccessToken(), publicKey: "", env: "sandbox" });
  for (const c of cardIntents) {
    await expect.poll(async () => (await cardAdapter.findCharge(c.id, c.createdAt))?.outcome, { timeout: 30_000, intervals: [2_000] }).toBe(c.expected);
  }
});

test("tela: aviso de sandbox, Pix com QR e copia e cola no site; cartão pelo componente oficial, enviado = em análise, sem número/CVV na nossa API", async ({ page }) => {
  await page.goto("/portal/carteira/recarga");
  await page.getByLabel("Email").fill(fam.guardian.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("topup-sandbox")).toBeVisible({ timeout: 30000 });

  const start = async (amount: string, channel: "pix" | "card") => {
    await page.getByTestId("online-topup-form").getByLabel("Aluno").selectOption({ label: fam.studentName });
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
  await expect(page.locator("#mp-card-brick")).toContainText("Cartão de crédito");
  await page.waitForTimeout(1000); // transição de opacidade do componente antes da captura
  await page.screenshot({ path: "test-results/f18-sandbox-card-brick.png", fullPage: true });

  // Envio real pelo componente: número/validade/CVV só nos iframes seguros do Mercado Pago (secure-fields), digitados
  // tecla a tecla (o componente ignora valor preenchido sem eventos de teclado).
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/topups/online") sent.push(r.postData() ?? "");
  });
  const brick = page.locator("#mp-card-brick");
  await page.frameLocator('#mp-card-brick iframe[name="cardNumber"]').locator('input[name="cardNumber"]:not(.hide)').pressSequentially("5480832801033311", { delay: 40 });
  await page.frameLocator('#mp-card-brick iframe[name="expirationDate"]').locator('input[name="expirationDate"]:not(.hide)').pressSequentially("11/30", { delay: 40 });
  await page.frameLocator('#mp-card-brick iframe[name="securityCode"]').locator('input[name="securityCode"]:not(.hide)').pressSequentially("123", { delay: 40 });
  await brick.locator('input[name="HOLDER_NAME"]').fill("APRO");
  await brick.locator('input[name="DOCUMENT"]').fill("12345678909");
  await brick.locator('input[name="EMAIL"]').fill("test@testuser.com");
  await brick.getByRole("button", { name: /pagar/i }).click();
  await expect(panel).toHaveAttribute("data-status", "processing", { timeout: 60000 });
  await expect(page.getByTestId("topup-intent-status")).toContainText(/análise/i);
  expect(sent).toHaveLength(1);
  const body = JSON.parse(sent[0]!) as Record<string, unknown>;
  expect(body).toMatchObject({ channel: "card", installments: 1, amountCents: 1000, paymentMethodId: "master" });
  expect(sent[0]).not.toMatch(/5480832801033311|security_?code|cvv|card_?number|expiration/i);
  await page.screenshot({ path: "test-results/f18-sandbox-card-submitted.png", fullPage: true });
});
