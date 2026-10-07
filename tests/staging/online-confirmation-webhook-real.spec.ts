// PROVA DA ENTREGA REAL DO WEBHOOK do Mercado Pago (F19), na aplicação publicada (preview da Vercel × Firestore HML × sandbox).
// A confirmação financeira desta recarga tem de vir EXCLUSIVAMENTE do webhook que o Mercado Pago entrega à nossa URL:
//   - o teste NÃO chama /reconcile, NÃO abre a tela (que dispara conciliação), NÃO roda a varredura e NÃO assina notificação alguma
//     antes de a confirmação aparecer;
//   - a observação é só LEITURA, sem efeito financeiro: `GET /api/topups/online/{id}` (lê a intenção, não consulta o provedor),
//     `GET /api/wallets` e leituras do Admin SDK em `topupIntents`, `paymentEvents` e `auditLog`;
//   - se o webhook não chegar, o teste FALHA (não há skip nem prazo estendido para obter verde).
// Só depois da confirmação por webhook o teste exercita duplicidade (entregas assinadas pelo próprio teste, com a chave real) e
// conciliação, provando que nenhum segundo crédito aparece. Credenciais: só de TESTE, lidas de .env.staging.local.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { admin as harnessAdmin } from "../../scripts/staging/admin.ts";
import { parseDotenv } from "../../scripts/staging/target.ts";
import type { TestUser } from "../helpers/auth-emulator";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const MP_API = "https://api.mercadopago.com";
const WAIT_MS = 150_000; // paciência do teste novo (a entrega real costuma levar segundos); NÃO altera timeout de teste existente
let fam: Family;
let sandbox = false;
let secret = "";
let intentId = "";
let orderId = "";
let accountId = "";

type Json = Record<string, unknown> & { error?: string };
const call = async (request: APIRequestContext, user: TestUser, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: bearer(user.idToken), data, timeout: 60000 });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
const envFile = (): Record<string, string> => {
  const path = process.env.STAGING_ENV_FILE || ".env.staging.local";
  return existsSync(path) ? parseDotenv(readFileSync(path, "utf8")) : {};
};
const db = () => harnessAdmin().db;
const intentDoc = async () => (await db().doc(`topupIntents/${intentId}`).get()).data();
const wallet = async (request: APIRequestContext) => (await call(request, fam.guardian, "GET", `/api/wallets?studentId=${fam.studentId}`)).body as unknown as { balanceCents: number; version: number; pendingReversalCents: number; entries: { type: string; amountCents: number }[] };
const events = async () => (await db().collection("paymentEvents").where("orderId", "==", orderId).get()).docs.map((d) => d.data());
const audits = async (action: string) => (await db().collection("auditLog").where("target.id", "==", intentId).where("action", "==", action).get()).size;

/** Observação SOMENTE LEITURA até a condição ser verdadeira; falha (sem skip) se não chegar no prazo. */
async function observe<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const started = Date.now();
  let value = await read();
  while (!done(value)) {
    if (Date.now() - started > WAIT_MS) throw new Error(`${label}: não observado em ${WAIT_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    value = await read();
  }
  return value;
}

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-f19w-${Math.random().toString(36).slice(2, 7)}`);
  const cfg = await call(request, fam.guardian, "GET", "/api/topups/online/config");
  sandbox = cfg.body.providerEnv === "sandbox";
  secret = envFile().MERCADOPAGO_WEBHOOK_SECRET?.trim() ?? "";
});
test.beforeEach(() => test.skip(!sandbox, "homologação sem sandbox do Mercado Pago configurado"));

test("a confirmação vem EXCLUSIVAMENTE do webhook real: evento autêntico, origem 'webhook', crédito único, livro e auditoria consistentes", async ({ request }) => {
  test.setTimeout(300_000);
  const created = await call(request, fam.guardian, "POST", "/api/topups/online", { key: newKey("hml-f19w"), studentId: fam.studentId, amountCents: 1500, channel: "pix" });
  expect(created.status, String(created.body.error ?? "")).toBeLessThan(300);
  expect(created.body).toMatchObject({ status: "awaiting_payment", credited: false });
  intentId = String(created.body.intentId);
  const charge = (await intentDoc())?.charge as { id: string };
  orderId = charge.id;
  expect(await events()).toHaveLength(0);

  // Daqui em diante, SÓ leituras: nenhuma rota de conciliação, nenhuma tela, nenhuma varredura, nenhuma notificação do teste.
  const seen = await observe("recarga confirmada pelo webhook", async () => (await call(request, fam.guardian, "GET", `/api/topups/online/${intentId}`)).body, (view) => view.status === "confirmed");
  expect(seen).toMatchObject({ status: "confirmed", credited: true, credit: { amountCents: 1500, walletSeq: 1, balanceAfterCents: 1500 } });

  const doc = await intentDoc();
  accountId = String((doc?.provider as { accountId: string }).accountId);
  expect(doc?.confirmation, "origem da confirmação").toMatchObject({ source: "webhook", orderId, paidCents: 1500, walletSeq: 1, walletEntryId: `${intentId}_credit` });
  expect(accountId).toMatch(/^\d+$/);

  // Evento AUTÊNTICO recebido (gravado só depois de a assinatura do Mercado Pago ser validada).
  const received = await events();
  expect(received.length).toBeGreaterThanOrEqual(1);
  for (const event of received) {
    expect(event).toMatchObject({ provider: "mercadopago", accountId, orderId, source: "webhook" });
    expect(String(event.requestId ?? "")).not.toBe("");
  }
  expect(received.filter((e) => e.outcome === "credited")).toHaveLength(1);
  test.info().annotations.push({ type: "entregas do Mercado Pago", description: `${received.length} (${received.map((e) => `${String(e.action)}:${String(e.outcome)}`).join(", ")})` });

  // Crédito único, livro e auditoria consistentes.
  expect(await wallet(request)).toMatchObject({ balanceCents: 1500, version: 1, pendingReversalCents: 0 });
  expect((await wallet(request)).entries.map((e) => [e.type, e.amountCents])).toEqual([["topup", 1500]]);
  expect(await audits("topup.online.confirm")).toBe(1);
  const ledger = await call(request, fam.admin, "GET", `/api/wallets/reconcile?studentId=${fam.studentId}`);
  expect(ledger.body).toMatchObject({ ok: true, problems: [], entryCount: 1, balanceCents: 1500 });
});

