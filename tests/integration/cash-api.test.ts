// Fechamento de caixa por operador, ponto de recebimento e data local (F20) contra Auth/Firestore Emulator. Prova as decisões do dono:
// cada operador fecha SÓ o próprio caixa (a administração consulta tudo, revisa divergências e é a única a reabrir, com motivo,
// preservando as versões); dia sem fechamento gera ALERTA sem bloquear o seguinte; tolerância ZERO; registrar/aprovar diferença NÃO
// cria ajuste em carteira, recebimento, estoque ou livro; saldo inicial informado e confirmado; contagem pelo total; caixas da
// secretaria e do balcão separados; consumo com carteira NÃO é dinheiro novo; movimentos posteriores ao fechamento são identificados
// sem reescrever o fechamento; replay e fechamento concorrente. Dados e valores FICTÍCIOS.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- corpo JSON de resposta lido por muitas asserções
type Json = Record<string, any> & { error?: string };
type Result = { status: number; body: Json };

let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let school: typeof import("@/lib/dates/school-time");
let topupCommands: typeof import("@/modules/payments/topup-commands");
let posCommands: typeof import("@/modules/pos/commands");
const routes: Record<string, Handler> = {};

let admin: TestUser;
let secA: TestUser;
let secB: TestUser;
let secC: TestUser;
let cantinaA: TestUser;
let guardian: TestUser;
let studentUser: TestUser;

const tag = randomUUID().slice(0, 6);
const ST = `csf_${tag}_t`;
const CLS = `ccl_${tag}`;
const CAT = `cct_${tag}`;
let TODAY = "";
let seq = 0;
const noCtx = { params: Promise.resolve({ id: "" }) };
const prices = new Map<string, number>();

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  ({ adminDb } = await import("@/lib/firebase/admin"));
  school = await import("@/lib/dates/school-time");
  topupCommands = await import("@/modules/payments/topup-commands");
  posCommands = await import("@/modules/pos/commands");
  routes["GET cash"] = (await import("@/app/api/cash/route")).GET as unknown as Handler;
  routes["POST open"] = (await import("@/app/api/cash/open/route")).POST as unknown as Handler;
  routes["POST close"] = (await import("@/app/api/cash/close/route")).POST as unknown as Handler;
  routes["GET session"] = (await import("@/app/api/cash/[id]/route")).GET as unknown as Handler;
  routes["GET admin cash"] = (await import("@/app/api/admin/finance/cash/route")).GET as unknown as Handler;
  routes["POST reopen"] = (await import("@/app/api/admin/finance/cash/reopen/route")).POST as unknown as Handler;
  routes["POST review"] = (await import("@/app/api/admin/finance/cash/review/route")).POST as unknown as Handler;
  routes["POST inventory"] = (await import("@/app/api/inventory/receipts/route")).POST as unknown as Handler;
  routes["POST pos sales"] = (await import("@/app/api/pos/sales/route")).POST as unknown as Handler;
  TODAY = school.localDateOf(new Date());
  [admin, secA, secB, secC, cantinaA, guardian, studentUser] = await Promise.all([
    createTestUser("cadm", "admin", { displayName: "Admin Caixa" }),
    createTestUser("csa", "secretaria", { displayName: "Secretaria A" }),
    createTestUser("csb", "secretaria", { displayName: "Secretaria B" }),
    createTestUser("csc", "secretaria", { displayName: "Secretaria C" }),
    createTestUser("ccan", "cantina", { displayName: "Cantina A" }),
    createTestUser("cresp", "guardian"),
    createTestUser("calu", "student"),
  ]);
  await globalDoc(`shifts/${ST}`, { name: `Tarde ${tag}`, nameSlug: "tarde", status: "active" });
  await globalDoc(`classes/${CLS}`, { name: `Turma ${tag}`, nameSlug: "turma", status: "active" });
  await globalDoc(`categories/${CAT}`, { name: `Categoria ${tag}`, status: "active" });
  await globalDoc(`calendarDays/${TODAY}`, { kind: "extra" });
});

const globalDocs: string[] = [];
const globalDoc = async (path: string, data: Record<string, string | number | boolean | null | string[]>) => {
  globalDocs.push(path);
  await writeDemoDoc(targetFromEnv(), path, data);
};
afterAll(async () => {
  for (const path of globalDocs.splice(0)) await db().doc(path).delete();
});

/* ------------------------------------------------------------------------------------------------- apoio */

const db = () => adminDb();
const doc = async (path: string) => (await db().doc(path).get()).data();
const asActor = (u: TestUser, role: "admin" | "secretaria" | "cantina") => ({ uid: u.uid, role });

const daysAgo = (n: number) => school.addDays(TODAY, -n);
const at = (date: string, time = "10:00") => () => school.localInstant(date, time);
const sid = (date: string, point: "secretaria" | "counter", u: TestUser) => `${date}__${point}__${u.uid}`;

