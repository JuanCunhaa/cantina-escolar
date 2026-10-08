// Confirmação, crédito e reversão da recarga online (F19) contra Auth/Firestore Emulator, com PROVEDOR ROTEIRIZADO
// (tests/helpers/fake-mercadopago.ts: contrato da fronteira; não prova nenhum provedor real — o sandbox real está em
// tests/staging/online-topup-sandbox.spec.ts). Prova (A05): assinatura inválida/ausente/antiga não credita nem grava; o status do
// corpo da notificação é ignorado (a order é consultada); conta, moeda, valor, ambiente e cobrança divergentes vão para revisão
// SEM crédito; duplicidade e concorrência creditam UMA vez; fora de ordem não regride. (A06): timeout de criação e pagamento
// depois da expiração local são conciliados sem crédito duplo. (A31): reembolso/chargeback é idempotente, nunca deixa saldo
// negativo, abre pendência e bloqueia novas despesas. (A35): o callback transacional não chama o provedor (contagem de chamadas
// com concorrência) e uma falha no meio da transação não grava nada.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, seedStudentAccess, type TestUser } from "../helpers/auth-emulator";
import { fakeMercadoPago, FAKE_ACCOUNT, type FakeMercadoPago } from "../helpers/fake-mercadopago";
import { computeSignature, signatureManifest } from "@/modules/payments/online/mercadopago-webhook";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string };

let confirmation: typeof import("@/modules/payments/online/confirmation");
let intents: typeof import("@/modules/payments/online/intent-commands");
let webhook: typeof import("@/modules/payments/online/webhook-handler");
let reconcileMod: typeof import("@/modules/payments/online/reconcile");
let pendenciesMod: typeof import("@/modules/payments/online/pendencies");
let walletCommands: typeof import("@/modules/wallet/commands");
let walletQueries: typeof import("@/modules/wallet/queries");
let topupCommands: typeof import("@/modules/payments/topup-commands");
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let listRoute: Handler;
let resolveRoute: Handler;
let reconcileRoute: Handler;
let webhookRoute: Handler;
let cronRoute: Handler;
let MAX_BALANCE_CENTS: number;

let admin: TestUser;
let secretaria: TestUser;
let cantina: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;

const SECRET = `wh-teste-${randomUUID()}`; // gerado a cada execução: nenhum literal com cara de segredo no repositório
const tag = randomUUID().slice(0, 6);
let seq = 0;

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  delete process.env.PAYMENTS_PIX_PROVIDER;
  delete process.env.PAYMENTS_CARD_PROVIDER;
  delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
  delete process.env.CRON_SECRET;
  confirmation = await import("@/modules/payments/online/confirmation");
  intents = await import("@/modules/payments/online/intent-commands");
  webhook = await import("@/modules/payments/online/webhook-handler");
  reconcileMod = await import("@/modules/payments/online/reconcile");
  pendenciesMod = await import("@/modules/payments/online/pendencies");
  walletCommands = await import("@/modules/wallet/commands");
  walletQueries = await import("@/modules/wallet/queries");
  topupCommands = await import("@/modules/payments/topup-commands");
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ MAX_BALANCE_CENTS } = await import("@/modules/wallet/model"));
  listRoute = (await import("@/app/api/admin/payments/route")).GET as unknown as Handler;
  resolveRoute = (await import("@/app/api/admin/payments/pendencies/[id]/resolve/route")).POST as unknown as Handler;
  reconcileRoute = (await import("@/app/api/topups/online/[id]/reconcile/route")).POST as unknown as Handler;
  webhookRoute = (await import("@/app/api/webhooks/mercadopago/route")).POST as unknown as Handler;
  cronRoute = (await import("@/app/api/cron/payments-reconcile/route")).GET as unknown as Handler;
  [admin, secretaria, cantina, guardianA, guardianB] = await Promise.all([
    createTestUser("fadm", "admin", { displayName: "Admin F19" }),
    createTestUser("fsec", "secretaria"),
    createTestUser("fcant", "cantina"),
    createTestUser("fresp-a", "guardian", { displayName: "Responsável A" }),
    createTestUser("fresp-b", "guardian"),
  ]);
});

/* ------------------------------------------------------------------------------------------------- apoio */

const db = () => adminDb();
const actor = (u: TestUser, role: "guardian" | "admin" | "secretaria" | "cantina" = "guardian") => ({ uid: u.uid, role });
const noCtx = { params: Promise.resolve({ id: "" }) };

