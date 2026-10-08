// Confirmação, crédito e reversão da recarga online (F19) contra o SANDBOX REAL do Mercado Pago, pela homologação (servidor local
// de staging × Firestore HML, ou a aplicação publicada na Vercel) com `PAYMENTS_*_PROVIDER=mercadopago` e `MERCADOPAGO_ENV=sandbox`.
// Sem sandbox configurado todos os testes são PULADOS e não contam como evidência. Só contas e recebimentos de TESTE; nenhum
// dinheiro real; o reembolso é pedido à API do sandbox. O que prova, com o provedor de verdade:
//   - Pix aprovado pelo sandbox é confirmado pelo SERVIDOR (consulta da order) e creditado exatamente UMA vez (carteira, livro,
//     intenção, auditoria), por webhook real do Mercado Pago (se a URL estiver cadastrada) ou pela conciliação;
//   - o endpoint recusa assinatura inválida e, com a chave real, não duplica crédito (notificação repetida) nem credita ordem
//     desconhecida ou de outra conta;
//   - reembolso REAL do sandbox vira lançamento negativo (reversão), e com o crédito já consumido abre pendência, bloqueia a
//     carteira e a administração regulariza;
//   - a tela mostra "Crédito lançado" só depois da confirmação do servidor.
// NÃO prova: pagamento real, chargeback (o sandbox não o gera), 3DS, Pix vencido pelo provedor, taxa real/liquidação (F20).
// Credenciais: só de TESTE, lidas de .env.staging.local (ou STAGING_ENV_FILE); nunca impressas. `MERCADOPAGO_WEBHOOK_SECRET` é
// necessário para assinar notificações de teste; `F19_EXPECT_WEBHOOK=1` exige a entrega REAL do Mercado Pago (URL cadastrada).
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { admin as harnessAdmin } from "../../scripts/staging/admin.ts";
import { parseDotenv } from "../../scripts/staging/target.ts";
import { TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { fixtureIds } from "../helpers/catalog-fixtures.ts";
import { adminPost, createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { DEMO_SHIFTS } from "../../scripts/lib/demo-seed.ts";
import { bearer, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const MP_API = "https://api.mercadopago.com";
const tag = Math.random().toString(36).slice(2, 7);
let fam: Family;
let siblingId = "";
let sandbox = false;
let secret = "";

type Json = Record<string, unknown> & { error?: string };
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown, headers: Record<string, string> = {}) => {
  const response = await request.fetch(url, { method, headers: { ...(user ? bearer(user.idToken) : {}), ...headers }, data, timeout: 60000 });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};

function envFile(): Record<string, string> {
  const path = process.env.STAGING_ENV_FILE || ".env.staging.local";
  return existsSync(path) ? parseDotenv(readFileSync(path, "utf8")) : {};
}
const sandboxToken = () => {
  const file = envFile();
  if (file.MERCADOPAGO_ENV?.trim() !== "sandbox") throw new Error("MERCADOPAGO_ENV do arquivo local não é sandbox.");
  return file.MERCADOPAGO_ACCESS_TOKEN?.trim() ?? "";
};

const wallet = async (request: APIRequestContext, studentId = fam.studentId) =>
  (await call(request, fam.guardian, "GET", `/api/wallets?studentId=${studentId}`)).body as unknown as { balanceCents: number; version: number; pendingReversalCents: number; entries: { type: string; amountCents: number }[] };
async function ledgerOk(request: APIRequestContext, studentId = fam.studentId) {
  const r = await call(request, fam.admin, "GET", `/api/wallets/reconcile?studentId=${studentId}`);
  expect(r.body, `reconciliação ${studentId}`).toMatchObject({ ok: true, problems: [] });
  return r.body as unknown as { entryCount: number; balanceCents: number };
}
const intentDoc = async (id: string) => (await harnessAdmin().db.doc(`topupIntents/${id}`).get()).data();

async function createPix(request: APIRequestContext, studentId: string, amountCents: number) {
  const r = await call(request, fam.guardian, "POST", "/api/topups/online", { key: newKey("hml-f19-pix"), studentId, amountCents, channel: "pix" });
  expect(r.status, String(r.body.error ?? "")).toBeLessThan(300);
  expect(r.body).toMatchObject({ status: "awaiting_payment", credited: false, providerMode: "live" });
  return String(r.body.intentId);
}

/** Aguarda o sandbox aprovar o Pix de teste (pagador APRO) e o SERVIDOR confirmar. Nunca aceita crédito antes da confirmação. */
async function waitConfirmed(request: APIRequestContext, intentId: string, timeoutMs = 240_000): Promise<Json> {
  const started = Date.now();
  let last: Json = {};
  while (Date.now() - started < timeoutMs) {
    const r = await call(request, fam.guardian, "POST", `/api/topups/online/${intentId}/reconcile`, {});
    last = r.body;
    expect(r.status, String(r.body.error ?? "")).toBe(200);
    if (r.body.status === "confirmed") return r.body;
    expect(r.body.credited, "crédito antes da confirmação").toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Pix não confirmado em ${timeoutMs / 1000}s (último estado: ${String(last.status)})`);
}

const sign = (dataId: string, ts = String(Date.now()), requestId = randomUUID()) => ({ ts, requestId, signature: `ts=${ts},v1=${createHmac("sha256", secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex")}` });
async function deliver(request: APIRequestContext, orderId: string, over: { badSignature?: boolean; userId?: string; version?: number } = {}) {
  const s = sign(orderId);
  const response = await request.fetch(`/api/webhooks/mercadopago?data.id=${orderId}&type=order`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": s.requestId, "x-signature": over.badSignature ? `ts=${s.ts},v1=${"0".repeat(64)}` : s.signature },
    data: { action: "order.processed", type: "order", live_mode: false, user_id: over.userId ?? "", api_version: "v1", data: { id: orderId, status: "processed", version: over.version ?? 1 } },
    timeout: 60000,
  });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
}

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-f19-${tag}`);
  const cfg = await call(request, fam.guardian, "GET", "/api/topups/online/config");
  sandbox = cfg.body.providerEnv === "sandbox";
  secret = envFile().MERCADOPAGO_WEBHOOK_SECRET?.trim() ?? "";
  if (!sandbox) return;
  const ids = await fixtureIds();
  const sibling = await adminPost(request, fam.admin, "/api/students", { action: "create", enrollment: `F19${tag.toUpperCase()}`, name: `Irmão F19 ${tag} (exemplo)`, classId: ids.classId(), shiftId: ids.shift(DEMO_SHIFTS[0].name) });
  siblingId = String(sibling.studentId);
  await adminPost(request, fam.admin, "/api/links", { action: "add", studentId: siblingId, guardianEmail: fam.guardian.email, reason: "Teste automatizado (fictício)" });
});
test.beforeEach(() => test.skip(!sandbox, "homologação sem sandbox do Mercado Pago configurado (PAYMENTS_*_PROVIDER/MERCADOPAGO_*)"));

let pixIntent = "";
let pixOrder = "";
let accountId = "";

test("Pix aprovado pelo sandbox é confirmado pelo servidor e creditado UMA vez (carteira, livro, intenção, auditoria)", async ({ request }) => {
  test.setTimeout(300_000);
  const before = await wallet(request);
  expect(before).toMatchObject({ balanceCents: 0, version: 0, pendingReversalCents: 0 });
  pixIntent = await createPix(request, fam.studentId, 1234);

  const confirmed = await waitConfirmed(request, pixIntent);
  expect(confirmed).toMatchObject({ status: "confirmed", credited: true, statusLabel: "Crédito lançado", credit: { amountCents: 1234, walletSeq: 1, balanceAfterCents: 1234 } });
  expect(await wallet(request)).toMatchObject({ balanceCents: 1234, version: 1, pendingReversalCents: 0 });
  expect((await wallet(request)).entries.map((e) => [e.type, e.amountCents])).toEqual([["topup", 1234]]);
  expect(await ledgerOk(request)).toMatchObject({ entryCount: 1, balanceCents: 1234 });

  const doc = await intentDoc(pixIntent);
  pixOrder = String((doc?.confirmation as { orderId: string }).orderId);
  accountId = String((doc?.provider as { accountId?: string }).accountId ?? "");
  expect(doc).toMatchObject({ status: "confirmed", fee: { status: "pending", cents: null }, confirmation: { paidCents: 1234, walletSeq: 1 } });
  expect(accountId).toMatch(/^\d+$/);
  const source = String((doc?.confirmation as { source: string }).source);
  test.info().annotations.push({ type: "fonte da confirmação", description: source });
  const credits = await harnessAdmin().db.collection("auditLog").where("target.id", "==", pixIntent).where("action", "==", "topup.online.confirm").get();
  expect(credits.size).toBe(1);

  // Consultas repetidas e concorrentes depois do crédito: nada muda.
  await Promise.all([1, 2, 3, 4].map(() => call(request, fam.guardian, "POST", `/api/topups/online/${pixIntent}/reconcile`, {})));
  expect(await wallet(request)).toMatchObject({ balanceCents: 1234, version: 1 });

  const events = await harnessAdmin().db.collection("paymentEvents").where("orderId", "==", pixOrder).get();
  test.info().annotations.push({ type: "eventos de webhook recebidos do Mercado Pago", description: String(events.size) });
  if (process.env.F19_EXPECT_WEBHOOK === "1") {
    expect(events.size, "nenhum webhook real do Mercado Pago chegou: confira a URL cadastrada, a chave e a proteção da Vercel").toBeGreaterThan(0);
    expect(events.docs.every((d) => d.get("accountId") === accountId && d.get("source") === "webhook")).toBe(true);
  }
});

test("webhook: assinatura inválida recusada; com a chave REAL, a notificação repetida não duplica; order desconhecida ou de outra conta não credita", async ({ request }) => {
  test.skip(!secret, "MERCADOPAGO_WEBHOOK_SECRET ausente no arquivo local: não é possível assinar notificações de teste");
  expect(pixOrder, "depende do teste anterior").not.toBe("");
  const bad = await deliver(request, pixOrder, { badSignature: true });
  expect(bad).toMatchObject({ status: 401, body: { error: "invalid_signature" } });

  const again = await deliver(request, pixOrder, { userId: accountId, version: 99 });
  expect(again).toMatchObject({ status: 200, body: { ok: true, outcome: "already_credited" } });
  const concurrent = await Promise.all([1, 2, 3].map((n) => deliver(request, pixOrder, { userId: accountId, version: 100 + n })));
  for (const r of concurrent) expect(r).toMatchObject({ status: 200, body: { outcome: "already_credited" } });
  expect(await wallet(request)).toMatchObject({ balanceCents: 1234, version: 1 });

  const unknown = await deliver(request, "ORDTSTNAOEXISTE0000000000000", { userId: accountId });
  expect(unknown).toMatchObject({ status: 200, body: { outcome: "unknown_order" } });
  const otherAccount = await deliver(request, pixOrder, { userId: "999000111" });
  expect(otherAccount).toMatchObject({ status: 200, body: { outcome: "noop" } });
  expect(await wallet(request)).toMatchObject({ balanceCents: 1234, version: 1 });
  expect(await ledgerOk(request)).toMatchObject({ entryCount: 1 });
});

test("reembolso REAL no sandbox: lançamento negativo, carteira regularizada, sem pendência; repetir não duplica", async ({ request }) => {
  test.setTimeout(180_000);
  expect(pixOrder, "depende do primeiro teste").not.toBe("");
  const refund = await fetch(`${MP_API}/v1/orders/${pixOrder}/refund`, { method: "POST", headers: { authorization: `Bearer ${sandboxToken()}`, "content-type": "application/json", "x-idempotency-key": `f19-refund-${tag}` }, body: "{}" });
  expect(refund.status, "reembolso no sandbox").toBeLessThan(300);

  // O servidor detecta o reembolso pelo webhook (se cadastrado) ou pela conciliação.
  await expect
    .poll(async () => (await call(request, fam.guardian, "POST", `/api/topups/online/${pixIntent}/reconcile`, {})).body.status, { timeout: 120_000, intervals: [5_000] })
    .toBe("reversed");
  expect(await wallet(request)).toMatchObject({ balanceCents: 0, version: 2, pendingReversalCents: 0 });
  // A API devolve o extrato do mais novo para o mais antigo.
  expect((await wallet(request)).entries.map((e) => [e.type, e.amountCents])).toEqual([["topup_reversal", -1234], ["topup", 1234]]);
  expect(await ledgerOk(request)).toMatchObject({ entryCount: 2, balanceCents: 0 });
  expect((await intentDoc(pixIntent))?.reversal).toMatchObject({ accountedCents: 1234, recoveredCents: 1234, pendingCents: 0, cause: "refund" });
  await Promise.all([1, 2, 3].map(() => call(request, fam.guardian, "POST", `/api/topups/online/${pixIntent}/reconcile`, {})));
  expect(await wallet(request)).toMatchObject({ balanceCents: 0, version: 2 });
});

test("reembolso PARCIAL REAL acumulado no sandbox (contrato observado): cada parcela vira um lançamento; acima do restante o provedor recusa; o restante fecha como 'revertida'", async ({ request }) => {
  test.setTimeout(420_000);
  const intentId = await createPix(request, fam.studentId, 1000);
  await waitConfirmed(request, intentId);
  const doc = await intentDoc(intentId);
  const confirmation = doc?.confirmation as { orderId: string; paymentId: string };
  const before = await wallet(request);

  const refund = async (label: string, body: unknown) =>
    fetch(`${MP_API}/v1/orders/${confirmation.orderId}/refund`, { method: "POST", headers: { authorization: `Bearer ${sandboxToken()}`, "content-type": "application/json", "x-idempotency-key": `f19-${label}-${tag}-${intentId.slice(4, 12)}` }, body: JSON.stringify(body) });
  const reconcileUntil = async (accountedCents: number) =>
    expect
      .poll(async () => ((await call(request, fam.guardian, "POST", `/api/topups/online/${intentId}/reconcile`, {})).body.reversal as { accountedCents: number } | null)?.accountedCents ?? 0, { timeout: 120_000, intervals: [5_000] })
      .toBe(accountedCents);

  // 1ª parcela: R$ 1,00 → order e pagamento `processed/partially_refunded`, `refunded_amount` acumulado.
  expect((await refund("p1", { transactions: [{ id: confirmation.paymentId, amount: "1.00" }] })).status).toBeLessThan(300);
  await reconcileUntil(100);
  expect(await wallet(request)).toMatchObject({ balanceCents: before.balanceCents - 100, pendingReversalCents: 0 });
  expect((await call(request, fam.guardian, "GET", `/api/topups/online/${intentId}`)).body).toMatchObject({ status: "confirmed", credited: true, reversal: { accountedCents: 100, recoveredCents: 100, pendingCents: 0, cause: "refund" } });

  // 2ª parcela: R$ 2,50 (acumulado R$ 3,50).
  expect((await refund("p2", { transactions: [{ id: confirmation.paymentId, amount: "2.50" }] })).status).toBeLessThan(300);
  await reconcileUntil(350);
  expect(await wallet(request)).toMatchObject({ balanceCents: before.balanceCents - 350 });

  // Acima do restante: o PROVEDOR recusa (400 refund_amount_exceeds) e nada muda aqui.
  const exceeds = await refund("excede", { transactions: [{ id: confirmation.paymentId, amount: "9.00" }] });
  expect(exceeds.status).toBe(400);
  expect(JSON.stringify(await exceeds.json())).toContain("refund_amount_exceeds");
  await call(request, fam.guardian, "POST", `/api/topups/online/${intentId}/reconcile`, {});
  expect(await wallet(request)).toMatchObject({ balanceCents: before.balanceCents - 350 });

  // Restante (R$ 6,50) por reembolso total: a recarga fecha como 'revertida'.
  expect((await refund("resto", {})).status).toBeLessThan(300);
  await expect
    .poll(async () => (await call(request, fam.guardian, "POST", `/api/topups/online/${intentId}/reconcile`, {})).body.status, { timeout: 120_000, intervals: [5_000] })
    .toBe("reversed");
  expect(await wallet(request)).toMatchObject({ balanceCents: before.balanceCents - 1000, pendingReversalCents: 0 });
  const entries = (await wallet(request)).entries.map((e) => [e.type, e.amountCents]);
  expect(entries.slice(0, 3)).toEqual([["topup_reversal", -650], ["topup_reversal", -250], ["topup_reversal", -100]]);
  expect((await intentDoc(intentId))?.reversal).toMatchObject({ accountedCents: 1000, recoveredCents: 1000, pendingCents: 0 });
  expect(await ledgerOk(request)).toMatchObject({ balanceCents: before.balanceCents - 1000 });
});

test("reembolso REAL com o crédito já consumido: recupera o saldo, abre pendência, bloqueia a carteira e a administração regulariza", async ({ request }) => {
  test.setTimeout(420_000);
  const start = await wallet(request);
  const intentId = await createPix(request, fam.studentId, 1000);
  await waitConfirmed(request, intentId);
  const credited = await wallet(request);
  expect(credited).toMatchObject({ balanceCents: start.balanceCents + 1000, version: start.version + 1 }); // relativo ao estado lido: os testes anteriores já lançaram movimentos
  // Consumo: transferência de R$ 7,00 para o irmão (saldo restante R$ 3,00).
  const transfer = await call(request, fam.guardian, "POST", "/api/wallets/transfer", { key: newKey("hml-f19-tr"), fromStudentId: fam.studentId, toStudentId: siblingId, amountCents: 700, reason: "Consumo de teste F19" });
  expect(transfer.status, String(transfer.body.error ?? "")).toBe(200);

  const order = String(((await intentDoc(intentId))?.confirmation as { orderId: string }).orderId);
  const refund = await fetch(`${MP_API}/v1/orders/${order}/refund`, { method: "POST", headers: { authorization: `Bearer ${sandboxToken()}`, "content-type": "application/json", "x-idempotency-key": `f19-refund2-${tag}` }, body: "{}" });
  expect(refund.status, "reembolso no sandbox").toBeLessThan(300);
  await expect
    .poll(async () => (await call(request, fam.guardian, "POST", `/api/topups/online/${intentId}/reconcile`, {})).body.status, { timeout: 120_000, intervals: [5_000] })
    .toBe("reversed");

  expect(await wallet(request)).toMatchObject({ balanceCents: 0, pendingReversalCents: 700 });
  expect((await intentDoc(intentId))?.reversal).toMatchObject({ accountedCents: 1000, recoveredCents: 300, pendingCents: 700, cause: "refund" });
  expect(await ledgerOk(request)).toMatchObject({ balanceCents: 0 });

  // Bloqueada para novas despesas; o irmão continua livre.
  const blocked = await call(request, fam.guardian, "POST", "/api/wallets/transfer", { key: newKey("hml-f19-bl"), fromStudentId: fam.studentId, toStudentId: siblingId, amountCents: 100, reason: "Deve ser recusada" });
  expect(blocked).toMatchObject({ status: 409, body: { error: "wallet_blocked", details: { pendingCents: 700 } } });
  expect((await wallet(request, siblingId)).pendingReversalCents).toBe(0);

  const list = await call(request, fam.admin, "GET", "/api/admin/payments");
  const pendency = (list.body as unknown as { pendencies: { intentId: string; outstandingCents: number }[] }).pendencies.find((p) => p.intentId === intentId);
  expect(pendency).toMatchObject({ outstandingCents: 700 });
  expect((await call(request, fam.guardian, "GET", "/api/admin/payments")).status).toBe(403);

  const resolved = await call(request, fam.admin, "POST", `/api/admin/payments/pendencies/${intentId}/resolve`, { key: newKey("hml-f19-rs"), action: "write_off", expectedOutstandingCents: 700, reason: "Teste HML: perda assumida (sandbox)" });
  expect(resolved).toMatchObject({ status: 200, body: { status: "resolved", appliedCents: 700 } });
  expect(await wallet(request)).toMatchObject({ pendingReversalCents: 0 });
});

test("tela: Pix gerado fica 'em processamento'; depois da aprovação do sandbox a tela mostra 'Crédito lançado' e o saldo, reconciliado pelo servidor", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/portal/carteira/recarga");
  await page.getByLabel("Email").fill(fam.guardian.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("online-topup-form")).toBeVisible({ timeout: 45000 });
  await page.getByTestId("online-topup-form").getByLabel("Aluno").selectOption({ label: fam.studentName });
  await page.getByLabel("Valor (R$)").fill("5,00");
  await page.getByTestId("topup-channel-pix").check();
  await page.getByRole("button", { name: "Revisar" }).click();
  await page.getByRole("button", { name: "Gerar Pix" }).click();
  const panel = page.getByTestId("topup-intent");
  await expect(panel).toHaveAttribute("data-status", /awaiting_payment|confirmed/, { timeout: 60000 });
  const wasProcessing = (await panel.getAttribute("data-status")) === "awaiting_payment";
  if (wasProcessing) await expect(page.getByTestId("topup-not-credited")).toContainText("nenhum crédito foi lançado");
  test.info().annotations.push({ type: "viu 'em processamento' antes do crédito", description: String(wasProcessing) });
  await expect(page.getByTestId("topup-credited")).toContainText("Crédito lançado", { timeout: 180_000 });
  await expect(panel).toHaveAttribute("data-status", "confirmed");
  await expect(page.getByTestId("topup-wallet-balance")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "test-results/f19-sandbox-credito-lancado.png", fullPage: true });
});
