// PROVA "webhook SIMULADO PELO PAINEL do Mercado Pago, associado a uma order REAL do sandbox" (F19). NÃO é entrega automática.
// Fluxo semi-manual, na aplicação publicada (preview × Firestore HML × sandbox):
//   1. cria uma recarga Pix NOVA (família nova, sem crédito anterior) e espera o sandbox aprovar a order consultando o PROVEDOR
//      diretamente (GET /v1/orders/{id}) — consulta que não lança crédito;
//   2. prova, antes da simulação, que carteira, livro, auditoria e eventos NÃO têm o crédito;
//   3. publica o ID da order em .agent-logs/f19-sim-state.json e observa SÓ POR LEITURAS (intenção, carteira, Admin SDK) até a
//      pessoa usar "Simular notificação" no painel com esse ID;
//   4. confere assinatura válida (evento autêntico gravado), consulta confirmatória, crédito ORIGINADO pelo webhook, livro e auditoria;
//   5. aguarda uma SEGUNDA simulação e prova que crédito, livro e auditoria não duplicam.
// O teste NÃO chama /reconcile, NÃO usa a tela (que dispara conciliação), NÃO roda a varredura e NÃO assina notificação alguma.
// Cron (só roda em deployment de produção) e demais recuperações não são acionados. Se a confirmação vier de outro mecanismo
// (`confirmation.source` ≠ webhook) o teste FALHA: essa execução não comprova crédito exclusivamente pelo webhook.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { admin as harnessAdmin } from "../../scripts/staging/admin.ts";
import { parseDotenv } from "../../scripts/staging/target.ts";
import type { TestUser } from "../helpers/auth-emulator";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const STATE = ".agent-logs/f19-sim-state.json";
const MP_API = "https://api.mercadopago.com";
const AMOUNT = 700;
let fam: Family;
let sandbox = false;
let intentId = "";
let orderId = "";

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
const events = async () => (await db().collection("paymentEvents").where("orderId", "==", orderId).get()).docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, unknown>[];
const audits = async (action: string) => (await db().collection("auditLog").where("target.id", "==", intentId).where("action", "==", action).get()).size;
const ledger = async (request: APIRequestContext) => (await call(request, fam.admin, "GET", `/api/wallets/reconcile?studentId=${fam.studentId}`)).body as Json;
const note = (state: Record<string, unknown>) => writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), orderId, intentId, amountCents: AMOUNT, ...state }, null, 2));