async function call(handler: Handler, user: TestUser | null, method: string, url: string, body?: unknown, id = "", headers: Record<string, string> = {}) {
  const response = await handler(
    new Request(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.idToken}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    id ? { params: Promise.resolve({ id }) } : noCtx,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

async function newStudent(over: { guardians?: TestUser[] } = {}) {
  const id = `stf_${tag}_${++seq}`;
  await seedStudentAccess({ studentId: id, name: `Aluno F19 ${seq}`, guardianUids: (over.guardians ?? [guardianA]).map((g) => g.uid) });
  return id;
}

const walletOf = async (studentId: string) => {
  const w = await db().doc(`wallets/${studentId}`).get();
  return { balance: (w.get("balanceCents") as number | undefined) ?? 0, version: (w.get("version") as number | undefined) ?? 0, pending: (w.get("pendingReversalCents") as number | undefined) ?? 0 };
};
const entriesOf = async (studentId: string) => (await db().collection(`wallets/${studentId}/entries`).orderBy("seq").get()).docs.map((d) => ({ id: d.id, ...d.data() }) as { id: string; type: string; amountCents: number; seq: number; balanceAfterCents: number; referenceType: string; referenceId: string });
const intentDoc = async (id: string) => (await db().doc(`topupIntents/${id}`).get()).data()!;
const auditActions = async (intentId: string) => (await db().collection("auditLog").where("target.id", "==", intentId).get()).docs.map((d) => d.get("action") as string).sort();
const eventsOf = async (orderId: string) => (await db().collection("paymentEvents").where("orderId", "==", orderId).get()).docs.map((d) => d.data());
async function ledgerOk(studentId: string) {
  const r = await walletQueries.reconcileWallet(db(), studentId);
  expect(r.problems).toEqual([]);
  expect(r.ok).toBe(true);
}
async function untouched(studentId: string) {
  expect(await walletOf(studentId)).toEqual({ balance: 0, version: 0, pending: 0 });
  expect(await entriesOf(studentId)).toHaveLength(0);
}

const pixBody = (studentId: string, over: Record<string, unknown> = {}) => ({ key: randomUUID(), studentId, amountCents: 5000, channel: "pix", ...over });
const deps = (p: FakeMercadoPago) => ({ providers: p.providers, production: false });

/** Intenção Pix criada pelo fluxo real da F18 (provedor roteirizado). */
async function newIntent(p: FakeMercadoPago, student: string, over: Record<string, unknown> = {}, clock?: () => Date) {
  const v = await intents.createTopupIntent(db(), actor(guardianA), pixBody(student, over), { providers: p.providers, clock });
  return v.intentId;
}

/** Notificação autêntica (assinada com a chave de teste), como o Mercado Pago a entregaria. */
async function notify(p: FakeMercadoPago, intentOrOrder: string, o: { action?: string; version?: number; secret?: string | null; ts?: number; requestId?: string; liveMode?: boolean; userId?: string; bodyStatus?: string; sign?: boolean; queryId?: string | null; signFor?: string } = {}) {
  const orderId = intentOrOrder.startsWith("tpi_") ? p.orderIdOf(intentOrOrder) : intentOrOrder;
  const ts = String(o.ts ?? Date.now());
  const requestId = o.requestId ?? randomUUID();
  const queryId = o.queryId === undefined ? orderId : o.queryId;
  const headers: Record<string, string> = { "content-type": "application/json", "x-request-id": requestId };
  if (o.sign !== false) headers["x-signature"] = `ts=${ts},v1=${computeSignature(SECRET, signatureManifest({ dataId: o.signFor ?? queryId, requestId, ts }))}`;
  const body = { action: o.action ?? "order.processed", type: "order", live_mode: o.liveMode ?? false, user_id: o.userId ?? FAKE_ACCOUNT, api_version: "v1", data: { id: orderId, status: o.bodyStatus ?? "processed", version: o.version ?? 1 } };
  const request = new Request(`http://localhost/api/webhooks/mercadopago?type=order${queryId ? `&data.id=${queryId}` : ""}`, { method: "POST", headers, body: JSON.stringify(body) });
  const response = await webhook.handleMercadoPagoWebhook(request, { db: db(), providers: p.providers, secret: o.secret === null ? undefined : (o.secret ?? SECRET), production: false });
  return { status: response.status, body: (await response.json()) as Json };
}

/* ------------------------------------------------------------------------------------------------- A05 */

describe("webhook: autenticidade (A05)", () => {
  it("assinatura inválida, ausente, de outra chave ou antiga: 401, nada lido, nada gravado, provedor não consultado", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    const calls = p.calls.getOrder;
    for (const bad of [{ sign: false }, { secret: `outra-${randomUUID()}` }, { ts: Date.now() - 48 * 3_600_000 }, { signFor: "ORDOUTRO" }]) {
      const r = await notify(p, intent, bad);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "invalid_signature" });
    }
    expect(p.calls.getOrder).toBe(calls);
    await untouched(student);
    expect((await intentDoc(intent)).status).toBe("awaiting_payment");
    expect(await eventsOf(p.orderIdOf(intent))).toHaveLength(0);
  });

  it("sem chave configurada o endpoint recusa tudo (503, falha fechada), inclusive pela rota real", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    expect((await notify(p, intent, { secret: null })).status).toBe(503);
    const viaRoute = await call(webhookRoute, null, "POST", `/api/webhooks/mercadopago?type=order&data.id=${p.orderIdOf(intent)}`, { type: "order", data: { id: p.orderIdOf(intent) } });
    expect(viaRoute.status).toBe(503);
    await untouched(student);
  });

  it("notificação autêntica de pagamento aprovado credita o valor INTEGRAL, com livro, auditoria, evento e intenção confirmada na mesma operação", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    const r = await notify(p, intent, { version: 3 });
    expect(r).toEqual({ status: 200, body: { ok: true, outcome: "credited" } });

    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    const entries = await entriesOf(student);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: `${intent}_credit`, type: "topup", amountCents: 5000, seq: 1, balanceAfterCents: 5000, referenceType: "topup", referenceId: intent, method: "pix", source: "online" });
    const d = await intentDoc(intent);
    expect(d).toMatchObject({
      status: "confirmed",
      confirmation: { orderId: p.orderIdOf(intent), paidCents: 5000, source: "webhook", afterExpiry: false, walletEntryId: `${intent}_credit`, walletSeq: 1, balanceAfterCents: 5000 },
      reversal: { accountedCents: 0 },
      fee: { status: "pending", cents: null },
      settlement: { status: "pending" },
      provider: { accountId: FAKE_ACCOUNT },
    });
    expect(await auditActions(intent)).toEqual(["topup.online.confirm", "topup.online.intent", "topup.online.outcome"]);
    const events = await eventsOf(p.orderIdOf(intent));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "mercadopago", accountId: FAKE_ACCOUNT, action: "order.processed", version: "3", intentId: intent, outcome: "credited", source: "webhook" });
    await ledgerOk(student);

    const view = await intents.getTopupIntent(db(), actor(guardianA), intent);
    expect(view).toMatchObject({ status: "confirmed", credited: true, statusLabel: "Crédito lançado", credit: { amountCents: 5000, walletSeq: 1, balanceAfterCents: 5000, afterExpiry: false }, awaitingConfirmation: false });
  });

  it("o status do corpo NÃO credita: corpo diz 'processed' mas a order no provedor está pendente", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    const r = await notify(p, intent, { bodyStatus: "processed" });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("noop");
    await untouched(student);
    expect((await intentDoc(intent)).status).toBe("awaiting_payment");
  });

  it("redirect/tela não confirmam: ler a intenção ou conciliar com a order pendente não credita nada", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    const view = await intents.getTopupIntent(db(), actor(guardianA), intent);
    expect(view).toMatchObject({ credited: false, awaitingConfirmation: true });
    const rec = await reconcileMod.reconcileAndConfirm(db(), actor(guardianA), intent, {}, deps(p));
    expect(rec).toMatchObject({ credited: false, status: "awaiting_payment", confirmation: "noop" });
    await untouched(student);
  });

  it("duplicidade: a mesma notificação 4× (e com outra versão/outro request-id) credita UMA vez", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    const T = Date.now();
    const first = await notify(p, intent, { requestId: "req-fixo-1", ts: T });
    const again = await notify(p, intent, { requestId: "req-fixo-1", ts: T }); // mesma entrega (reenvio idêntico)
    const other = await notify(p, intent, { version: 7 });
    const lateAction = await notify(p, intent, { action: "order.updated", version: 8 });
    expect(first.body.outcome).toBe("credited");
    for (const r of [again, other, lateAction]) expect(r).toMatchObject({ status: 200, body: { outcome: "already_credited" } });
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    expect(await entriesOf(student)).toHaveLength(1);
    expect((await db().collection("auditLog").where("target.id", "==", intent).where("action", "==", "topup.online.confirm").get()).size).toBe(1);
    expect(await eventsOf(p.orderIdOf(intent))).toHaveLength(3); // unicidade por provedor/conta/order/ENTREGA (request-id + ts assinados)
    await ledgerOk(student);
  });

  it("concorrência: 8 notificações + conciliação + varredura ao mesmo tempo creditam UMA vez (A35: o provedor é consultado FORA do callback)", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    const before = p.calls.getOrder;
    const jobs: Promise<unknown>[] = [
      ...Array.from({ length: 8 }, (_, i) => notify(p, intent, { version: i, requestId: `req-${i}-${tag}` })),
      reconcileMod.reconcileAndConfirm(db(), actor(guardianA), intent, {}, deps(p)),
      confirmation.sweepIntents(db(), deps(p), { limit: 300 }),
    ];
    const results = await Promise.all(jobs);
    expect((results.slice(0, 8) as { status: number }[]).every((r) => r.status === 200)).toBe(true);
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    expect(await entriesOf(student)).toHaveLength(1);
    expect((await intentDoc(intent)).version).toBeGreaterThan(0);
    // O provedor só é chamado FORA do callback: com retentativas de transação, a contagem NÃO cresce além de 1 por gatilho.
    expect(p.calls.getOrder - before).toBeLessThanOrEqual(8 + 1 + 1 + 20); // sweep consulta também intenções de outros testes
    await ledgerOk(student);
  });

  it("mesma notificação e transação repetida pelo Firestore não chamam o provedor de novo: 1 consulta por entrega", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    const before = p.calls.getOrder;
    await Promise.all(Array.from({ length: 6 }, () => confirmation.confirmFromProvider(db(), deps(p), p.orderIdOf(intent), { source: "reconcile" })));
    expect(p.calls.getOrder - before).toBe(6);
    expect(await entriesOf(student)).toHaveLength(1);
  });

  it("valor divergente (menos, mais ou total diferente) → revisão, SEM crédito, e a divergência fica visível", async () => {
    for (const patch of [{ paidCents: 4000 }, { totalCents: 6000, paidCents: 6000 }, { paidCents: 5001 }]) {
      const student = await newStudent();
      const p = fakeMercadoPago();
      const intent = await newIntent(p, student);
      p.pay(intent, patch);
      const r = await notify(p, intent);
      expect(r).toMatchObject({ status: 200, body: { outcome: "review" } });
      await untouched(student);
      const d = await intentDoc(intent);
      expect(d).toMatchObject({ status: "in_review", review: { reason: "amount_mismatch" } });
      const view = await intents.getTopupIntent(db(), actor(guardianA), intent);
      expect(view).toMatchObject({ credited: false, status: "in_review", statusLabel: "Em revisão", review: { reason: "amount_mismatch" } });
      expect(await auditActions(intent)).toContain("topup.online.review");
      // repetir a mesma divergência não reescreve a revisão
      const version = d.version as number;
      await notify(p, intent, { version: 2 });
      expect((await intentDoc(intent)).version).toBe(version);
    }
  });

  it("moeda diferente de BRL → revisão sem crédito", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent, { currency: "USD" });
    expect((await notify(p, intent)).body.outcome).toBe("review");
    await untouched(student);
    expect((await intentDoc(intent)).review).toMatchObject({ reason: "currency_mismatch" });
  });

  it("pagamento em OUTRA conta recebedora → revisão sem crédito; `user_id` do corpo (não assinado) não decide nada: vale a conta da order consultada", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent, { accountId: "999000111" });
    expect((await notify(p, intent)).body.outcome).toBe("review");
    await untouched(student);
    expect((await intentDoc(intent)).review).toMatchObject({ reason: "account_mismatch" });

    const student2 = await newStudent();
    const intent2 = await newIntent(p, student2);
    p.pay(intent2);
    // A simulação do painel traz o user_id do DONO da aplicação; no corpo isso é só informação (registrada), a order manda.
    const r = await notify(p, intent2, { userId: "999000111" });
    expect(r).toMatchObject({ status: 200, body: { outcome: "credited" } });
    expect(await entriesOf(student2)).toHaveLength(1);
    expect((await eventsOf(p.orderIdOf(intent2))).map((e) => [e.outcome, e.bodyUserId])).toEqual([["credited", "999000111"]]);
  });

  it("o corpo NÃO é assinado: `live_mode` do corpo (a simulação do painel manda true) não decide nada; o ambiente vem das credenciais e a order é consultada", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    const before = p.calls.getOrder;
    expect(await notify(p, intent, { liveMode: true })).toMatchObject({ status: 200, body: { outcome: "credited" } });
    expect(p.calls.getOrder - before).toBe(1); // a order foi consultada: é ela que decide
    const doc = await intentDoc(intent);
    expect(doc.status).toBe("confirmed");
    expect(doc.review).toBeUndefined(); // corpo diferente do esperado não põe o pagamento em revisão
    expect((await eventsOf(p.orderIdOf(intent))).map((e) => [e.outcome, e.bodyLiveMode])).toEqual([["credited", true]]);
    expect(await entriesOf(student)).toHaveLength(1);
    // e uma order que NÃO está paga continua sem crédito, qualquer que seja o corpo
    const student2 = await newStudent();
    const intent2 = await newIntent(p, student2);
    expect(await notify(p, intent2, { liveMode: true, bodyStatus: "processed" })).toMatchObject({ status: 200, body: { outcome: "noop" } });
    await untouched(student2);
  });

  it("assinatura reaproveitada com OUTRO corpo (ação/versão/status trocados) cai no mesmo evento: nenhum documento novo e nenhuma mudança de estado", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    const T = Date.now();
    const base = { requestId: "req-capturado-1", ts: T };
    expect((await notify(p, intent, { ...base, action: "order.processed", version: 1 })).body.outcome).toBe("credited");
    for (let i = 0; i < 5; i += 1) await notify(p, intent, { ...base, action: `order.inventada_${i}`, version: 100 + i, bodyStatus: "refunded" });
    expect(await eventsOf(p.orderIdOf(intent))).toHaveLength(1);
    expect(await entriesOf(student)).toHaveLength(1);
    expect((await intentDoc(intent)).status).toBe("confirmed");
  });

  it("sem data.id na query não há o que autenticar: 400, nada lido nem gravado (mesmo com assinatura formalmente válida)", async () => {
    const p = fakeMercadoPago();
    const ts = String(Date.now());
    const requestId = randomUUID();
    const sig = `ts=${ts},v1=${computeSignature(SECRET, signatureManifest({ dataId: null, requestId, ts }))}`;
    const before = p.calls.getOrder;
    const res = await webhook.handleMercadoPagoWebhook(
      new Request("http://localhost/api/webhooks/mercadopago?type=order", { method: "POST", headers: { "x-signature": sig, "x-request-id": requestId }, body: JSON.stringify({ type: "order", data: { id: "ORDQUALQUER" } }) }),
      { db: db(), providers: p.providers, secret: SECRET, production: false },
    );
    expect(res.status).toBe(400);
    expect(p.calls.getOrder).toBe(before);
    expect(await eventsOf("ORDQUALQUER")).toHaveLength(0);
  });

  it("pagamento de OUTRA cobrança com a mesma referência (order diferente da vinculada) → revisão sem crédito", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    const foreign = p.plantForeignOrder(intent);
    expect((await notify(p, foreign)).body.outcome).toBe("review");
    await untouched(student);
    expect((await intentDoc(intent)).review).toMatchObject({ reason: "order_mismatch" });
  });

  it("order desconhecida (ex.: 'Simular notificação' do painel) ou de referência alheia: 200, evento registrado, nada creditado", async () => {
    const p = fakeMercadoPago();
    const r = await notify(p, "ORDINEXISTENTE0001");
    expect(r).toMatchObject({ status: 200, body: { outcome: "unknown_order" } });
    expect((await eventsOf("ORDINEXISTENTE0001")).map((e) => e.outcome)).toEqual(["unknown_order"]);
    // order do provedor cuja referência não é de nenhuma intenção nossa
    const student = await newStudent();
    const intent = await newIntent(p, student);
    p.pay(intent, { externalReference: "pedido-externo-qualquer" });
    expect((await notify(p, intent)).body.outcome).toBe("unknown_order");
    await untouched(student);
  });

  it("payload incoerente ou tópico irrelevante: 400 / 200 ignorado, sem consulta ao provedor", async () => {
    const p = fakeMercadoPago();
    const before = p.calls.getOrder;
    const ts = String(Date.now());
    const sign = (id: string, rid: string) => `ts=${ts},v1=${computeSignature(SECRET, signatureManifest({ dataId: id, requestId: rid, ts }))}`;
    const send = async (query: string, body: unknown, id: string) => {
      const rid = randomUUID();
      const res = await webhook.handleMercadoPagoWebhook(new Request(`http://localhost/x?${query}`, { method: "POST", headers: { "x-signature": sign(id, rid), "x-request-id": rid }, body: typeof body === "string" ? body : JSON.stringify(body) }), { db: db(), providers: p.providers, secret: SECRET, production: false });
      return { status: res.status, body: (await res.json()) as Json };
    };
    expect((await send("data.id=ORDA1", "não é json", "ORDA1")).status).toBe(400);
    expect((await send("data.id=ORDA1", { type: "order", data: { id: "ORDB2" } }, "ORDA1")).status).toBe(400); // data.id do corpo ≠ assinado
    expect(await send("data.id=PAY1&type=payment", { type: "payment", action: "payment.created", data: { id: "PAY1" } }, "PAY1")).toMatchObject({ status: 200, body: { ignored: "topic" } });
    expect(p.calls.getOrder).toBe(before);
  });
});