test("duplicidade e conciliação DEPOIS do crédito por webhook: nenhum segundo crédito", async ({ request }) => {
  test.setTimeout(240_000);
  expect(intentId, "depende do teste anterior").not.toBe("");
  // Conciliação (rota da família e da administração) e entregas duplicadas assinadas com a chave real, em paralelo.
  const deliver = async (version: number) => {
    const ts = String(Date.now());
    const requestId = randomUUID();
    const signature = createHmac("sha256", secret).update(`id:${orderId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex");
    const r = await request.fetch(`/api/webhooks/mercadopago?data.id=${orderId}&type=order`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId, "x-signature": `ts=${ts},v1=${signature}` },
      data: { action: "order.processed", type: "order", live_mode: false, user_id: accountId, api_version: "v1", data: { id: orderId, version } },
      timeout: 60000,
    });
    return { status: r.status(), body: (await r.json().catch(() => ({}))) as Json };
  };
  expect(secret, "MERCADOPAGO_WEBHOOK_SECRET ausente no arquivo local: não é possível assinar as entregas duplicadas").not.toBe("");
  const results = await Promise.all([
    deliver(901),
    deliver(902),
    deliver(903),
    call(request, fam.guardian, "POST", `/api/topups/online/${intentId}/reconcile`, {}),
    call(request, fam.admin, "POST", `/api/topups/online/${intentId}/reconcile`, {}),
    call(request, fam.admin, "POST", "/api/admin/payments/reconcile", { intentId }),
  ]);
  for (const r of results.slice(0, 3)) expect(r).toMatchObject({ status: 200, body: { outcome: "already_credited" } });
  expect(await wallet(request)).toMatchObject({ balanceCents: 1500, version: 1 });
  expect((await wallet(request)).entries).toHaveLength(1);
  expect(await audits("topup.online.confirm")).toBe(1);
  expect(await intentDoc()).toMatchObject({ status: "confirmed", confirmation: { source: "webhook" } }); // a origem do crédito não muda
  expect(((await call(request, fam.admin, "GET", `/api/wallets/reconcile?studentId=${fam.studentId}`)).body as Json)).toMatchObject({ ok: true, entryCount: 1 });
});

test("o reembolso também chega por webhook real: reversão originada pela entrega do Mercado Pago, sem conciliação", async ({ request }) => {
  test.setTimeout(300_000);
  expect(orderId, "depende do primeiro teste").not.toBe("");
  const before = (await events()).length;
  const token = envFile().MERCADOPAGO_ACCESS_TOKEN?.trim() ?? "";
  const refund = await fetch(`${MP_API}/v1/orders/${orderId}/refund`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-idempotency-key": `f19w-refund-${intentId.slice(4, 14)}` }, body: "{}" });
  expect(refund.status, "reembolso no sandbox").toBeLessThan(300);

  const view = await observe("reversão pelo webhook", async () => (await call(request, fam.guardian, "GET", `/api/topups/online/${intentId}`)).body, (v) => v.status === "reversed");
  expect(view).toMatchObject({ status: "reversed", reversal: { accountedCents: 1500, recoveredCents: 1500, pendingCents: 0, cause: "refund" } });
  const all = await events();
  expect(all.length).toBeGreaterThan(before);
  expect(all.some((e) => e.outcome === "reversal" && e.source === "webhook")).toBe(true);
  expect(await wallet(request)).toMatchObject({ balanceCents: 0, version: 2, pendingReversalCents: 0 });
  expect((await wallet(request)).entries.map((e) => [e.type, e.amountCents])).toEqual([["topup_reversal", -1500], ["topup", 1500]]);
  expect(((await call(request, fam.admin, "GET", `/api/wallets/reconcile?studentId=${fam.studentId}`)).body as Json)).toMatchObject({ ok: true, entryCount: 2, balanceCents: 0 });
});