async function observe<T>(label: string, minutes: number, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const started = Date.now();
  let value = await read();
  while (!done(value)) {
    if (Date.now() - started > minutes * 60_000) throw new Error(`${label}: não observado em ${minutes} min`);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    value = await read();
  }
  return value;
}

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-f19sim-${Math.random().toString(36).slice(2, 7)}`);
  sandbox = ((await call(request, fam.guardian, "GET", "/api/topups/online/config")).body.providerEnv as string) === "sandbox";
});
test.beforeEach(() => test.skip(!sandbox, "homologação sem sandbox do Mercado Pago configurado"));

test("recarga nova aprovada no sandbox, SEM crédito antes da simulação (carteira, livro, auditoria, eventos)", async ({ request }) => {
  test.setTimeout(240_000);
  const created = await call(request, fam.guardian, "POST", "/api/topups/online", { key: newKey("hml-f19sim"), studentId: fam.studentId, amountCents: AMOUNT, channel: "pix" });
  expect(created.status, String(created.body.error ?? "")).toBeLessThan(300);
  intentId = String(created.body.intentId);
  orderId = ((await intentDoc())?.charge as { id: string }).id;
  note({ phase: "aguardando_aprovacao_no_sandbox" });

  // Aprovação no sandbox, consultada DIRETAMENTE no provedor (não passa pelo nosso servidor, não lança crédito).
  const token = envFile().MERCADOPAGO_ACCESS_TOKEN?.trim() ?? "";
  const approved = await observe("aprovação da order no sandbox", 3, async () => ((await (await fetch(`${MP_API}/v1/orders/${orderId}`, { headers: { authorization: `Bearer ${token}` } })).json()) as Json), (o) => o.status === "processed");
  expect(approved).toMatchObject({ status: "processed", status_detail: "accredited", total_paid_amount: "7.00" });

  // Antes da simulação: nada de crédito em lugar nenhum.
  expect(await wallet(request)).toMatchObject({ balanceCents: 0, version: 0, pendingReversalCents: 0 });
  expect((await wallet(request)).entries).toHaveLength(0);
  expect(await ledger(request)).toMatchObject({ ok: true, entryCount: 0, balanceCents: 0 });
  expect((await call(request, fam.guardian, "GET", `/api/topups/online/${intentId}`)).body).toMatchObject({ status: "awaiting_payment", credited: false });
  expect((await intentDoc())?.confirmation).toBeUndefined();
  expect(await events()).toHaveLength(0);
  expect(await audits("topup.online.confirm")).toBe(0);
  note({ phase: "aguardando_primeira_simulacao", approvedInSandbox: true, creditBefore: false });
});

test("1ª simulação do painel: assinatura válida, evento recebido, consulta confirmatória e crédito ORIGINADO pelo webhook", async ({ request }) => {
  test.setTimeout(30 * 60_000);
  expect(orderId, "depende do teste anterior").not.toBe("");
  const seen = await observe("1ª simulação (recarga confirmada)", 25, async () => (await call(request, fam.guardian, "GET", `/api/topups/online/${intentId}`)).body, (v) => v.status === "confirmed");
  expect(seen).toMatchObject({ status: "confirmed", credited: true, credit: { amountCents: AMOUNT, walletSeq: 1, balanceAfterCents: AMOUNT } });

  const doc = await intentDoc();
  expect(doc?.confirmation, "origem da confirmação (se não for 'webhook', esta execução NÃO comprova crédito exclusivo pelo webhook)").toMatchObject({ source: "webhook", orderId, paidCents: AMOUNT, walletEntryId: `${intentId}_credit`, walletSeq: 1 });
  const accountId = String((doc?.provider as { accountId: string }).accountId);
  const first = await events();
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ provider: "mercadopago", accountId, orderId, source: "webhook", outcome: "credited" });
  expect(String(first[0]!.requestId ?? "")).not.toBe(""); // x-request-id assinado pelo Mercado Pago
  expect(await wallet(request)).toMatchObject({ balanceCents: AMOUNT, version: 1, pendingReversalCents: 0 });
  expect((await wallet(request)).entries.map((e) => [e.type, e.amountCents])).toEqual([["topup", AMOUNT]]);
  expect(await audits("topup.online.confirm")).toBe(1);
  expect(await ledger(request)).toMatchObject({ ok: true, entryCount: 1, balanceCents: AMOUNT });
  note({ phase: "creditado_pela_1a_simulacao_aguardando_2a", confirmationSource: "webhook", event: { action: first[0]!.action, version: first[0]!.version, bodyUserId: first[0]!.bodyUserId, bodyLiveMode: first[0]!.bodyLiveMode, outcome: first[0]!.outcome } });
});

test("2ª simulação do painel: nenhum segundo crédito (carteira, livro e auditoria intactos)", async ({ request }) => {
  test.setTimeout(30 * 60_000);
  expect(orderId, "depende dos testes anteriores").not.toBe("");
  const all = await observe("2ª simulação (novo evento)", 25, events, (list) => list.length >= 2);
  expect(all.filter((e) => e.outcome === "credited")).toHaveLength(1);
  const second = all.find((e) => e.outcome !== "credited")!;
  expect(second).toMatchObject({ source: "webhook", outcome: "noop", reason: "already_credited" });
  expect(await wallet(request)).toMatchObject({ balanceCents: AMOUNT, version: 1 });
  expect((await wallet(request)).entries).toHaveLength(1);
  expect(await audits("topup.online.confirm")).toBe(1);
  expect(await intentDoc()).toMatchObject({ status: "confirmed", confirmation: { source: "webhook" } });
  expect(await ledger(request)).toMatchObject({ ok: true, entryCount: 1, balanceCents: AMOUNT });
  note({ phase: "concluido", events: all.length, secondOutcome: second.outcome, secondReason: second.reason, duplicatedCredit: false });
});