/* ------------------------------------------------------------------------------------------------- fora de ordem */

describe("eventos fora de ordem e repetidos não corrompem o estado (A05)", () => {
  it("'pendente' tardio depois de pago e falha/expiração tardias não rebaixam o crédito", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    await notify(p, intent, { action: "order.processed", version: 5 });
    // o provedor (ou uma consulta atrasada) volta a informar estados anteriores
    for (const state of ["pending", "failed", "expired", "unknown"] as const) {
      if (state === "pending") p.pending(intent);
      else if (state === "failed") p.fail(intent);
      else if (state === "expired") p.expire(intent);
      else p.unknownStatus(intent);
      const r = await notify(p, intent, { action: `order.${state}`, version: 1 });
      expect(r.status).toBe(200);
      expect((await intentDoc(intent)).status).toBe("confirmed");
    }
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    expect(await entriesOf(student)).toHaveLength(1);
  });

  it("a notificação de 'pago' chega ANTES do 'pendente' mais antigo: vale o estado atual do provedor, crédito único", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    const [a, b] = await Promise.all([notify(p, intent, { action: "order.created", version: 1 }), notify(p, intent, { action: "order.processed", version: 2 })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await intentDoc(intent)).status).toBe("confirmed");
    expect(await entriesOf(student)).toHaveLength(1);
  });

  it("falha do provedor na consulta: 503 (o provedor reenvia), nada muda; a reentrega seguinte credita UMA vez", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    p.script.failGet = 2;
    expect((await notify(p, intent)).status).toBe(503);
    expect((await notify(p, intent)).status).toBe(503);
    await untouched(student);
    expect((await intentDoc(intent)).status).toBe("awaiting_payment");
    expect((await notify(p, intent)).body.outcome).toBe("credited");
    expect(await entriesOf(student)).toHaveLength(1);
  });

  it("falha INTERMEDIÁRIA na transação (auditoria já existente) não grava nada; depois de sanada, um reprocessamento credita uma vez", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    await db().doc(`auditLog/${intent}__credit`).create({ action: "obstaculo" }); // o último passo da transação vai falhar
    const r = await notify(p, intent);
    expect(r.status).toBe(500);
    await untouched(student);
    expect((await intentDoc(intent)).status).toBe("awaiting_payment");
    expect(await eventsOf(p.orderIdOf(intent))).toHaveLength(0);
    await db().doc(`auditLog/${intent}__credit`).delete();
    expect((await notify(p, intent)).body.outcome).toBe("credited");
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    expect(await entriesOf(student)).toHaveLength(1);
    await ledgerOk(student);
  });

  it("pagamento recusado/expirado pelo provedor encerra a intenção sem crédito; um pagamento posterior da mesma cobrança ainda credita (A06)", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.fail(intent);
    expect((await notify(p, intent)).body.outcome).toBe("failed");
    expect((await intentDoc(intent)).status).toBe("failed");
    await untouched(student);
    p.pay(intent);
    expect((await notify(p, intent, { version: 9 })).body.outcome).toBe("credited");
    expect((await intentDoc(intent)).confirmation).toMatchObject({ afterExpiry: true });
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
  });
});

