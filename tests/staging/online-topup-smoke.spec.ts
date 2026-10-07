// Smoke DIRIGIDO da recarga online (F18) na homologação (emulador ou aplicação publicada). Sem provedor configurado, prova que a integração ausente aparece INDISPONÍVEL — configuração sem
// meio disponível, criação recusada com 503 sem gravar intenção nem cobrar, tela sem formulário nem botão de simular —, a
// autorização nas rotas novas, a consulta do histórico pelo índice novo e as Rules (intenções fechadas ao cliente).
// NÃO prova: criação de cobrança, QR, cartão, conciliação depois de timeout ou qualquer provedor real (sem adapter/sandbox);
// isso só existe no emulador com provedor roteirizado/demonstração (tests/integration/topup-intents-api.test.ts, e2e).
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest, newKey } from "./helpers";
import { TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
let fam: Family;
let other: Family;
/** HML com o sandbox do Mercado Pago configurado: a parte "indisponível" não se aplica (coberta por online-topup-sandbox.spec.ts). */
let configured = false;

type Json = Record<string, unknown> & { error?: string };
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: user ? bearer(user.idToken) : {}, data });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
const pix = (studentId: string) => ({ key: newKey("hml-otp"), studentId, amountCents: 5000, channel: "pix" });

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-otp-${tag}`);
  other = await createFamily(request, `hml-otp-b-${tag}`);
  const cfg = await call(request, fam.guardian, "GET", "/api/topups/online/config");
  configured = cfg.body.providerEnv != null;
});
const card = (over: Record<string, unknown> = {}) => ({ installments: 1, cardToken: ["tok", "hml", "0000001"].join("_"), paymentMethodId: "visa", payer: { email: "pagador@example.test", identification: { type: "CPF", number: "12345678909" } }, ...over });

test("integração ausente: os dois meios indisponíveis; criar recarga dá 503 sem gravar nada; anônimo 401", async ({ request }) => {
  test.skip(configured, "sandbox configurado nesta homologação: ver online-topup-sandbox.spec.ts");
  const cfg = await call(request, fam.guardian, "GET", "/api/topups/online/config");
  expect(cfg.status).toBe(200);
  expect(cfg.body).toMatchObject({ pix: { available: false }, card: { available: false, installments: 1 } });
  expect((await call(request, null, "POST", "/api/topups/online", pix(fam.studentId))).status).toBe(401);
  for (const body of [pix(fam.studentId), { ...pix(fam.studentId), channel: "card", ...card() }]) {
    const r = await call(request, fam.guardian, "POST", "/api/topups/online", body);
    expect([r.status, r.body.error]).toEqual([503, "payment_unavailable"]);
  }
  const list = await call(request, fam.guardian, "GET", `/api/topups/online?studentId=${fam.studentId}`);
  expect(list).toMatchObject({ status: 200, body: { intents: [] } }); // consulta pelo índice topupIntents (studentId, createdAt)
});

test("validação e autorização: cartão com parcelas/número recusado (400); outra família 403 no histórico; intenção inexistente 404", async ({ request }) => {
  for (const bad of [{ ...pix(fam.studentId), channel: "card", ...card({ installments: 2 }) }, { ...pix(fam.studentId), channel: "card", ...card({ cvv: "123" }) }, { ...pix(fam.studentId), cardNumber: "4111111111111111" }, { ...pix(fam.studentId), amountCents: 50.5 }]) {
    expect((await call(request, fam.guardian, "POST", "/api/topups/online", bad)).status).toBe(400);
  }
  expect((await call(request, other.guardian, "GET", `/api/topups/online?studentId=${fam.studentId}`)).status).toBe(403);
  expect((await call(request, fam.guardian, "GET", "/api/topups/online/tpi_00000000000000000000")).status).toBe(404);
  expect((await call(request, fam.guardian, "POST", "/api/topups/online/tpi_00000000000000000000/reconcile", {})).status).toBe(404);
});

test("Rules publicadas: intenções de recarga fechadas ao cliente (leitura e escrita)", async () => {
  for (const [label, token] of [["responsável", fam.guardian.idToken], ["administração", fam.admin.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", "topupIntents/tpi_00000000000000000000")).status, `${label}: leitura`).toBe(403);
    expect((await fsRequest(token, "PATCH", "topupIntents/tpi_hml_x", { studentId: { stringValue: fam.studentId }, status: { stringValue: "awaiting_payment" } })).status, `${label}: escrita`).toBe(403);
  }
});

test("tela publicada: recarga online indisponível, sem formulário nem botão de simular pagamento", async ({ page }) => {
  test.skip(configured, "sandbox configurado nesta homologação: ver online-topup-sandbox.spec.ts");
  await page.goto("/portal/carteira/recarga");
  await page.getByLabel("Email").fill(fam.guardian.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("topup-unavailable")).toContainText("secretaria", { timeout: 30000 });
  await expect(page.getByTestId("online-topup-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /simular|gerar pix|pagar/i })).toHaveCount(0);
});