async function call(key: string, user: TestUser | null, method: string, url: string, body?: unknown, id = ""): Promise<Result> {
  const response = await routes[key]!(
    new Request(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.idToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    id ? { params: Promise.resolve({ id }) } : noCtx,
  );
  return { status: response.status, body: (await response.json()) as Json };
}
const open = (user: TestUser | null, over: Record<string, unknown> = {}) => call("POST open", user, "POST", "/api/cash/open", { key: randomUUID(), point: "secretaria", openingCents: 10_000, openingConfirmed: true, ...over });
const close = (user: TestUser | null, sessionId: string, over: Record<string, unknown> = {}) => call("POST close", user, "POST", "/api/cash/close", { key: randomUUID(), sessionId, countedCashCents: 0, ...over });
const reopen = (user: TestUser | null, sessionId: string, over: Record<string, unknown> = {}) => call("POST reopen", user, "POST", "/api/admin/finance/cash/reopen", { key: randomUUID(), sessionId, reason: "Faltou lançar um recebimento do período", ...over });
const review = (user: TestUser | null, sessionId: string, over: Record<string, unknown> = {}) => call("POST review", user, "POST", "/api/admin/finance/cash/review", { key: randomUUID(), sessionId, closureNo: 1, decision: "approved", note: "Conferido com o operador, sem ajuste", ...over });
const getSession = (user: TestUser | null, id: string) => call("GET session", user, "GET", `/api/cash/${id}`, undefined, id);
const adminList = (from = daysAgo(6), to = TODAY) => call("GET admin cash", admin, "GET", `/api/admin/finance/cash?from=${from}&to=${to}`);

let refSeq = 0;
const uniqueRef = () => `CX${tag}${Date.now()}${++refSeq}`;
async function newStudent() {
  const id = `cst_${tag}_${++seq}`;
  const name = `Aluno Caixa ${seq}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowCounterPurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, enrollment: `C${tag}${seq}`, status: "active", userUid: null, shiftId: ST, classId: CLS, version: 1 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: true, allowCounterPurchase: true, configVersion: 1 });
  return id;
}
const topup = (by: TestUser, studentId: string, over: Record<string, unknown> = {}, when?: () => Date) =>
  topupCommands.registerManualTopup(db(), asActor(by, "secretaria"), { key: randomUUID(), studentId, amountCents: 5000, method: "cash", receivedConfirmed: true, ...(over.method && over.method !== "cash" ? { reference: uniqueRef() } : {}), ...over }, when);
async function newProduct(price: number, stock = 300) {
  const id = `cpr_${tag}_${++seq}`;
  await globalDoc(`products/${id}`, { name: `Produto ${seq}`, description: "", categoryId: CAT, priceCents: price, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [ST], availabilityMode: "physical", status: "active", version: 1 });
  await globalDoc(`defaultMenuRules/${id}`, { shiftIds: [ST], version: 1 });
  prices.set(id, price);
  const r = await call("POST inventory", admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: stock, unitCost: "1,00" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return id;
}

/** Fotografia dos fatos que o caixa NUNCA pode alterar: carteiras, livro, recebimentos, vendas, pedidos e movimentos de estoque. */
async function financialFacts() {
  const count = async (path: string) => (await db().collection(path).count().get()).data().count;
  const entries = (await db().collectionGroup("entries").count().get()).data().count;
  return { topups: await count("topups"), directSales: await count("directSales"), orders: await count("orders"), wallets: await count("wallets"), entries, intents: await count("topupIntents") };
}

/* ------------------------------------------------------------------------------------- autorização */

describe("autorização e isolamento entre operadores", () => {
  it("só quem opera caixa (secretaria, cantina, administração) acessa; responsável, aluno e anônimo não", async () => {
    for (const user of [secA, cantinaA, admin]) expect((await call("GET cash", user, "GET", "/api/cash")).status, user.email).toBe(200);
    for (const user of [guardian, studentUser]) {
      expect((await call("GET cash", user, "GET", "/api/cash")).status).toBe(403);
      expect((await open(user)).status).toBe(403);
      expect((await close(user, sid(TODAY, "secretaria", user))).status).toBe(403);
    }
    expect((await call("GET cash", null, "GET", "/api/cash")).status).toBe(401);
    expect((await open(null)).status).toBe(401);
    expect((await close(null, sid(TODAY, "secretaria", secA))).status).toBe(401);
    expect((await getSession(null, sid(TODAY, "secretaria", secA))).status).toBe(401);
  });

  it("cada papel só abre o ponto do próprio papel: secretaria na secretaria, cantina no balcão, administração em ambos", async () => {
    expect((await open(secA, { point: "counter" })).status).toBe(403);
    expect((await open(cantinaA, { point: "secretaria" })).status).toBe(403);
    expect(await doc(`cashSessions/${sid(TODAY, "counter", secA)}`)).toBeUndefined();
    expect((await open(admin, { point: "secretaria" })).status).toBe(200);
    expect((await open(admin, { point: "counter" })).status).toBe(200);
  });

  it("o UID nunca vem do corpo (esquema estrito) e o ID do caixa de outro operador é recusado ao fechar e ao ler", async () => {
    expect((await open(secA, { operatorUid: secB.uid })).status).toBe(400);
    const a = await open(secB, { openingCents: 1000 });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const id = a.body.sessionId as string;
    expect((await close(secA, id)).status).toBe(403); // outra secretaria
    expect((await close(admin, id)).status).toBe(403); // nem a administração fecha o caixa alheio
    expect((await close(cantinaA, id)).status).toBe(403);
    expect((await getSession(secA, id)).status).toBe(403);
    expect((await getSession(cantinaA, id)).status).toBe(403);
    expect((await getSession(admin, id)).status).toBe(200); // administração consulta
    expect((await getSession(secB, id)).status).toBe(200);
    expect((await getSession(secB, "id inválido!")).status).toBe(404);
    expect((await doc(`cashSessions/${id}`))!.status).toBe("open");
    // a visão do operador não traz o UID; a da administração traz
    expect((await getSession(secB, id)).body.operatorUid).toBeUndefined();
    expect((await getSession(admin, id)).body.operatorUid).toBe(secB.uid);
  });

  it("revisar, reabrir e listar todos os caixas é só da administração (secretaria e cantina: 403)", async () => {
    const id = sid(TODAY, "secretaria", secB);
    for (const user of [secA, secB, cantinaA, guardian]) {
      expect((await review(user, id)).status).toBe(403);
      expect((await reopen(user, id)).status).toBe(403);
      expect((await call("GET admin cash", user, "GET", "/api/admin/finance/cash")).status).toBe(403);
    }
  });

  it("perfil rebaixado entre a abertura e o fechamento derruba o fechamento (perfil relido na transação)", async () => {
    const temp = await createTestUser("ctmp", "secretaria", { displayName: "Secretaria Temporária" });
    const o = await open(temp);
    expect(o.status).toBe(200);
    await writeDemoDoc(targetFromEnv(), `users/${temp.uid}`, { email: temp.email, displayName: "Secretaria Temporária", role: "guardian", status: "active", permissions: [], accessVersion: 9 });
    expect((await close(temp, o.body.sessionId as string)).status).toBe(403);
    expect((await doc(`cashSessions/${o.body.sessionId}`))!.status).toBe("open");
  });
});

/* ------------------------------------------------------------------------------------------ abertura */

describe("abertura: saldo inicial informado e confirmado; idempotência; datas", () => {
  it("sem confirmação do saldo inicial não abre; valor inválido é recusado", async () => {
    expect((await open(secC, { openingConfirmed: false })).status).toBe(400);
    expect((await open(secC, { openingCents: 10.5 })).status).toBe(400);
    expect((await open(secC, { openingCents: -1 })).status).toBe(400);
    expect(await doc(`cashSessions/${sid(TODAY, "secretaria", secC)}`)).toBeUndefined();
  });

  it("abre com saldo confirmado: sessão, evento e auditoria; repetir a mesma chave devolve o mesmo; outra chave no mesmo caixa = 409", async () => {
    const body = { key: randomUUID(), point: "secretaria", openingCents: 12_345, openingConfirmed: true };
    const r = await call("POST open", secC, "POST", "/api/cash/open", body);
    expect(r).toMatchObject({ status: 200, body: { sessionId: sid(TODAY, "secretaria", secC), date: TODAY, point: "secretaria", status: "open", openingCents: 12_345, replayed: false } });
    expect(await doc(`cashSessions/${r.body.sessionId}`)).toMatchObject({ status: "open", opening: { cents: 12_345, confirmed: true }, operator: { uid: secC.uid, role: "secretaria", name: "Secretaria C" }, closureNo: 0, closure: null, review: null });
    expect((await call("POST open", secC, "POST", "/api/cash/open", body)).body).toMatchObject({ replayed: true, sessionId: r.body.sessionId });
    expect((await call("POST open", secC, "POST", "/api/cash/open", { ...body, openingCents: 999 })).body.error).toBe("idempotency_conflict");
    expect((await open(secC)).body.error).toBe("session_exists");
    const audit = (await db().collection("auditLog").where("target.id", "==", r.body.sessionId).get()).docs.filter((d) => d.get("action") === "cash.open");
    expect(audit).toHaveLength(1);
  });

  it("aberturas simultâneas do mesmo operador/ponto/data: uma vence e as demais recebem 409", async () => {
    const u = await createTestUser("cconc", "secretaria", { displayName: "Secretaria Concorrente" });
    const results = await Promise.all([1, 2, 3, 4].map(() => open(u)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect((await db().collection(`cashSessions/${sid(TODAY, "secretaria", u)}/events`).get()).size).toBe(1);
  });

  it("abertura retroativa só até 7 dias; futuro e data inválida são recusados; operadores diferentes têm caixas diferentes no mesmo dia", async () => {
    const u = await createTestUser("cbf", "secretaria", { displayName: "Secretaria Retroativa" });
    expect((await open(u, { date: daysAgo(7) })).status).toBe(200);
    expect((await open(u, { date: daysAgo(8) })).body.error).toBe("invalid_date");
    expect((await open(u, { date: school.addDays(TODAY, 1) })).body.error).toBe("invalid_date");
    expect((await open(u, { date: "2026-02-30" })).status).toBe(400);
    expect(sid(TODAY, "secretaria", secA)).not.toBe(sid(TODAY, "secretaria", secC));
  });
});

/* ---------------------------------------------------------------------------- fechamento (secretaria) */

describe("fechamento da secretaria: dinheiro, Pix e cartão separados; só os recebimentos DO operador; sem divergência", () => {
  const ctx: { id: string; student: string; closeBody?: { key: string; sessionId: string; countedCashCents: number; note: string }; first?: Json } = { id: "", student: "" };

  it("recebimentos de A entram; os de B não; consumo no balcão com a carteira não é dinheiro recebido", async () => {
    ctx.student = await newStudent();
    const o = await open(secA, { openingCents: 10_000 });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    ctx.id = o.body.sessionId as string;
    await topup(secA, ctx.student, { method: "cash", amountCents: 5000 });
    await topup(secA, ctx.student, { method: "pix", amountCents: 3000 });
    await topup(secA, ctx.student, { method: "card_credit", amountCents: 2000 });
    await topup(secB, ctx.student, { method: "cash", amountCents: 4000 }); // outro operador: NÃO é do caixa de A
    // compra no balcão com o SALDO da carteira (R$ 10,00 de 14.000 recebidos): consumo, não dinheiro novo
    const product = await newProduct(500);
    const sale = await call("POST pos sales", cantinaA, "POST", "/api/pos/sales", { key: randomUUID(), studentId: ctx.student, expectedShiftId: ST, lines: [{ productId: product, quantity: 2, expectedPriceCents: 500 }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);

    const view = await getSession(secA, ctx.id);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: "open", openingCents: 10_000, closure: null, afterClose: null });
    const by = Object.fromEntries((view.body.live.byMethod as { method: string; receiptCount: number; netCents: number }[]).map((m) => [m.method, m]));
    expect(by.cash).toMatchObject({ receiptCount: 1, grossCents: 5000, netCents: 5000 });
    expect(by.pix).toMatchObject({ receiptCount: 1, netCents: 3000 });
    expect(by.card_credit).toMatchObject({ receiptCount: 1, netCents: 2000 });
    expect(view.body.live).toMatchObject({ receiptCount: 3, expectedCashCents: 15_000, walletConsumption: { orderCount: 0, totalCents: 0 } }); // secretaria não tem consumo de balcão
  });

  it("fecha conferindo: contagem pelo total = esperado → sem divergência, sem revisão pendente; versão 1 imutável gravada", async () => {
    ctx.closeBody = { key: randomUUID(), sessionId: ctx.id, countedCashCents: 15_000, note: "Gaveta conferida" };
    const r = await call("POST close", secA, "POST", "/api/cash/close", ctx.closeBody);
    ctx.first = r.body;
    expect(r, JSON.stringify(r.body)).toMatchObject({ status: 200, body: { closureNo: 1, status: "closed", expectedCashCents: 15_000, countedCashCents: 15_000, cashDifferenceCents: 0, hasDivergence: false, reviewStatus: "not_required", receiptCount: 3, replayed: false } });
    const session = (await doc(`cashSessions/${ctx.id}`))!;
    expect(session).toMatchObject({ status: "closed", closureNo: 1, review: { status: "not_required", closureNo: 1 }, opening: { cents: 10_000 } });
    expect(session.closure).toMatchObject({ no: 1, expectedCashCents: 15_000, countedCashCents: 15_000, note: "Gaveta conferida", closedBy: { uid: secA.uid } });
    const v1 = (await doc(`cashSessions/${ctx.id}/closures/1`))!;
    expect(v1.lines).toHaveLength(3);
    expect(v1.byMethod.find((m: { method: string }) => m.method === "cash")).toMatchObject({ grossCents: 5000, netCents: 5000 });
    const events = (await db().collection(`cashSessions/${ctx.id}/events`).get()).docs.map((d) => d.get("type")).sort();
    expect(events).toEqual(["closed", "opened"]);
    const audit = (await db().collection("auditLog").where("target.id", "==", ctx.id).get()).docs.map((d) => d.get("action")).sort();
    expect(audit).toEqual(["cash.close", "cash.open"]);
  });

  it("repetir a mesma chave devolve o mesmo fechamento; fechar de novo com outra chave = 409; nada novo é gravado", async () => {
    const again = await call("POST close", secA, "POST", "/api/cash/close", ctx.closeBody);
    expect(again.body).toEqual({ ...ctx.first, replayed: true });
    expect((await call("POST close", secA, "POST", "/api/cash/close", { ...ctx.closeBody, countedCashCents: 1 })).body.error).toBe("idempotency_conflict");
    expect((await close(secA, ctx.id, { countedCashCents: 15_000 })).body.error).toBe("already_closed");
    expect((await db().collection(`cashSessions/${ctx.id}/closures`).get()).size).toBe(1);
  });

  it("depois do fechamento o operador vê o fechamento e nenhum movimento posterior", async () => {
    const view = await getSession(secA, ctx.id);
    expect(view.body).toMatchObject({ status: "closed", closureNo: 1, afterClose: { count: 0 }, live: null });
    expect(view.body.history).toHaveLength(1);
  });

  it("caixa da secretaria e caixa do balcão são separados: o mesmo operador (administração) tem dois caixas independentes no dia", async () => {
    const sec = (await getSession(admin, sid(TODAY, "secretaria", admin))).body;
    const cnt = (await getSession(admin, sid(TODAY, "counter", admin))).body;
    expect(sec.point).toBe("secretaria");
    expect(cnt.point).toBe("counter");
    expect(sec.sessionId).not.toBe(cnt.sessionId);
    expect(sec.live.receiptCount).toBe(0);
  });
});

/* ------------------------------------------------------------------------ divergência e revisão */

describe("divergência: tolerância ZERO, revisão administrativa SEM ajuste automático", () => {
  async function dayWith(user: TestUser, opts: { counted: number; declared?: Record<string, number> }) {
    const student = await newStudent();
    const o = await open(user, { openingCents: 2000 });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    await topup(user, student, { method: "cash", amountCents: 3000 });
    await topup(user, student, { method: "pix", amountCents: 1000 });
    const r = await close(user, o.body.sessionId as string, { countedCashCents: opts.counted, declared: opts.declared });
    return { id: o.body.sessionId as string, r, student };
  }

  it("1 centavo a menos ou a mais já é divergência pendente de revisão; igual não é", async () => {
    const less = await dayWith(await createTestUser("cdv1", "secretaria", { displayName: "Secretaria Div 1" }), { counted: 4999 });
    expect(less.r.body).toMatchObject({ hasDivergence: true, cashDifferenceCents: -1, reviewStatus: "pending" });
    const more = await dayWith(await createTestUser("cdv2", "secretaria", { displayName: "Secretaria Div 2" }), { counted: 5001 });
    expect(more.r.body).toMatchObject({ hasDivergence: true, cashDifferenceCents: 1, reviewStatus: "pending" });
    const exact = await dayWith(await createTestUser("cdv3", "secretaria", { displayName: "Secretaria Div 3" }), { counted: 5000 });
    expect(exact.r.body).toMatchObject({ hasDivergence: false, reviewStatus: "not_required" });
  });

  it("conferência declarada de Pix/cartão diferente do registrado também é divergência; igual não é", async () => {
    const same = await dayWith(await createTestUser("cdv4", "secretaria", { displayName: "Secretaria Div 4" }), { counted: 5000, declared: { pixCents: 1000 } });
    expect(same.r.body.hasDivergence).toBe(false);
    const diff = await dayWith(await createTestUser("cdv5", "secretaria", { displayName: "Secretaria Div 5" }), { counted: 5000, declared: { pixCents: 900 } });
    expect(diff.r.body.hasDivergence).toBe(true);
    expect((await doc(`cashSessions/${diff.id}`))!.closure.declared.pix).toEqual({ declaredCents: 900, expectedCents: 1000, differenceCents: -100 });
  });

  it("aprovar a diferença é decisão administrativa com nota e NÃO cria ajuste: nenhum recebimento, venda, pedido, carteira ou lançamento muda", async () => {
    const op = await createTestUser("cdv6", "secretaria", { displayName: "Secretaria Div 6" });
    const { id, student } = await dayWith(op, { counted: 4900 });
    const walletBefore = await doc(`wallets/${student}`);
    const factsBefore = await financialFacts();

    const approved = await review(admin, id, { decision: "approved", note: "Troco conferido; diferença aceita sem ajuste" });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { sessionId: id, closureNo: 1, decision: "approved", adjustment: "none" } });
    expect((await doc(`cashSessions/${id}`))!.review).toMatchObject({ status: "approved", closureNo: 1, note: "Troco conferido; diferença aceita sem ajuste", byName: "Admin Caixa", selfReview: false });

    expect(await doc(`wallets/${student}`)).toEqual(walletBefore);
    expect(await financialFacts()).toEqual(factsBefore);
    const audit = (await db().collection("auditLog").where("target.id", "==", id).where("action", "==", "cash.review").get()).docs;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.get("after")).toMatchObject({ adjustment: "none", cashDifferenceCents: -100, reviewStatus: "approved" });
  });

  it("revisão: manter em apuração e depois aprovar; nota obrigatória; fechamento sem divergência não tem o que revisar; versão antiga = 409", async () => {
    const op = await createTestUser("cdv7", "secretaria", { displayName: "Secretaria Div 7" });
    const { id } = await dayWith(op, { counted: 5100 });
    expect((await review(admin, id, { note: "curta" })).status).toBe(400);
    expect((await review(admin, id, { decision: "adjust" })).status).toBe(400);
    expect((await review(admin, id, { closureNo: 2 })).body.error).toBe("stale_closure");
    expect((await review(admin, id, { decision: "followup", note: "Apurar com a tesouraria" })).body).toMatchObject({ decision: "followup" });
    expect((await doc(`cashSessions/${id}`))!.review.status).toBe("followup");
    expect((await review(admin, id)).body).toMatchObject({ decision: "approved" });
    const clean = await dayWith(await createTestUser("cdv8", "secretaria", { displayName: "Secretaria Div 8" }), { counted: 5000 });
    expect((await review(admin, clean.id)).body.error).toBe("no_divergence");
    expect((await review(admin, "2026-01-01__secretaria__naoexiste")).status).toBe(404);
  });

  it("a administração que revisa o PRÓPRIO caixa fica marcada (`selfReview`) na revisão e na auditoria", async () => {
    const o = await open(admin, { point: "secretaria", date: daysAgo(2), openingCents: 100 });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    const c = await close(admin, o.body.sessionId as string, { countedCashCents: 0 });
    expect(c.body.hasDivergence).toBe(true);
    expect((await review(admin, o.body.sessionId as string)).status).toBe(200);
    expect((await doc(`cashSessions/${o.body.sessionId}`))!.review.selfReview).toBe(true);
  });
});

/* ------------------------------------------------------------------------------ concorrência */

describe("fechamento concorrente", () => {
  it("quatro fechamentos simultâneos do mesmo caixa (chaves diferentes): um vence, os demais 409; uma só versão", async () => {
    const op = await createTestUser("cconc2", "secretaria", { displayName: "Secretaria Fecha" });
    const student = await newStudent();
    const o = await open(op, { openingCents: 0 });
    await topup(op, student, { method: "cash", amountCents: 2500 });
    const id = o.body.sessionId as string;
    const results = await Promise.all([1, 2, 3, 4].map(() => close(op, id, { countedCashCents: 2500 })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error === "already_closed")).toBe(true);
    expect((await db().collection(`cashSessions/${id}/closures`).get()).size).toBe(1);
    expect((await doc(`cashSessions/${id}`))!.closureNo).toBe(1);
  });

  it("um recebimento lançado ENQUANTO se fecha cai dentro do fechamento ou é identificado como posterior — nunca some", async () => {
    const op = await createTestUser("cconc3", "secretaria", { displayName: "Secretaria Corrida" });
    const student = await newStudent();
    const o = await open(op, { openingCents: 0 });
    const id = o.body.sessionId as string;
    await topup(op, student, { method: "cash", amountCents: 1000 });
    const [c, t] = await Promise.all([close(op, id, { countedCashCents: 1000 }), topup(op, student, { method: "cash", amountCents: 700 })]);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const closure = (await doc(`cashSessions/${id}/closures/1`))!;
    const view = (await getSession(op, id)).body;
    const inside = (closure.lines as { ref: string }[]).some((l) => l.ref === `topup:${t.topupId}`);
    const flagged = (view.afterClose.newReceipts as { ref: string }[]).some((l) => l.ref === `topup:${t.topupId}`);
    expect(inside !== flagged).toBe(true); // exatamente um dos dois
  });

  it("`expectedReceiptCount` evita fechar com um resumo velho: lançou algo depois de ver a tela = 409 com a contagem atual", async () => {
    const op = await createTestUser("cstale", "secretaria", { displayName: "Secretaria Resumo" });
    const student = await newStudent();
    const o = await open(op, { openingCents: 0 });
    const id = o.body.sessionId as string;
    await topup(op, student, { method: "cash", amountCents: 1000 });
    const stale = await close(op, id, { countedCashCents: 1000, expectedReceiptCount: 0 });
    expect(stale).toMatchObject({ status: 409, body: { error: "stale_summary", details: { receiptCount: 1 } } });
    expect((await close(op, id, { countedCashCents: 1000, expectedReceiptCount: 1 })).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- reabertura e posteriores */

describe("movimentos posteriores identificados; reabertura só da administração, com motivo, preservando as versões", () => {
  const ctx: { op?: TestUser; id: string; student: string; firstTopup?: string } = { id: "", student: "" };

  it("depois do fechamento: recebimento novo e estorno aparecem como POSTERIORES; o fechamento gravado não muda um byte", async () => {
    ctx.op = await createTestUser("cpost", "secretaria", { displayName: "Secretaria Posterior" });
    ctx.student = await newStudent();
    const o = await open(ctx.op, { openingCents: 1000 });
    ctx.id = o.body.sessionId as string;
    const first = await topup(ctx.op, ctx.student, { method: "cash", amountCents: 4000 });
    ctx.firstTopup = first.topupId;
    const closed = await close(ctx.op, ctx.id, { countedCashCents: 5000 });
    expect(closed.body).toMatchObject({ hasDivergence: false, closureNo: 1 });
    const snapshot = await doc(`cashSessions/${ctx.id}`);
    const v1 = await doc(`cashSessions/${ctx.id}/closures/1`);

    const later = await topup(ctx.op, ctx.student, { method: "cash", amountCents: 600 }); // depois do fechamento
    await topupCommands.reverseManualTopup(db(), asActor(admin, "admin"), { key: randomUUID(), topupId: first.topupId, amountCents: 1000, reasonCode: "payment_returned", reason: "Valor devolvido ao pagador", expectedReversedCents: 0 });

    const view = (await getSession(ctx.op, ctx.id)).body;
    expect(view.afterClose).toMatchObject({ count: 2, newReceipts: [{ ref: `topup:${later.topupId}`, method: "cash", grossCents: 600 }], newReversals: [{ ref: `topup:${first.topupId}`, method: "cash", addedCents: 1000 }] });
    expect(view.closure).toMatchObject({ expectedCashCents: 5000, countedCashCents: 5000, no: 1 }); // o fechamento continua o que era
    expect(await doc(`cashSessions/${ctx.id}`)).toEqual(snapshot);
    expect(await doc(`cashSessions/${ctx.id}/closures/1`)).toEqual(v1);

    const alerts = (await adminList()).body.alerts as { kind: string; operatorUid: string }[];
    expect(alerts.some((a) => a.kind === "movements_after_close" && a.operatorUid === ctx.op!.uid)).toBe(true);
    expect(((await call("GET cash", ctx.op, "GET", "/api/cash")).body.alerts as { kind: string }[]).some((a) => a.kind === "movements_after_close")).toBe(true);
  });

  it("reabrir: motivo obrigatório, só caixa FECHADO, só administração; operador não reabre o próprio", async () => {
    expect((await reopen(admin, ctx.id, { reason: "curto" })).status).toBe(400);
    expect((await reopen(ctx.op!, ctx.id)).status).toBe(403);
    expect((await reopen(admin, sid(TODAY, "secretaria", secB))).body.error).toBe("not_closed"); // aberto
    const v1Before = await doc(`cashSessions/${ctx.id}/closures/1`);
    const r = await reopen(admin, ctx.id, { reason: "Faltou conferir o recebimento e o estorno posteriores" });
    expect(r, JSON.stringify(r.body)).toMatchObject({ status: 200, body: { status: "reopened", reopenCount: 1, closureNo: 1 } });
    expect((await doc(`cashSessions/${ctx.id}`))!.status).toBe("reopened");
    expect(await doc(`cashSessions/${ctx.id}/closures/1`)).toEqual(v1Before); // a versão 1 continua intacta
    expect((await reopen(admin, ctx.id)).body.error).toBe("not_closed"); // já reaberto
    const events = (await db().collection(`cashSessions/${ctx.id}/events`).get()).docs.map((d) => d.data()).find((e) => e.type === "reopened")!;
    expect(events).toMatchObject({ reason: "Faltou conferir o recebimento e o estorno posteriores", byUid: admin.uid, closureNo: 1 });
    const audit = (await db().collection("auditLog").where("target.id", "==", ctx.id).where("action", "==", "cash.reopen").get()).docs;
    expect(audit[0]!.get("reason")).toBe("Faltou conferir o recebimento e o estorno posteriores");
  });

  it("reaberto: não se revisa; o operador fecha de novo (versão 2, com os posteriores) e a versão 1 permanece", async () => {
    expect((await review(admin, ctx.id)).body.error).toBe("not_closed");
    const alerts = (await adminList()).body.alerts as { kind: string; operatorUid: string }[];
    expect(alerts.some((a) => a.kind === "movements_after_close" && a.operatorUid === ctx.op!.uid)).toBe(false); // reaberto não está "fechado com posteriores"
    // esperado agora: 1000 + (4000 − 1000 estornado) + 600 = 4600
    const c = await close(ctx.op!, ctx.id, { countedCashCents: 4500 });
    expect(c.body).toMatchObject({ closureNo: 2, expectedCashCents: 4600, cashDifferenceCents: -100, hasDivergence: true, reviewStatus: "pending", receiptCount: 2 });
    const closures = (await db().collection(`cashSessions/${ctx.id}/closures`).orderBy("no").get()).docs.map((d) => d.data());
    expect(closures.map((d) => [d.no, d.expectedCashCents])).toEqual([[1, 5000], [2, 4600]]);
    const view = (await getSession(ctx.op!, ctx.id)).body;
    expect(view).toMatchObject({ status: "closed", closureNo: 2, reopenCount: 1, afterClose: { count: 0 } });
    expect(view.history.map((h: { no: number }) => h.no)).toEqual([1, 2]);
    expect(view.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["opened", "closed", "reopened"]));
    // a revisão agora é do fechamento 2; a nota do 1 não vale para ele
    expect((await review(admin, ctx.id, { closureNo: 1 })).body.error).toBe("stale_closure");
    expect((await review(admin, ctx.id, { closureNo: 2 })).status).toBe(200);
  });
});

/* --------------------------------------------------------------------------------------- alertas */

describe("dia sem fechamento gera alerta e NÃO bloqueia o dia seguinte", () => {
  it("caixa de ontem aberto e sem fechar: alerta para a administração e para o próprio operador; abrir/receber hoje segue livre", async () => {
    const op = await createTestUser("calert1", "secretaria", { displayName: "Secretaria Alerta" });
    const student = await newStudent();
    const old = await open(op, { date: daysAgo(1), openingCents: 500 });
    expect(old.status).toBe(200);
    const today = await open(op, { openingCents: 800 }); // não é bloqueado pelo dia anterior
    expect(today.status).toBe(200);
    expect((await topup(op, student, { method: "cash", amountCents: 1000 })).creditedCents).toBe(1000); // recebimento de hoje segue livre

    const list = (await adminList()).body;
    expect(list.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "open_not_closed", date: daysAgo(1), point: "secretaria", operatorUid: op.uid, sessionId: old.body.sessionId })]));
    const mine = (await call("GET cash", op, "GET", "/api/cash")).body;
    expect(mine.alerts.filter((a: { kind: string }) => a.kind === "open_not_closed")).toHaveLength(1);
    expect((mine.alerts as { operatorUid: string }[]).every((a) => a.operatorUid === op.uid)).toBe(true); // só os próprios
    // hoje ainda aberto não é alerta
    expect(list.alerts.some((a: { date: string; operatorUid: string }) => a.date === TODAY && a.operatorUid === op.uid)).toBe(false);

    // fechar o dia esquecido resolve o alerta
    expect((await close(op, old.body.sessionId as string, { countedCashCents: 500 })).status).toBe(200);
    expect(((await adminList()).body.alerts as { kind: string; sessionId: string }[]).some((a) => a.kind === "open_not_closed" && a.sessionId === old.body.sessionId)).toBe(false);
  });

  it("dia com recebimentos e SEM caixa nenhum: alerta de recebimentos sem caixa; abrir retroativamente e fechar resolve", async () => {
    const op = await createTestUser("calert2", "secretaria", { displayName: "Secretaria Esqueceu" });
    const student = await newStudent();
    const d = daysAgo(3);
    await topup(op, student, { method: "cash", amountCents: 2000 }, at(d));
    await topup(op, student, { method: "pix", amountCents: 1000 }, at(d));
    const alerts = (await adminList()).body.alerts as { kind: string; date: string; operatorUid: string; detail: string; operatorName: string }[];
    expect(alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "receipts_without_session", date: d, operatorUid: op.uid, detail: "2", operatorName: "Secretaria Esqueceu" })]));
    expect((await open(op)).status).toBe(200); // hoje abre normalmente

    const o = await open(op, { date: d, openingCents: 0 });
    expect(o.status).toBe(200);
    // os recebimentos de 3 dias atrás pertencem ao caixa daquele dia, não ao de hoje
    expect((await getSession(op, o.body.sessionId as string)).body.live).toMatchObject({ receiptCount: 2, expectedCashCents: 2000 });
    expect((await getSession(op, sid(TODAY, "secretaria", op))).body.live.receiptCount).toBe(0);
    expect((await close(op, o.body.sessionId as string, { countedCashCents: 2000 })).body.hasDivergence).toBe(false);
    expect(((await adminList()).body.alerts as { kind: string; operatorUid: string; date: string }[]).some((a) => a.kind === "receipts_without_session" && a.operatorUid === op.uid && a.date === d)).toBe(false);
  });

  it("divergência pendente também gera alerta (até a revisão); o resumo da administração lista cada caixa", async () => {
    const op = await createTestUser("calert3", "secretaria", { displayName: "Secretaria Div Alerta" });
    const o = await open(op, { openingCents: 1000 });
    const c = await close(op, o.body.sessionId as string, { countedCashCents: 900 });
    expect(c.body.hasDivergence).toBe(true);
    let list = (await adminList()).body;
    expect(list.alerts.some((a: { kind: string; operatorUid: string }) => a.kind === "divergence_pending" && a.operatorUid === op.uid)).toBe(true);
    const row = list.sessions.find((s: { sessionId: string }) => s.sessionId === o.body.sessionId);
    expect(row).toMatchObject({ status: "closed", openingCents: 1000, expectedCashCents: 1000, countedCashCents: 900, cashDifferenceCents: -100, hasDivergence: true, reviewStatus: "pending", operatorName: "Secretaria Div Alerta" });
    await review(admin, o.body.sessionId as string);
    list = (await adminList()).body;
    expect(list.alerts.some((a: { kind: string; operatorUid: string }) => a.kind === "divergence_pending" && a.operatorUid === op.uid)).toBe(false);
  });

  it("período da listagem: invertido e longo demais são recusados", async () => {
    expect((await adminList(TODAY, daysAgo(1))).body.error).toBe("invalid_range");
    expect((await adminList(daysAgo(200), TODAY)).body.error).toBe("range_too_long");
  });
});

/* ----------------------------------------------------------------------------------- balcão */

describe("caixa do balcão: vendas diretas (dinheiro, Pix, cartão) entram; a compra com saldo da carteira NÃO", () => {
  it("esperado = saldo inicial + dinheiro das vendas diretas; consumo com saldo aparece à parte e não vira dinheiro", async () => {
    const op = await createTestUser("ccnt", "cantina", { displayName: "Cantina Balcão" });
    const product = await newProduct(500);
    const o = await call("POST open", op, "POST", "/api/cash/open", { key: randomUUID(), point: "counter", openingCents: 3000, openingConfirmed: true });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    const id = o.body.sessionId as string;
    const opActor = asActor(op, "cantina");
    const pay = (method: string, qty: number) => posCommands.recordDirectSale(db(), opActor, { key: randomUUID(), shiftId: ST, lines: [{ productId: product, quantity: qty, expectedPriceCents: 500 }], paymentMethod: method, receivedConfirmed: true });
    await pay("cash", 2); // R$ 10,00
    await pay("pix", 1); // R$ 5,00
    await pay("card_debit", 3); // R$ 15,00
    // compra com SALDO da carteira feita por este operador (R$ 15,00): consumo, não recebimento
    const student = await newStudent();
    await topup(secA, student, { method: "cash", amountCents: 5000 });
    const sale = await call("POST pos sales", op, "POST", "/api/pos/sales", { key: randomUUID(), studentId: student, expectedShiftId: ST, lines: [{ productId: product, quantity: 3, expectedPriceCents: 500 }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);

    const live = (await getSession(op, id)).body.live;
    expect(live).toMatchObject({ receiptCount: 3, expectedCashCents: 3000 + 1000, walletConsumption: { orderCount: 1, totalCents: 1500 } });
    const closed = await close(op, id, { countedCashCents: 4000, declared: { pixCents: 500, cardDebitCents: 1500 } });
    expect(closed.body).toMatchObject({ hasDivergence: false, expectedCashCents: 4000, receiptCount: 3 });
    const closure = (await doc(`cashSessions/${id}`))!.closure;
    expect(closure.walletConsumption).toEqual({ orderCount: 1, totalCents: 1500 });
    const by = Object.fromEntries((closure.byMethod as { method: string; grossCents: number }[]).map((m) => [m.method, m.grossCents]));
    expect(by).toMatchObject({ cash: 1000, pix: 500, card_debit: 1500, card_credit: 0 });
    // a compra com saldo não somou em nenhum meio recebido
    expect(Object.values(by).reduce((n, v) => n + v, 0)).toBe(3000);
  });

  it("a secretaria não fecha o balcão nem a cantina a secretaria (ponto do papel); sem recebimento algum o esperado é o saldo inicial", async () => {
    const op = await createTestUser("ccnt2", "cantina", { displayName: "Cantina Vazia" });
    const o = await call("POST open", op, "POST", "/api/cash/open", { key: randomUUID(), point: "counter", openingCents: 700, openingConfirmed: true });
    const id = o.body.sessionId as string;
    expect((await close(secA, id)).status).toBe(403);
    expect((await close(op, id, { countedCashCents: 700 })).body).toMatchObject({ expectedCashCents: 700, hasDivergence: false, receiptCount: 0 });
  });
});

/* ------------------------------------------------------------------------------- falha intermediária */

describe("falha no meio da transação não deixa rastro; o retry com a MESMA chave conclui uma vez", () => {
  it("abertura, fechamento, reabertura e revisão: auditoria bloqueada = 500 e nada gravado; liberada, a mesma chave conclui", async () => {
    const op = await createTestUser("cfail", "secretaria", { displayName: "Secretaria Falha" });
    const student = await newStudent();
    const block = async (uid: string, scope: string, key: string) => db().doc(`auditLog/${uid}__${scope}__${key}`).set({ action: "bloqueio-de-teste" });
    const unblock = async (uid: string, scope: string, key: string) => db().doc(`auditLog/${uid}__${scope}__${key}`).delete();

    // abertura
    const openBody = { key: randomUUID(), point: "secretaria", openingCents: 1500, openingConfirmed: true };
    await block(op.uid, "cash.open", openBody.key);
    expect((await call("POST open", op, "POST", "/api/cash/open", openBody)).status).toBe(500);
    expect(await doc(`cashSessions/${sid(TODAY, "secretaria", op)}`)).toBeUndefined();
    expect((await db().doc(`idempotencyRecords/${op.uid}__cash.open__${openBody.key}`).get()).exists).toBe(false); // sem registro de idempotência: a repetição executa de verdade
    await unblock(op.uid, "cash.open", openBody.key);
    expect((await call("POST open", op, "POST", "/api/cash/open", openBody)).status).toBe(200);
    const id = sid(TODAY, "secretaria", op);

    // fechamento
    await topup(op, student, { method: "cash", amountCents: 500 });
    const closeBody = { key: randomUUID(), sessionId: id, countedCashCents: 2000 };
    await block(op.uid, "cash.close", closeBody.key);
    expect((await call("POST close", op, "POST", "/api/cash/close", closeBody)).status).toBe(500);
    expect(await doc(`cashSessions/${id}`)).toMatchObject({ status: "open", closureNo: 0, closure: null });
    expect((await db().collection(`cashSessions/${id}/closures`).get()).size).toBe(0);
    await unblock(op.uid, "cash.close", closeBody.key);
    expect((await call("POST close", op, "POST", "/api/cash/close", closeBody)).body).toMatchObject({ status: "closed", closureNo: 1, hasDivergence: false, replayed: false });
    expect((await db().collection(`cashSessions/${id}/closures`).get()).size).toBe(1);

    // reabertura
    const reopenBody = { key: randomUUID(), sessionId: id, reason: "Reabrir para conferir novamente a gaveta" };
    await block(admin.uid, "cash.reopen", reopenBody.key);
    expect((await call("POST reopen", admin, "POST", "/api/admin/finance/cash/reopen", reopenBody)).status).toBe(500);
    expect((await doc(`cashSessions/${id}`))!.status).toBe("closed");
    await unblock(admin.uid, "cash.reopen", reopenBody.key);
    expect((await call("POST reopen", admin, "POST", "/api/admin/finance/cash/reopen", reopenBody)).status).toBe(200);

    // revisão (fecha com divergência e revisa com falha)
    const second = await close(op, id, { countedCashCents: 1900 });
    expect(second.body).toMatchObject({ closureNo: 2, hasDivergence: true });
    const reviewBody = { key: randomUUID(), sessionId: id, closureNo: 2, decision: "approved", note: "Conferido com a operadora" };
    await block(admin.uid, "cash.review", reviewBody.key);
    expect((await call("POST review", admin, "POST", "/api/admin/finance/cash/review", reviewBody)).status).toBe(500);
    expect((await doc(`cashSessions/${id}`))!.review.status).toBe("pending");
    await unblock(admin.uid, "cash.review", reviewBody.key);
    expect((await call("POST review", admin, "POST", "/api/admin/finance/cash/review", reviewBody)).status).toBe(200);
    expect((await doc(`cashSessions/${id}`))!.review.status).toBe("approved");
  });
});