/* ------------------------------------------------------------------------------------------------- A06 */

describe("timeout de criação e pagamento depois da expiração local (A06)", () => {
  it("timeout na criação (cobrança EXISTE, resposta perdida) + pagamento confirmado: crédito único; a conciliação posterior não duplica nada", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    p.script.loseCreateResponse = true;
    const v = await intents.createTopupIntent(db(), actor(guardianA), pixBody(student), { providers: p.providers });
    expect(v.status).toBe("creation_uncertain");
    expect(p.calls.create).toBe(1);
    p.pay(v.intentId);
    expect((await notify(p, v.intentId)).body.outcome).toBe("credited");
    const d = await intentDoc(v.intentId);
    expect(d).toMatchObject({ status: "confirmed", charge: { id: p.orderIdOf(v.intentId) } });
    // conciliação da criação depois: não é mais necessária, não cria cobrança nem crédito
    const rec = await reconcileMod.reconcileAndConfirm(db(), actor(guardianA), v.intentId, {}, deps(p));
    expect(rec).toMatchObject({ status: "confirmed", reconcile: "not_needed", credited: true });
    expect(p.calls.create).toBe(1);
    expect(await entriesOf(student)).toHaveLength(1);
    await ledgerOk(student);
  });

  it("timeout na criação sem webhook: a conciliação encontra a cobrança e a consulta confirmatória credita em UMA chamada", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    p.script.loseCreateResponse = true;
    const v = await intents.createTopupIntent(db(), actor(guardianA), pixBody(student), { providers: p.providers });
    p.pay(v.intentId);
    const rec = await reconcileMod.reconcileAndConfirm(db(), actor(guardianA), v.intentId, {}, deps(p));
    expect(rec).toMatchObject({ status: "confirmed", credited: true, confirmation: "credited", wallet: { balanceCents: 5000, version: 1 } });
    expect(p.calls.create).toBe(1);
    expect(await entriesOf(student)).toHaveLength(1);
  });

  it("Pix vencido pela validade LOCAL e pago depois: creditado (nada é descartado por expiração local), marcado como tardio", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const past = () => new Date(Date.now() - 3 * 3_600_000);
    const intent = await newIntent(p, student, {}, past);
    const view = await intents.getTopupIntent(db(), actor(guardianA), intent);
    expect(view.displayStatus).toBe("expired");
    p.pay(intent);
    expect((await notify(p, intent)).body.outcome).toBe("credited");
    const d = await intentDoc(intent);
    expect(d).toMatchObject({ status: "confirmed", confirmation: { afterExpiry: true } });
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    expect(await intents.getTopupIntent(db(), actor(guardianA), intent)).toMatchObject({ credited: true, credit: { afterExpiry: true } });
  });

  it("intenção já 'expirada' pelo provedor e depois paga: creditada uma vez", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.expire(intent);
    expect((await notify(p, intent)).body.outcome).toBe("expired");
    expect((await intentDoc(intent)).status).toBe("expired");
    p.pay(intent);
    expect((await notify(p, intent, { version: 2 })).body.outcome).toBe("credited");
    expect(await entriesOf(student)).toHaveLength(1);
  });

  it("notificação perdida: a varredura (rotina agendada/manual) recupera pagamento tardio, falha e reversão — idempotente", async () => {
    const p = fakeMercadoPago();
    const s1 = await newStudent();
    const s2 = await newStudent();
    const i1 = await newIntent(p, s1);
    const i2 = await newIntent(p, s2);
    p.pay(i1);
    p.fail(i2);
    const first = await confirmation.sweepIntents(db(), deps(p), { limit: 300 });
    expect(first.credited).toBeGreaterThanOrEqual(1);
    expect(first.closed).toBeGreaterThanOrEqual(1);
    expect((await intentDoc(i1)).status).toBe("confirmed");
    expect((await intentDoc(i1)).confirmation).toMatchObject({ source: "sweep" });
    expect((await intentDoc(i2)).status).toBe("failed");
    const second = await confirmation.sweepIntents(db(), deps(p), { limit: 300 });
    expect(second.credited).toBe(0);
    expect(await entriesOf(s1)).toHaveLength(1);
    // reembolso detectado só pela varredura
    p.refund(i1);
    const third = await confirmation.sweepIntents(db(), deps(p), { limit: 300 });
    expect(third.reversals).toBeGreaterThanOrEqual(1);
    expect((await intentDoc(i1)).status).toBe("reversed");
    expect(await walletOf(s1)).toMatchObject({ balance: 0, pending: 0 });
    await ledgerOk(s1);
  });

  it("conciliação pela tela: só responsável vinculado ou administração; outra família e cantina/secretaria são recusadas", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    await expect(reconcileMod.reconcileAndConfirm(db(), actor(guardianB), intent, {}, deps(p))).rejects.toThrow();
    await expect(reconcileMod.reconcileAndConfirm(db(), actor(cantina, "cantina"), intent, {}, deps(p))).rejects.toThrow();
    await expect(reconcileMod.reconcileAndConfirm(db(), actor(secretaria, "secretaria"), intent, {}, deps(p))).rejects.toThrow();
    await untouched(student);
    const ok = await reconcileMod.reconcileAndConfirm(db(), actor(admin, "admin"), intent, {}, deps(p));
    expect(ok).toMatchObject({ credited: true });
    expect((await intentDoc(intent)).confirmation).toMatchObject({ source: "admin" });
    // pela rota: família B recebe 403
    const forb = await call(reconcileRoute, guardianB, "POST", `/api/topups/online/${intent}/reconcile`, {}, intent);
    expect(forb.status).toBe(403);
  });

  it("rotina agendada: exige CRON_SECRET (503 sem, 401 errado) e executa a varredura com o segredo correto", async () => {
    delete process.env.CRON_SECRET;
    expect((await call(cronRoute, null, "GET", "/api/cron/payments-reconcile")).status).toBe(503);
    process.env.CRON_SECRET = `cron-teste-${randomUUID()}`;
    try {
      expect((await call(cronRoute, null, "GET", "/api/cron/payments-reconcile")).status).toBe(401);
      expect((await call(cronRoute, null, "GET", "/api/cron/payments-reconcile", undefined, "", { authorization: "Bearer errado" })).status).toBe(401);
      // com o segredo certo e sem provedor configurado neste ambiente, a varredura roda e nada é creditado
      const ok = await call(cronRoute, null, "GET", "/api/cron/payments-reconcile", undefined, "", { authorization: `Bearer ${process.env.CRON_SECRET}` });
      expect(ok.status).toBe(200);
      expect(ok.body.sweep).toMatchObject({ credited: 0, reversals: 0 });
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it("carteira com teto de saldo: crédito que ultrapassa o limite vai para revisão, sem crédito parcial nem erro repetido", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    await db().doc(`wallets/${student}`).set({ studentId: student, currency: "BRL", balanceCents: MAX_BALANCE_CENTS - 100, version: 1 });
    await db().doc(`wallets/${student}/entries/seed`).set({ type: "adjustment", seq: 1, amountCents: MAX_BALANCE_CENTS - 100, balanceAfterCents: MAX_BALANCE_CENTS - 100 });
    p.pay(intent);
    expect(await notify(p, intent)).toMatchObject({ status: 200, body: { outcome: "review" } });
    expect((await intentDoc(intent)).review).toMatchObject({ reason: "balance_limit" });
    expect((await walletOf(student)).balance).toBe(MAX_BALANCE_CENTS - 100);
  });
});

/* ------------------------------------------------------------------------------------------------- A31 */

async function credited(p: FakeMercadoPago, student: string, amountCents = 5000) {
  const intent = await newIntent(p, student, { amountCents });
  p.pay(intent);
  expect((await notify(p, intent)).body.outcome).toBe("credited");
  return intent;
}

describe("reembolso e chargeback (A31)", () => {
  it("reembolso TOTAL com saldo disponível: NOVO lançamento negativo, carteira regularizada, sem pendência nem bloqueio", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    p.refund(intent);
    expect(await notify(p, intent, { action: "order.refunded", version: 10 })).toMatchObject({ status: 200, body: { outcome: "reversal_applied" } });
    expect(await walletOf(student)).toEqual({ balance: 0, version: 2, pending: 0 });
    const entries = await entriesOf(student);
    expect(entries.map((e) => [e.type, e.amountCents])).toEqual([["topup", 5000], ["topup_reversal", -5000]]);
    expect(entries[0]).toMatchObject({ id: `${intent}_credit` }); // o lançamento original NÃO foi alterado
    expect(await intentDoc(intent)).toMatchObject({ status: "reversed", reversal: { accountedCents: 5000, recoveredCents: 5000, pendingCents: 0, cause: "refund" } });
    expect((await db().doc(`paymentPendencies/${intent}`).get()).exists).toBe(false);
    expect(await auditActions(intent)).toContain("topup.online.reversal");
    await ledgerOk(student);
    expect(await intents.getTopupIntent(db(), actor(guardianA), intent)).toMatchObject({ status: "reversed", credited: true, statusLabel: "Revertida", reversal: { accountedCents: 5000, pendingCents: 0 } });
  });

  it("reversão duplicada, repetida e concorrente ×6 é aplicada UMA vez", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    p.chargeback(intent);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => notify(p, intent, { action: "order.chargeback", version: 20 + i })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    await notify(p, intent, { action: "order.chargeback", version: 20 });
    expect((await entriesOf(student)).filter((e) => e.type === "topup_reversal")).toHaveLength(1);
    expect(await walletOf(student)).toEqual({ balance: 0, version: 2, pending: 0 });
    expect((await intentDoc(intent)).reversal).toMatchObject({ accountedCents: 5000, cause: "chargeback" });
    await ledgerOk(student);
  });

  it("crédito JÁ CONSUMIDO: recupera só o saldo, abre pendência do restante, bloqueia novas despesas e nunca deixa saldo negativo", async () => {
    const student = await newStudent();
    const other = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    await walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: student, toStudentId: other, amountCents: 3800, reason: "Consumo simulado" });
    expect((await walletOf(student)).balance).toBe(1200);
    p.chargeback(intent);
    expect(await notify(p, intent)).toMatchObject({ status: 200, body: { outcome: "reversal_applied" } });
    expect(await walletOf(student)).toEqual({ balance: 0, version: 3, pending: 3800 });
    expect(await intentDoc(intent)).toMatchObject({ status: "reversed", reversal: { accountedCents: 5000, recoveredCents: 1200, pendingCents: 3800, cause: "chargeback" } });
    const pend = (await db().doc(`paymentPendencies/${intent}`).get()).data()!;
    expect(pend).toMatchObject({ status: "open", openedCents: 3800, outstandingCents: 3800, studentId: student, cause: "chargeback" });
    expect((await entriesOf(student)).at(-1)).toMatchObject({ type: "topup_reversal", amountCents: -1200, balanceAfterCents: 0 });
    await ledgerOk(student);

    // novas despesas bloqueadas (transferência de saída), mesmo havendo saldo vindo de um novo crédito
    await topupCommands.registerManualTopup(db(), actor(secretaria, "secretaria"), { key: randomUUID(), studentId: student, amountCents: 2000, method: "cash", receivedConfirmed: true });
    await expect(walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: student, toStudentId: other, amountCents: 100, reason: "Tentativa bloqueada" })).rejects.toMatchObject({ code: "wallet_blocked", details: { pendingCents: 3800 } });
    // receber transferência e crédito continua permitido; a carteira da outra família não é afetada
    await walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: other, toStudentId: student, amountCents: 100, reason: "Entrada permitida" });
    expect((await walletOf(other)).pending).toBe(0);
    const reading = await walletQueries.readWallet(db(), actor(guardianA), student);
    expect(reading).toMatchObject({ pendingReversalCents: 3800 });
    await ledgerOk(student);
  });

  it("reembolso PARCIAL acumulado: cada acréscimo vira um lançamento, repetição não duplica, o total fecha em 'revertida' e a carteira reconcilia", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    p.set(intent, { state: "partially_refunded", providerStatus: "processed/partially_refunded", reversedCents: 2000 });
    expect((await notify(p, intent, { action: "order.refunded", version: 40 })).body.outcome).toBe("reversal_applied");
    expect(await walletOf(student)).toEqual({ balance: 3000, version: 2, pending: 0 });
    expect(await intentDoc(intent)).toMatchObject({ status: "confirmed", reversal: { accountedCents: 2000, recoveredCents: 2000, pendingCents: 0 } });
    // repetida e concorrente: nada muda
    const repeats = await Promise.all(Array.from({ length: 4 }, (_, i) => notify(p, intent, { action: "order.refunded", version: 41 + i })));
    for (const r of repeats) expect(r).toMatchObject({ status: 200, body: { outcome: "noop" } });
    expect(await walletOf(student)).toEqual({ balance: 3000, version: 2, pending: 0 });
    expect(await intents.getTopupIntent(db(), actor(guardianA), intent)).toMatchObject({ status: "confirmed", credited: true, reversal: { accountedCents: 2000 } });
    // o provedor devolve o restante (acumulado 5000)
    p.set(intent, { state: "refunded", providerStatus: "refunded/refunded", reversedCents: 5000 });
    expect((await notify(p, intent, { action: "order.refunded", version: 50 })).body.outcome).toBe("reversal_applied");
    expect((await entriesOf(student)).map((e) => [e.type, e.amountCents])).toEqual([["topup", 5000], ["topup_reversal", -2000], ["topup_reversal", -3000]]);
    expect(await walletOf(student)).toEqual({ balance: 0, version: 3, pending: 0 });
    expect((await intentDoc(intent)).status).toBe("reversed");
    // o acumulado nunca diminui: informação mais antiga do provedor não desfaz nada
    p.set(intent, { state: "partially_refunded", reversedCents: 1000 });
    await notify(p, intent, { action: "order.updated", version: 51 });
    expect(await walletOf(student)).toEqual({ balance: 0, version: 3, pending: 0 });
    await ledgerOk(student);
  });

  it("reembolso/chargeback ANTES do crédito: devolução total = sem crédito; chargeback = revisão humana", async () => {
    const p = fakeMercadoPago();
    const s1 = await newStudent();
    const i1 = await newIntent(p, s1);
    p.refund(i1);
    expect(await notify(p, i1, { action: "order.refunded" })).toMatchObject({ body: { outcome: "failed" } });
    expect((await intentDoc(i1)).failure).toMatchObject({ code: "refunded_before_credit" });
    await untouched(s1);
    const s2 = await newStudent();
    const i2 = await newIntent(p, s2);
    p.chargeback(i2);
    expect(await notify(p, i2, { action: "order.chargeback" })).toMatchObject({ body: { outcome: "review" } });
    expect((await intentDoc(i2)).review).toMatchObject({ reason: "reversal_before_credit" });
    await untouched(s2);
  });

  it("status de reversão não reconhecido (ex.: reembolso parcial sem valor confirmado) NUNCA altera a carteira", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    p.unknownStatus(intent);
    expect((await notify(p, intent, { action: "order.updated", version: 30 })).body.outcome).toBe("noop");
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    expect((await intentDoc(intent)).status).toBe("confirmed");
  });
});

/* ------------------------------------------------------------------------------------------------- revisão administrativa */

describe("revisão administrativa: pendências e divergências (A31)", () => {
  async function pendency(balanceAfterSpend = 1200) {
    const student = await newStudent();
    const other = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    await walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: student, toStudentId: other, amountCents: 5000 - balanceAfterSpend, reason: "Consumo simulado" });
    p.refund(intent);
    await notify(p, intent, { action: "order.refunded" });
    return { student, other, intent, p };
  }

  it("lista só para a administração: pendências com saldo atual e divergências em revisão; demais papéis 403", async () => {
    const { student, intent } = await pendency();
    const p2 = fakeMercadoPago();
    const s2 = await newStudent();
    const i2 = await newIntent(p2, s2);
    p2.pay(i2, { paidCents: 100 });
    await notify(p2, i2);
    for (const user of [guardianA, secretaria, cantina]) expect((await call(listRoute, user, "GET", "/api/admin/payments")).status).toBe(403);
    expect((await call(listRoute, null, "GET", "/api/admin/payments")).status).toBe(401);
    const r = await call(listRoute, admin, "GET", "/api/admin/payments");
    expect(r.status).toBe(200);
    const body = r.body as unknown as { pendencies: { intentId: string; outstandingCents: number; walletBalanceCents: number; studentName: string }[]; reviews: { intentId: string; reason: string; label: string }[] };
    expect(body.pendencies.find((x) => x.intentId === intent)).toMatchObject({ outstandingCents: 3800, walletBalanceCents: 0 });
    expect(body.reviews.find((x) => x.intentId === i2)).toMatchObject({ reason: "amount_mismatch" });
    expect(JSON.stringify(body)).not.toMatch(/@example|payer/);
    expect(student).toBeTruthy();
  });

  it("regularizar: sem saldo recusa; com novo crédito debita até o pendente (novo lançamento), libera o bloqueio e a carteira volta a gastar", async () => {
    const { student, other, intent } = await pendency();
    const key = randomUUID();
    const body = { key, action: "recover", expectedOutstandingCents: 3800, reason: "Regularização depois da recarga" };
    await expect(pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...body, pendencyId: intent })).rejects.toMatchObject({ code: "nothing_to_recover" });
    await topupCommands.registerManualTopup(db(), actor(secretaria, "secretaria"), { key: randomUUID(), studentId: student, amountCents: 5000, method: "cash", receivedConfirmed: true });
    const first = await pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...body, pendencyId: intent });
    expect(first).toMatchObject({ replayed: false, appliedCents: 3800, outstandingCents: 0, status: "resolved", wallet: { balanceCents: 1200, pendingReversalCents: 0 } });
    const again = await pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...body, pendencyId: intent });
    expect(again).toMatchObject({ replayed: true, appliedCents: 3800 });
    expect(await walletOf(student)).toMatchObject({ balance: 1200, pending: 0 });
    expect((await entriesOf(student)).filter((e) => e.type === "topup_reversal").map((e) => e.amountCents)).toEqual([-1200, -3800]);
    expect(await auditActions(intent)).toContain("payments.pendency.recover");
    await ledgerOk(student);
    // desbloqueada: gasta de novo
    await walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: student, toStudentId: other, amountCents: 100, reason: "Depois de regularizar" });
    // pendência fechada não é regularizada de novo
    await expect(pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...body, key: randomUUID(), pendencyId: intent })).rejects.toMatchObject({ code: "pendency_closed" });
  });

  it("absorver (write_off): só administração, motivo obrigatório, sem lançamento no livro, tela desatualizada recusada, ×4 concorrentes aplicam uma vez", async () => {
    const { student, intent } = await pendency();
    const base = { action: "write_off", expectedOutstandingCents: 3800, reason: "Perda assumida pela escola, autorizada" };
    await expect(pendenciesMod.resolvePendency(db(), actor(secretaria, "secretaria"), { ...base, key: randomUUID(), pendencyId: intent })).rejects.toThrow();
    await expect(pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...base, key: randomUUID(), pendencyId: intent, reason: "curto" })).rejects.toThrow();
    await expect(pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...base, key: randomUUID(), pendencyId: intent, expectedOutstandingCents: 1000 })).rejects.toMatchObject({ code: "stale_pendency" });
    const before = await entriesOf(student);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...base, key: randomUUID(), pendencyId: intent })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await entriesOf(student)).toEqual(before);
    expect(await walletOf(student)).toMatchObject({ pending: 0 });
    expect((await db().doc(`paymentPendencies/${intent}`).get()).data()).toMatchObject({ status: "resolved", outstandingCents: 0, writtenOffCents: 3800 });
    const viaRoute = await call(resolveRoute, guardianA, "POST", `/api/admin/payments/pendencies/${intent}/resolve`, { ...base, key: randomUUID() }, intent);
    expect(viaRoute.status).toBe(403);
  });

  it("divergência em revisão: um pagamento correto depois credita e limpa a revisão", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent, { paidCents: 4000 });
    await notify(p, intent);
    expect((await intentDoc(intent)).status).toBe("in_review");
    p.pay(intent);
    expect((await notify(p, intent, { version: 3 })).body.outcome).toBe("credited");
    const d = await intentDoc(intent);
    expect(d.status).toBe("confirmed");
    expect(d.review).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------------------- isolamento */

describe("isolamento e dados expostos", () => {
  it("coleções de pagamento são fechadas ao cliente e a visão da família não traz dado interno", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    const view = await intents.getTopupIntent(db(), actor(guardianA), intent);
    expect(JSON.stringify(view)).not.toMatch(/accountId|paymentId|ORDFAKE|example\.test|externalReference|requestId|createdBy/);
    await expect(intents.getTopupIntent(db(), actor(guardianB), intent)).rejects.toThrow();
    const list = await intents.listTopupIntents(db(), actor(guardianA), { studentId: student });
    expect(list.intents.find((i) => i.intentId === intent)).toMatchObject({ credited: true });
  });
});

/* ------------------------------------------------------------------------------------------------- outros caminhos */

describe("outros caminhos: cartão, conciliação manual, erros e acúmulo de pendência", () => {
  it("cartão 1x aprovado pelo provedor é creditado como 'cartão de crédito', uma vez, pelo mesmo caminho do Pix", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const v = await intents.createTopupIntent(
      db(),
      actor(guardianA),
      { key: randomUUID(), studentId: student, amountCents: 5000, channel: "card", installments: 1, cardToken: `tok_${randomUUID().slice(0, 12)}`, paymentMethodId: "visa", payer: { email: "pagador@example.test", identification: { type: "CPF", number: "12345678909" } } },
      { providers: p.providers },
    );
    expect(v).toMatchObject({ status: "processing", credited: false });
    p.pay(v.intentId);
    const results = await Promise.all([notify(p, v.intentId), notify(p, v.intentId)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const entries = await entriesOf(student);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "topup", amountCents: 5000, method: "card_credit" });
    expect(await intentDoc(v.intentId)).toMatchObject({ status: "confirmed", channel: "card" });
    await ledgerOk(student);
  });

  it("conciliação manual pela administração (rota): família 403; varredura ou uma recarga; entrada inválida 400", async () => {
    const adminReconcile = (await import("@/app/api/admin/payments/reconcile/route")).POST as unknown as Handler;
    const url = "/api/admin/payments/reconcile";
    expect((await call(adminReconcile, guardianA, "POST", url, {})).status).toBe(403);
    expect((await call(adminReconcile, null, "POST", url, {})).status).toBe(401);
    const sweep = await call(adminReconcile, admin, "POST", url, { limit: 5 });
    expect(sweep.status).toBe(200);
    expect(sweep.body.sweep).toMatchObject({ checked: expect.any(Number), credited: 0 });
    const one = await call(adminReconcile, admin, "POST", url, { intentId: "tpi_00000000000000000000" });
    expect(one).toMatchObject({ status: 200, body: { result: { outcome: "unknown_order" } } });
    for (const bad of [{ limit: 0 }, { limit: 1000 }, { intentId: "x" }, { outro: 1 }]) expect((await call(adminReconcile, admin, "POST", url, bad)).status).toBe(400);
  });

  it("sem provedor configurado a confirmação é indisponível (503) e nada é gravado", async () => {
    await expect(confirmation.confirmFromProvider(db(), { providers: { pix: null, card: null } }, "ORDX", { source: "admin" })).rejects.toMatchObject({ code: "payment_unavailable", status: 503 });
  });

  it("order do provedor com referência válida mas sem intenção, e entregas idênticas: 200, um único evento", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    const base = p.orders.get(p.orderIdOf(intent))!;
    p.orders.set("ORDGHOST1", { ...base, orderId: "ORDGHOST1", externalReference: "tpi_ffffffffffffffffffff", state: "paid", paidCents: base.totalCents });
    const T = Date.now();
    for (let i = 0; i < 2; i += 1) expect(await notify(p, "ORDGHOST1", { requestId: "rq-ghost", ts: T })).toMatchObject({ status: 200, body: { outcome: "unknown_order" } });
    expect(await eventsOf("ORDGHOST1")).toHaveLength(1);
    // order que o provedor não conhece, entregue duas vezes com a mesma assinatura: um evento só
    for (let i = 0; i < 2; i += 1) expect(await notify(p, "ORDNAOEXISTE2", { requestId: "rq-x", ts: T })).toMatchObject({ status: 200, body: { outcome: "unknown_order" } });
    expect(await eventsOf("ORDNAOEXISTE2")).toHaveLength(1);
    await untouched(student);
  });

  it("reversão que se soma a pendência já aberta: acumula, não cria outra e mantém a carteira bloqueada", async () => {
    const student = await newStudent();
    const other = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    await walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: student, toStudentId: other, amountCents: 5000, reason: "Consumo simulado" });
    p.set(intent, { state: "partially_refunded", providerStatus: "processed/partially_refunded", reversedCents: 2000 });
    expect((await notify(p, intent, { action: "order.refunded", version: 60 })).body.outcome).toBe("reversal_applied");
    expect((await db().doc(`paymentPendencies/${intent}`).get()).data()).toMatchObject({ status: "open", openedCents: 2000, outstandingCents: 2000 });
    expect(await walletOf(student)).toMatchObject({ balance: 0, pending: 2000 });
    p.set(intent, { state: "refunded", providerStatus: "refunded/refunded", reversedCents: 5000 });
    expect((await notify(p, intent, { action: "order.refunded", version: 61 })).body.outcome).toBe("reversal_applied");
    expect((await db().doc(`paymentPendencies/${intent}`).get()).data()).toMatchObject({ status: "open", openedCents: 5000, outstandingCents: 5000, cause: "refund" });
    expect(await walletOf(student)).toMatchObject({ balance: 0, pending: 5000 });
    expect((await intentDoc(intent)).reversal).toMatchObject({ accountedCents: 5000, recoveredCents: 0, pendingCents: 5000 });
    expect((await entriesOf(student)).filter((e) => e.type === "topup_reversal")).toHaveLength(0); // sem saldo, nenhum lançamento negativo
    await ledgerOk(student);
  });

  it("regularização PARCIAL pela administração e valor acima do possível", async () => {
    const student = await newStudent();
    const other = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    await walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: student, toStudentId: other, amountCents: 5000, reason: "Consumo simulado" });
    p.refund(intent);
    await notify(p, intent, { action: "order.refunded", version: 70 });
    await topupCommands.registerManualTopup(db(), actor(secretaria, "secretaria"), { key: randomUUID(), studentId: student, amountCents: 2000, method: "cash", receivedConfirmed: true });
    const base = { action: "recover", expectedOutstandingCents: 5000, reason: "Regularização parcial autorizada", pendencyId: intent };
    await expect(pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...base, key: randomUUID(), amountCents: 3000 })).rejects.toMatchObject({ code: "exceeds_available", details: { maxCents: 2000 } });
    const part = await pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...base, key: randomUUID(), amountCents: 500 });
    expect(part).toMatchObject({ appliedCents: 500, outstandingCents: 4500, status: "open", wallet: { balanceCents: 1500, pendingReversalCents: 4500 } });
    await expect(pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...base, key: randomUUID() })).rejects.toMatchObject({ code: "stale_pendency" });
    await expect(pendenciesMod.resolvePendency(db(), actor(admin, "admin"), { ...base, key: randomUUID(), pendencyId: "tpi_00000000000000000000" })).rejects.toMatchObject({ code: "pendency_not_found" });
    await ledgerOk(student);
  });

  it("falha na consulta de uma intenção NÃO interrompe a varredura; erro inesperado do provedor na conciliação pela tela é propagado", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.pay(intent);
    p.script.failGet = 10_000;
    const summary = await confirmation.sweepIntents(db(), deps(p), { limit: 300 });
    expect(summary.lookupFailed).toBeGreaterThanOrEqual(1);
    expect(summary.credited).toBe(0);
    p.script.failGet = 0;
    await untouched(student);
    const flaky = {
      ...p.pix,
      getOrder: async () => {
        throw new TypeError("falha inesperada");
      },
    };
    await expect(reconcileMod.reconcileAndConfirm(db(), actor(guardianA), intent, {}, { providers: { pix: flaky, card: null } })).rejects.toThrow("falha inesperada");
    await untouched(student);
    expect((await confirmation.sweepIntents(db(), deps(p), { limit: 300 })).credited).toBeGreaterThanOrEqual(1);
    expect(await entriesOf(student)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------------------- contestações */

describe("contestação (chargeback): em andamento ≠ perdida; pagamento sem recarga fica visível", () => {
  type Review = { disputes: { intentId: string; dispute: string }[]; orphans: { orderId: string; reference: string; amountCents: number }[] };
  const reviewList = async () => (await call(listRoute, admin, "GET", "/api/admin/payments")).body as unknown as Review;

  it("contestação ABERTA não debita, não abre pendência nem bloqueia; fica visível; repetir não cria versões; a família é avisada", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    p.disputeOpen(intent);
    expect(await notify(p, intent, { action: "order.charged_back", version: 80 })).toMatchObject({ status: 200, body: { outcome: "noop" } });
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    expect((await db().doc(`paymentPendencies/${intent}`).get()).exists).toBe(false);
    const doc = await intentDoc(intent);
    expect(doc).toMatchObject({ status: "confirmed", dispute: { status: "open" }, reversal: { accountedCents: 0 } });
    const version = doc.version as number;
    await notify(p, intent, { action: "order.charged_back", version: 81 });
    expect((await intentDoc(intent)).version).toBe(version);
    expect(await intents.getTopupIntent(db(), actor(guardianA), intent)).toMatchObject({ status: "confirmed", credited: true, contested: true });
    expect((await reviewList()).disputes).toEqual(expect.arrayContaining([expect.objectContaining({ intentId: intent, dispute: "open" })]));
    // a carteira continua livre para gastar
    const other = await newStudent();
    await walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: student, toStudentId: other, amountCents: 100, reason: "Gasto durante a disputa" });
    await ledgerOk(student);
  });

  it("contestação aberta e depois PERDIDA (settled): só então debita, até o saldo, com pendência do restante; 'aberta' tardia não regride", async () => {
    const student = await newStudent();
    const other = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    p.disputeOpen(intent);
    await notify(p, intent, { action: "order.charged_back", version: 90 });
    await walletCommands.transferBetweenWallets(db(), actor(guardianA), { key: randomUUID(), fromStudentId: student, toStudentId: other, amountCents: 3800, reason: "Consumo durante a disputa" });
    p.chargeback(intent);
    expect((await notify(p, intent, { action: "order.charged_back", version: 91 })).body.outcome).toBe("reversal_applied");
    expect(await walletOf(student)).toEqual({ balance: 0, version: 3, pending: 3800 });
    expect(await intentDoc(intent)).toMatchObject({ status: "reversed", dispute: { status: "lost" }, reversal: { accountedCents: 5000, recoveredCents: 1200, pendingCents: 3800, cause: "chargeback" } });
    // notificação atrasada de 'em andamento' depois de perdida: nada muda
    p.disputeOpen(intent);
    await notify(p, intent, { action: "order.charged_back", version: 92 });
    expect(await walletOf(student)).toEqual({ balance: 0, version: 3, pending: 3800 });
    expect((await intentDoc(intent)).dispute).toMatchObject({ status: "lost" });
    await ledgerOk(student);
  });

  it("contestação PERDIDA parcial usa o valor contestado (não o total) e mantém a recarga confirmada", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    p.chargeback(intent, 2000);
    expect((await notify(p, intent, { action: "order.charged_back", version: 95 })).body.outcome).toBe("reversal_applied");
    expect(await walletOf(student)).toEqual({ balance: 3000, version: 2, pending: 0 });
    expect(await intentDoc(intent)).toMatchObject({ status: "confirmed", reversal: { accountedCents: 2000, cause: "chargeback" } });
  });

  it("contestação GANHA (reimbursed): limpa o sinal sem tocar na carteira; ganha DEPOIS de debitada vai para a administração sem devolução automática", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await credited(p, student);
    p.disputeOpen(intent);
    await notify(p, intent, { action: "order.charged_back", version: 100 });
    p.disputeWon(intent);
    await notify(p, intent, { action: "order.charged_back", version: 101 });
    expect(await walletOf(student)).toEqual({ balance: 5000, version: 1, pending: 0 });
    expect((await intentDoc(intent)).dispute).toMatchObject({ status: "won" });
    expect((await reviewList()).disputes.some((d) => d.intentId === intent)).toBe(false);
    expect(await intents.getTopupIntent(db(), actor(guardianA), intent)).toMatchObject({ contested: false });

    const s2 = await newStudent();
    const p2 = fakeMercadoPago();
    const i2 = await credited(p2, s2);
    p2.chargeback(i2);
    await notify(p2, i2, { action: "order.charged_back", version: 110 });
    expect(await walletOf(s2)).toMatchObject({ balance: 0, pending: 0 });
    p2.disputeWon(i2);
    expect((await notify(p2, i2, { action: "order.charged_back", version: 111 })).body.outcome).toBe("noop");
    expect((await intentDoc(i2)).dispute).toMatchObject({ status: "won_after_reversal" });
    expect(await walletOf(s2)).toMatchObject({ balance: 0, pending: 0 }); // nenhum crédito automático de volta
    expect((await entriesOf(s2)).map((e) => e.type)).toEqual(["topup", "topup_reversal"]);
    expect((await reviewList()).disputes).toEqual(expect.arrayContaining([expect.objectContaining({ intentId: i2, dispute: "won_after_reversal" })]));
    await ledgerOk(s2);
  });

  it("pagamento disputado SEM crédito: revisão humana (nem crédito nem devolução automática)", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    p.disputeOpen(intent);
    expect((await notify(p, intent, { action: "order.charged_back", version: 120 })).body.outcome).toBe("review");
    await untouched(student);
    expect((await intentDoc(intent)).review).toMatchObject({ reason: "reversal_before_credit" });
  });

  it("pagamento PAGO numa order da nossa conta cuja referência não é de nenhuma recarga fica visível para a administração; order pendente de outro sistema, não", async () => {
    const student = await newStudent();
    const p = fakeMercadoPago();
    const intent = await newIntent(p, student);
    const base = p.orders.get(p.orderIdOf(intent))!;
    const paidId = `ORDORFA${randomUUID().slice(0, 8).toUpperCase()}`;
    const pendingId = `ORDPEND${randomUUID().slice(0, 8).toUpperCase()}`;
    p.orders.set(paidId, { ...base, orderId: paidId, externalReference: "venda-externa-123", state: "paid", paidCents: 777, totalCents: 777 });
    p.orders.set(pendingId, { ...base, orderId: pendingId, externalReference: "venda-externa-456", state: "pending" });
    expect(await notify(p, paidId)).toMatchObject({ status: 200, body: { outcome: "unknown_order" } });
    expect(await notify(p, pendingId)).toMatchObject({ status: 200, body: { outcome: "unknown_order" } });
    const list = await reviewList();
    expect(list.orphans).toEqual(expect.arrayContaining([expect.objectContaining({ orderId: paidId, reference: "venda-externa-123", amountCents: 777 })]));
    expect(list.orphans.some((o) => o.orderId === pendingId)).toBe(false);
    await untouched(student);
  });
});
