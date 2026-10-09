// Relatórios de vendas, CMV, margens, perdas, compras, pedidos a realizar e cancelamentos (F21) contra Auth/Firestore Emulator.
// Prova com valores calculados à mão: A20 (100×R$1,00 + 100×R$1,10 → venda de 10 a R$2,00 = receita R$20,00, CMV R$10,50, lucro R$9,50),
// A21 (preço/custo atuais não reescrevem a baixa histórica; custo médio com compra entre saídas), canais separados (pedido antecipado,
// balcão com saldo, venda direta), perdas e compras FORA do CMV, não retirado com cobrança retida em linha própria, cancelamento/
// reembolso, pedidos futuros pagos à parte, pendência (custo ausente / documento ilegível) em vez de zero, limites de período no fuso
// America/Sao_Paulo, autorização por papel (secretaria e cantina sem custo/lucro), exportação CSV/XLSX segura e RECUSADA se truncada, e
// replay (mesma chave) sem contar de novo. Saldo vem de fixture do emulador; nada aqui prova o Firestore real.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
type Result = { status: number; body: Json };
type Totals = { units: number; revenueCents: number; cogsCents: number; costMicros: number; grossProfitCents: number; marginBp: number | null; complete: boolean; missingCostUnits: number; missingRevenueUnits: number };
type Realized = { totals: Totals; origins: number; byChannel: { key: string; units: number; revenueCents: number }[]; byDay: { key: string; units: number }[]; byProduct: { productId: string; units: number; revenueCents: number; cogsCents: number; grossProfitCents: number }[] };

let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let school: typeof import("@/lib/dates/school-time");
let placeAdvanceOrders: typeof import("@/modules/orders/commands").placeAdvanceOrders;
let cancelOrder: typeof import("@/modules/orders/cancellation").cancelOrder;
let commandErrorResponse: typeof import("@/modules/access/command-route").commandErrorResponse;
let reportsMod: typeof import("@/modules/reports/sales-report");
const routes: Record<string, Handler> = {};

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardian: TestUser;
let studentUser: TestUser;

const tag = randomUUID().slice(0, 6);
const ST = `rst_${tag}_t`; // turno da tarde (alunos do pedido antecipado e da venda direta)
const SM = `rst_${tag}_m`; // turno da manhã (aluno do balcão)
const CLS = `rcl_${tag}`;
const CAT = `rct_${tag}`;
const CAT2 = `rct2_${tag}`;
const CAT3 = `rct3_${tag}`;
let BASE = "";
let NOW = new Date();
let seq = 0;
const d = (n: number) => school.addDays(BASE, n);
const noCtx = { params: Promise.resolve({ id: "" }) };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const prices = new Map<string, number>();
const names = new Map<string, string>();

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  ({ adminDb } = await import("@/lib/firebase/admin"));
  school = await import("@/lib/dates/school-time");
  ({ placeAdvanceOrders } = await import("@/modules/orders/commands"));
  ({ cancelOrder } = await import("@/modules/orders/cancellation"));
  ({ commandErrorResponse } = await import("@/modules/access/command-route"));
  reportsMod = await import("@/modules/reports/sales-report");
  routes["GET sales"] = (await import("@/app/api/reports/sales/route")).GET as unknown as Handler;
  routes["GET finance report"] = (await import("@/app/api/admin/finance/report/route")).GET as unknown as Handler;
  routes["GET export"] = (await import("@/app/api/reports/sales/export/route")).GET as unknown as Handler;
  routes["POST receipts"] = (await import("@/app/api/inventory/receipts/route")).POST as unknown as Handler;
  routes["POST losses"] = (await import("@/app/api/inventory/losses/route")).POST as unknown as Handler;
  routes["POST adjustments"] = (await import("@/app/api/inventory/adjustments/route")).POST as unknown as Handler;
  routes["POST deliver"] = (await import("@/app/api/operations/orders/[id]/deliver/route")).POST as unknown as Handler;
  routes["POST not-picked-up"] = (await import("@/app/api/operations/orders/[id]/not-picked-up/route")).POST as unknown as Handler;
  routes["POST resolve"] = (await import("@/app/api/operations/orders/[id]/resolve/route")).POST as unknown as Handler;
  routes["POST pos sales"] = (await import("@/app/api/pos/sales/route")).POST as unknown as Handler;
  routes["POST pos direct"] = (await import("@/app/api/pos/direct-sales/route")).POST as unknown as Handler;
  BASE = school.localDateOf(new Date());
  NOW = school.localInstant(BASE, "09:00");
  [admin, cantina, secretaria, guardian, studentUser] = await Promise.all([
    createTestUser("radm", "admin", { displayName: "Admin Relatórios" }),
    createTestUser("rcan", "cantina", { displayName: "Cantina Relatórios" }),
    createTestUser("rsec", "secretaria", { displayName: "Secretaria Relatórios" }),
    createTestUser("rresp", "guardian"),
    createTestUser("ralu", "student"),
  ]);
  await globalDoc(`shifts/${ST}`, { name: `Tarde ${tag}`, nameSlug: "tarde", status: "active" });
  await globalDoc(`shifts/${SM}`, { name: `Manhã ${tag}`, nameSlug: "manha", status: "active" });
  await globalDoc(`classes/${CLS}`, { name: `Turma ${tag}`, nameSlug: "turma", status: "active" });
  await globalDoc(`categories/${CAT}`, { name: `Salgados ${tag}`, status: "active" });
  await globalDoc(`categories/${CAT2}`, { name: `Doces ${tag}`, status: "active" });
  await globalDoc(`categories/${CAT3}`, { name: `Bebidas ${tag}`, status: "active" });
  for (let i = -1; i <= 4; i++) await globalDoc(`calendarDays/${d(i)}`, { kind: "extra" });
});

const globalDocs: string[] = [];
const globalDoc = async (path: string, data: Record<string, string | number | boolean | null | string[]>) => {
  globalDocs.push(path);
  await writeDemoDoc(targetFromEnv(), path, data);
};
const synthetic: string[] = [];
afterAll(async () => {
  for (const path of [...globalDocs.splice(0), ...synthetic.splice(0)]) await adminDb().doc(path).delete();
});

/* ------------------------------------------------------------------------------------------------- apoio */

const db = () => adminDb();
const doc = async (path: string) => (await db().doc(path).get()).data();
const actorOf = (user: TestUser, role: "guardian" | "cantina" | "admin" = "guardian") => ({ uid: user.uid, role, permissions: [] as never[] });

function authed(method: string, url: string, user: TestUser | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.idToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(key: string, user: TestUser | null, method: string, url: string, body?: unknown, id = ""): Promise<Result> {
  const response = await routes[key]!(authed(method, url, user, body), id ? ctx(id) : noCtx);
  const text = await response.text();
  return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : { text }) as Json };
}
async function viaCommand(run: () => Promise<unknown>): Promise<Result> {
  try {
    return { status: 200, body: (await run()) as Json };
  } catch (error) {
    const response = commandErrorResponse(error, "teste");
    return { status: response.status, body: (await response.json()) as Json };
  }
}

const qs = (params: Record<string, string | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&");
const report = (user: TestUser | null, params: Record<string, string | undefined> = {}) => call("GET sales", user, "GET", `/api/reports/sales?${qs({ from: BASE, to: BASE, ...params })}`);
const realizedOf = (r: Result): Realized => r.body.realized as unknown as Realized;
async function exportRaw(user: TestUser | null, params: Record<string, string | undefined>): Promise<Response> {
  return routes["GET export"]!(authed("GET", `/api/reports/sales/export?${qs({ from: BASE, to: BASE, ...params })}`, user), noCtx);
}
const csvRows = (text: string): string[][] => text.replace(/^﻿/, "").trim().split("\r\n").map((l) => l.split(";"));

async function newStudent(over: { shift?: string; counter?: boolean; cents?: number } = {}) {
  const id = `rsu_${tag}_${++seq}`;
  const name = `Aluno Relatório ${seq}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowSitePurchase: true, allowCounterPurchase: over.counter ?? true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, enrollment: `R${tag}${seq}`, status: "active", userUid: null, shiftId: over.shift ?? ST, classId: CLS, version: 3 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: true, allowCounterPurchase: over.counter ?? true, configVersion: 1 });
  await fundDemoWallet(targetFromEnv(), id, over.cents ?? 50000);
  names.set(id, name);
  return id;
}

async function newProduct(over: { price?: number; cat?: string; name?: string; stock?: number; unitCost?: string } = {}) {
  const id = `rpr_${tag}_${++seq}`;
  const price = over.price ?? 500;
  const name = over.name ?? `Produto Relatório ${seq}`;
  await globalDoc(`products/${id}`, { name, description: "", categoryId: over.cat ?? CAT, priceCents: price, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [SM, ST], availabilityMode: "physical", status: "active", version: 1 });
  await globalDoc(`defaultMenuRules/${id}`, { shiftIds: [SM, ST], version: 1 });
  prices.set(id, price);
  names.set(id, name);
  if (over.stock !== 0) await receive(id, over.stock ?? 500, over.unitCost ?? "1,00");
  return id;
}
async function receive(productId: string, quantity: number, unitCost: string) {
  const r = await call("POST receipts", admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId, kind: "purchase", quantity, unitCost });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}

const line = (productId: string, quantity = 1) => ({ productId, quantity, expectedPriceCents: prices.get(productId)! });
const directBody = (lines: { productId: string; quantity?: number }[], over: Record<string, unknown> = {}) => ({ key: randomUUID(), shiftId: ST, lines: lines.map((l) => line(l.productId, l.quantity)), paymentMethod: "cash", receivedConfirmed: true, ...over });
const sellDirect = (lines: { productId: string; quantity?: number }[], over: Record<string, unknown> = {}) => call("POST pos direct", cantina, "POST", "/api/pos/direct-sales", directBody(lines, over));
const sellCounter = (studentId: string, shiftId: string, lines: { productId: string; quantity?: number }[]) =>
  call("POST pos sales", cantina, "POST", "/api/pos/sales", { key: randomUUID(), studentId, expectedShiftId: shiftId, lines: lines.map((l) => line(l.productId, l.quantity)) });

const buy = (body: unknown) => viaCommand(() => placeAdvanceOrders(db(), actorOf(guardian), body, () => NOW));
async function placeOrder(studentId: string, productId: string, quantity: number, date = BASE) {
  const r = await buy({ key: randomUUID(), studentId, expectedShiftId: ST, days: [{ date, lines: [line(productId, quantity)] }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body.orders as { orderId: string }[])[0]!.orderId;
}
const deliver = (orderId: string, studentId: string, lines: { lineNo: number; quantity: number }[], key: string = randomUUID()) =>
  call("POST deliver", cantina, "POST", `/api/operations/orders/${orderId}/deliver`, { key, studentId, lines }, orderId);
const cancelAll = (user: TestUser, role: "guardian" | "cantina" | "admin", orderId: string) => viaCommand(() => cancelOrder(db(), actorOf(user, role), { key: randomUUID(), reason: "Mudança de planos da família", orderId }, () => NOW));

/** Percorre CHAVES e valores de texto de um JSON (para provar que nada de custo/aluno vaza). */
function walk(value: unknown, onKey: (k: string) => void, onString: (s: string) => void): void {
  if (Array.isArray(value)) value.forEach((v) => walk(v, onKey, onString));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      onKey(k);
      walk(v, onKey, onString);
    }
  }
  else if (typeof value === "string") onString(value);
}

/* ------------------------------------------------------------------------------------- autorização */

describe("autorização: administração vê custo/lucro; cantina só quantidades e valores; demais negados (A30)", () => {
  // Testes ESTÁTICOS (um `it` por papel e rota): o gate compara testes listados × executados e não expande laços.
  it("relatório: anônimo recebe 401", async () => expect((await report(null)).status).toBe(401));
  it("relatório: secretaria recebe 403", async () => expect((await report(secretaria)).status).toBe(403));
  it("relatório: responsável recebe 403", async () => expect((await report(guardian)).status).toBe(403));
  it("relatório: aluno recebe 403", async () => expect((await report(studentUser)).status).toBe(403));
  it("relatório: cantina recebe 200 na visão operacional e administração na completa", async () => {
    const c = await report(cantina);
    expect(c.status).toBe(200);
    expect(c.body.scope).toBe("operational");
    const a = await report(admin);
    expect(a.status).toBe(200);
    expect(a.body.scope).toBe("full");
  });
  it("exportação: anônimo 401, secretaria 403, responsável 403, aluno 403", async () => {
    expect((await exportRaw(null, { view: "products" })).status).toBe(401);
    expect((await exportRaw(secretaria, { view: "products" })).status).toBe(403);
    expect((await exportRaw(guardian, { view: "products" })).status).toBe(403);
    expect((await exportRaw(studentUser, { view: "products" })).status).toBe(403);
  });
  it("cantina não exporta compras nem carteira", async () => {
    expect((await exportRaw(cantina, { view: "purchases" })).status).toBe(403);
    expect((await exportRaw(cantina, { view: "ledger" })).status).toBe(403);
    expect((await exportRaw(admin, { view: "purchases" })).status).toBe(200);
  });
  it("permissão extra da secretaria (estorno) não abre relatórios", async () => {
    await writeDemoDoc(targetFromEnv(), `users/${secretaria.uid}`, { email: secretaria.email, displayName: "Secretaria Relatórios", role: "secretaria", status: "active", permissions: ["topup.reverse"], accessVersion: 5 });
    expect((await report(secretaria)).status).toBe(403);
    expect((await exportRaw(secretaria, { view: "summary" })).status).toBe(403);
  });
  it("administração rebaixada perde o acesso na hora (perfil relido a cada chamada)", async () => {
    const temp = await createTestUser("rtemp", "admin", { displayName: "Admin Temporário" });
    expect((await report(temp)).body.scope).toBe("full");
    await writeDemoDoc(targetFromEnv(), `users/${temp.uid}`, { email: temp.email, displayName: "Admin Temporário", role: "cantina", status: "active", permissions: [], accessVersion: 9 });
    expect((await report(temp)).body.scope).toBe("operational");
  });
  it("NENHUMA rota de relatório fica sem teste de autorização (a lista acompanha as rotas existentes)", () => {
    const found = (readdirSync("src/app/api/reports", { recursive: true }) as string[]).map((f) => f.replace(/\\/g, "/")).filter((f) => f.endsWith("route.ts")).sort();
    expect(found).toEqual(["sales/export/route.ts", "sales/route.ts"]);
    const literal = readFileSync("tests/integration/sales-report-api.test.ts", "utf8");
    expect(literal).toContain('call("GET sales"');
    expect(literal).toContain("exportRaw(secretaria");
  });
});

describe("consulta: período, filtros e entradas inválidas", () => {
  it("período invertido, acima de 93 dias, data inválida, chave desconhecida e canal inexistente são recusados", async () => {
    expect((await report(admin, { from: d(1), to: d(0) })).body.error).toBe("invalid_range");
    const long = await report(admin, { from: d(-93), to: d(0) });
    expect(long).toMatchObject({ status: 409, body: { error: "range_too_long", details: { maxDays: 93 } } });
    expect((await report(admin, { from: d(-92), to: d(0) })).status).toBe(200); // 93 dias exatos passam
    expect((await report(admin, { from: "2026-02-30" })).status).toBe(400);
    expect((await report(admin, { bogus: "1" })).status).toBe(400);
    expect((await report(admin, { channel: "online" })).status).toBe(400);
    expect((await report(admin, { shiftId: "../x" })).status).toBe(400);
  });
});

/* ---------------------------------------------------------------- A20 / A21: receita, CMV e lucro bruto */

const S: { pa: string; firstSaleKey: string; before: Realized | null } = { pa: "", firstSaleKey: "", before: null };

describe("A20/A21: custo médio, receita realizada e lucro bruto; mudança atual não reescreve o histórico", () => {
  it("100×R$1,00 + 100×R$1,10; vender 10 a R$2,00 → receita R$20,00, CMV R$10,50, lucro bruto R$9,50", async () => {
    S.pa = await newProduct({ price: 200, stock: 100, unitCost: "1,00" });
    await receive(S.pa, 100, "1,10");
    const body = directBody([{ productId: S.pa, quantity: 10 }]);
    S.firstSaleKey = body.key;
    const sale = await call("POST pos direct", cantina, "POST", "/api/pos/direct-sales", body);
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const r = await report(admin, { productId: S.pa });
    const t = realizedOf(r).totals;
    expect(t).toMatchObject({ units: 10, revenueCents: 2000, cogsCents: 1050, costMicros: 1_050_000_000, grossProfitCents: 950, marginBp: 4750, complete: true });
    expect(realizedOf(r).byChannel).toEqual([expect.objectContaining({ key: "direct", units: 10, revenueCents: 2000 })]);
    S.before = realizedOf(r);
  });

  it("repetir o MESMO comando (mesma chave) não vende nem contabiliza de novo (replay)", async () => {
    const again = await call("POST pos direct", cantina, "POST", "/api/pos/direct-sales", { ...directBody([{ productId: S.pa, quantity: 10 }]), key: S.firstSaleKey });
    expect(again.body.replayed).toBe(true);
    expect(realizedOf(await report(admin, { productId: S.pa })).totals).toMatchObject({ units: 10, revenueCents: 2000, cogsCents: 1050 });
  });

  it("mudar preço do produto e entrar compra mais cara NÃO altera a baixa histórica (A21)", async () => {
    await db().doc(`products/${S.pa}`).update({ priceCents: 300, priceVersion: 2 });
    prices.set(S.pa, 300);
    await receive(S.pa, 100, "1,50");
    const r = await report(admin, { productId: S.pa });
    expect(realizedOf(r)).toEqual(S.before);
  });

  it("saída seguinte usa o custo médio novo; as duas saídas somam exatas e o CMV é arredondado uma vez", async () => {
    // estoque: 190 un. com R$ 199,50 (210,00 − 10,50) + 100 un. a R$ 1,50 = 290 un. com R$ 349,50; saída de 10 = 34 950 ÷ 29 = R$ 12,0517241 (arredondado em micro: 1 205 172 414)
    const sale = await sellDirect([{ productId: S.pa, quantity: 10 }]);
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const t = realizedOf(await report(admin, { productId: S.pa })).totals;
    expect(t.units).toBe(20);
    expect(t.revenueCents).toBe(2000 + 3000);
    expect(t.costMicros).toBe(1_050_000_000 + 1_205_172_414);
    expect(t.cogsCents).toBe(2255); // 2 255,172414 centavos → 2 255
    expect(t.grossProfitCents).toBe(5000 - 2255);
    // o relatório confere com o livro de custos lido direto (soma independente dos movimentos de saída)
    const exits = (await db().collection(`stockCosts/${S.pa}/movements`).where("type", "==", "sale_exit").get()).docs.map((x) => x.data());
    expect(exits.reduce((n, m) => n + Math.abs(Number(m.totalCostMicros)), 0)).toBe(t.costMicros);
    expect(exits.reduce((n, m) => n + Number(m.revenueCents), 0)).toBe(t.revenueCents);
  });

  it("reconstruir: duas leituras seguidas dão exatamente o mesmo relatório (sem estado próprio)", async () => {
    const a = await report(admin, { productId: S.pa });
    const b = await report(admin, { productId: S.pa });
    expect(b.body).toEqual(a.body);
    expect((a.body.checks as { ok: boolean }[]).every((c) => c.ok)).toBe(true);
    expect(a.body.duplicatesIgnored).toBe(0);
  });
});

/* ------------------------------------------------------ canais, entrega, cancelamento, a realizar, retido */

const F: { pb: string; s1: string; s2: string; order1: string; futureOrder: string; stuckOrder: string; retainedOrder: string } = { pb: "", s1: "", s2: "", order1: "", futureOrder: "", stuckOrder: "", retainedOrder: "" };

describe("canais, entrega parcial, cancelamento e reembolso, pedido futuro, não retirado e cobrança retida", () => {
  it("monta o cenário: entrega de 3 de 4 + cancelamento do restante; balcão; venda direta; pedido futuro; não retirados", async () => {
    F.pb = await newProduct({ price: 500, stock: 100, unitCost: "1,00", cat: CAT2 });
    F.s1 = await newStudent({ shift: ST });
    F.s2 = await newStudent({ shift: SM });
    // 1) pedido antecipado de 4 (R$ 20,00): entrega 3 (R$ 15,00) e a família cancela o restante (reembolso R$ 5,00)
    F.order1 = await placeOrder(F.s1, F.pb, 4);
    const delivery = await deliver(F.order1, F.s1, [{ lineNo: 1, quantity: 3 }]);
    expect(delivery.status, JSON.stringify(delivery.body)).toBe(200);
    const cancel = await cancelAll(guardian, "guardian", F.order1);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body).toMatchObject({ refundCents: 500, canceledUnits: 1 });
    // 2) balcão com saldo (aluno do turno da manhã): 2 un. = R$ 10,00
    const counter = await sellCounter(F.s2, SM, [{ productId: F.pb, quantity: 2 }]);
    expect(counter.status, JSON.stringify(counter.body)).toBe(200);
    // 3) venda direta em dinheiro: 1 un. = R$ 5,00
    expect((await sellDirect([{ productId: F.pb }])).status).toBe(200);
    // 4) pedido futuro pago, ainda não realizado: 2 un. em hoje+2 = R$ 10,00
    F.futureOrder = await placeOrder(F.s1, F.pb, 2, d(2));
    // 5) não retirado ainda SEM resolução: 1 un. (R$ 5,00) com data já passada
    F.stuckOrder = await placeOrder(F.s1, F.pb, 1);
    await db().doc(`orders/${F.stuckOrder}`).update({ consumptionDate: d(-1) }); // fixture do emulador: o dia já passou
    expect((await call("POST not-picked-up", cantina, "POST", `/api/operations/orders/${F.stuckOrder}/not-picked-up`, { key: randomUUID(), reason: "Família avisou que não virá" }, F.stuckOrder)).status).toBe(200);
    // 6) não retirado ENCERRADO com cobrança mantida: 1 un. (R$ 5,00)
    F.retainedOrder = await placeOrder(F.s1, F.pb, 1);
    await db().doc(`orders/${F.retainedOrder}`).update({ consumptionDate: d(-1) });
    expect((await call("POST not-picked-up", cantina, "POST", `/api/operations/orders/${F.retainedOrder}/not-picked-up`, { key: randomUUID(), reason: "Família avisou que não virá" }, F.retainedOrder)).status).toBe(200);
    const closed = await call("POST resolve", admin, "POST", `/api/operations/orders/${F.retainedOrder}/resolve`, { key: randomUUID(), resolution: "close_charged", reason: "Política da escola: cobrança mantida" }, F.retainedOrder);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("vendas realizadas por canal: antecipado 3 un./R$15, balcão 2 un./R$10, direta 1 un./R$5; CMV R$1,00 por unidade", async () => {
    const r = await report(admin, { productId: F.pb });
    const rz = realizedOf(r);
    const ch = Object.fromEntries(rz.byChannel.map((c) => [c.key, [c.units, c.revenueCents]]));
    expect(ch).toEqual({ advance: [3, 1500], counter: [2, 1000], direct: [1, 500] });
    expect(rz.totals).toMatchObject({ units: 6, revenueCents: 3000, cogsCents: 600, grossProfitCents: 2400, marginBp: 8000, complete: true });
    expect(rz.origins).toBe(3); // pedido antecipado, pedido de balcão e venda direta
  });

  it("recarga e saldo não são receita: o crédito de R$ 500,00 por aluno (fixture) não aparece nas vendas", async () => {
    const rz = realizedOf(await report(admin, { productId: F.pb }));
    expect(rz.totals.revenueCents).toBe(3000);
  });

  it("filtro de turno e de categoria recortam; canal e produto combinam", async () => {
    expect(realizedOf(await report(admin, { productId: F.pb, shiftId: SM })).totals).toMatchObject({ units: 2, revenueCents: 1000 }); // só o balcão (aluno da manhã)
    expect(realizedOf(await report(admin, { productId: F.pb, shiftId: ST })).totals).toMatchObject({ units: 4, revenueCents: 2000 }); // antecipado + direta
    expect(realizedOf(await report(admin, { productId: F.pb, channel: "counter" })).totals).toMatchObject({ units: 2, revenueCents: 1000 });
    expect(realizedOf(await report(admin, { categoryId: CAT2 })).totals).toMatchObject({ units: 6, revenueCents: 3000 }); // PB é a única venda da categoria
    expect(realizedOf(await report(admin, { categoryId: CAT })).byProduct.map((p) => p.productId)).toContain(S.pa);
    expect(realizedOf(await report(admin, { productId: F.pb, channel: "advance", shiftId: SM })).totals.units).toBe(0);
  });

  it("conservação do pedido 1: pago R$20,00 = entregue R$15,00 + reembolsado R$5,00 (nada a realizar)", async () => {
    const order = (await doc(`orders/${F.order1}`))!;
    const exits = (await db().collection(`stockCosts/${F.pb}/movements`).where("referenceId", "==", F.order1).get()).docs.map((x) => Number(x.get("revenueCents")));
    expect(Number(order.totalCents)).toBe(2000);
    expect(exits.reduce((a, b) => a + b, 0) + Number(order.refundedCents)).toBe(2000);
    const detail = await exportRaw(admin, { view: "detail", productId: F.pb });
    const rows = csvRows(await detail.text());
    const header = rows[0]!;
    const fromOrder = rows.slice(1).filter((r) => r[header.indexOf("Origem")] === `order:${F.order1}`);
    expect(fromOrder).toHaveLength(1);
    expect(fromOrder[0]![header.indexOf("Receita (R$)")]).toBe("15,00");
  });

  it("cancelamento e reembolso do período: 1 unidade, R$ 5,00, pela família — separado das vendas", async () => {
    const c = (await report(admin, { productId: F.pb })).body.cancellations as { totals: { events: number; units: number; refundCents: number }; byKind: { kind: string; refundCents: number }[] };
    expect(c.totals).toEqual({ events: 1, units: 1, refundCents: 500 });
    expect(c.byKind).toEqual([{ kind: "family", events: 1, units: 1, refundCents: 500 }]);
  });

  it("pedidos pagos a realizar (posição de hoje): futuro R$ 10,00 em 'próximos 7 dias' e não retirado SEM resolução como data já passada", async () => {
    const p = (await report(admin, { productId: F.pb })).body.pending as { buckets: { bucket: string; orders: number; units: number; valueCents: number }[]; totals: { orders: number; units: number; valueCents: number }; estimate: { costCents: number; marginCents: number; missingCostUnits: number } };
    const by = Object.fromEntries(p.buckets.map((b) => [b.bucket, [b.orders, b.units, b.valueCents]]));
    expect(by).toEqual({ overdue: [1, 1, 500], today: [0, 0, 0], next7: [1, 2, 1000], later: [0, 0, 0] });
    expect(p.totals).toEqual({ orders: 2, units: 3, valueCents: 1500 });
    // margem ESTIMADA (custo médio atual R$ 1,00): 3 un. → custo R$ 3,00; margem R$ 12,00; é estimativa e não entra no realizado
    expect(p.estimate).toMatchObject({ costCents: 300, marginCents: 1200, missingCostUnits: 0 });
    expect(realizedOf(await report(admin, { productId: F.pb })).totals.units).toBe(6); // o futuro NÃO virou venda
  });

  it("cobrança retida (não retirado encerrado): R$ 5,00 em linha própria; não é venda, reembolso nem perda", async () => {
    const r = await report(admin, { shiftId: ST });
    const retained = r.body.retained as { orders: number; units: number; amountCents: number };
    expect(retained).toEqual({ orders: 1, units: 1, amountCents: 500 });
    // o filtro de canal vale para a cobrança retida (pedido antecipado) e para a realizar e os cancelamentos
    expect((await report(admin, { shiftId: ST, channel: "advance" })).body.retained).toEqual(retained);
    expect((await report(admin, { shiftId: ST, channel: "counter" })).body.retained).toEqual({ orders: 0, units: 0, amountCents: 0 });
    expect((await report(admin, { productId: F.pb, channel: "counter" })).body.pending).toMatchObject({ totals: { orders: 0, units: 0, valueCents: 0 } });
    expect((await report(admin, { productId: F.pb, channel: "direct" })).body.cancellations).toMatchObject({ totals: { events: 0, refundCents: 0 } });
    expect((await report(admin, { productId: F.pb, channel: "advance" })).body.cancellations).toMatchObject({ totals: { events: 1, refundCents: 500 } });
    expect(realizedOf(await report(admin, { productId: F.pb })).totals.revenueCents).toBe(3000); // continua sem os R$ 5,00 retidos
    expect((await report(admin, { productId: F.pb })).body.retained).toBeNull(); // filtro de produto: seção da escola/turno omitida
    expect(((await report(admin, { productId: F.pb })).body.skipped as Record<string, string>).retained).toContain("produto");
    const refunded = (await doc(`orders/${F.retainedOrder}`))!;
    expect(Number(refunded.refundedCents ?? 0)).toBe(0);
  });

  it("entrega repetida com a mesma chave não conta duas vezes", async () => {
    const o = await placeOrder(F.s1, F.pb, 1);
    const key = randomUUID();
    const first = await deliver(o, F.s1, [{ lineNo: 1, quantity: 1 }], key);
    expect(first.status).toBe(200);
    const before = realizedOf(await report(admin, { productId: F.pb })).totals;
    const again = await deliver(o, F.s1, [{ lineNo: 1, quantity: 1 }], key);
    expect(again.status).toBe(200);
    const after = realizedOf(await report(admin, { productId: F.pb })).totals;
    expect(after).toEqual(before);
    expect(after.units).toBe(7);
  });
});

/* ------------------------------------------------------------- perdas, compras e ajustes ficam fora do CMV */

const L: { pl: string } = { pl: "" };

describe("perdas, compras de estoque e ajustes: separados do CMV e do resultado", () => {
  it("compra de 10 a R$ 2,00 e perda de 3 por quebra (R$ 6,00): aparecem à parte, sem tocar receita nem CMV", async () => {
    L.pl = await newProduct({ price: 400, stock: 10, unitCost: "2,00", cat: CAT3 });
    const loss = await call("POST losses", cantina, "POST", "/api/inventory/losses", { key: randomUUID(), productId: L.pl, quantity: 3, reason: "breakage", note: "Quebra no transporte da cantina" });
    expect(loss.status, JSON.stringify(loss.body)).toBe(200);
    const r = await report(admin, { productId: L.pl });
    expect(realizedOf(r).totals).toMatchObject({ units: 0, revenueCents: 0, cogsCents: 0 });
    const losses = r.body.losses as { rows: { reasonCode: string; units: number; costMicros: number }[]; totals: { units: number; costCents: number } };
    expect(losses.rows).toEqual([expect.objectContaining({ reasonCode: "breakage", units: 3, costMicros: 600_000_000 })]);
    expect(losses.totals).toMatchObject({ units: 3, costCents: 600 });
    const purchases = r.body.purchases as { rows: { kind: string; units: number; costMicros: number }[]; netCostCents: number };
    expect(purchases.rows).toEqual([expect.objectContaining({ kind: "purchase", units: 10, costMicros: 2_000_000_000 })]);
    expect(purchases.netCostCents).toBe(2000);
  });

  it("estorno de entrada abate no período do estorno, pela data do ESTORNO (a compra não é reescrita)", async () => {
    const pr = await newProduct({ price: 100, stock: 0, cat: CAT3, name: "Produto de estorno" });
    const created = await receive(pr, 5, "2,00");
    const receiptId = String(created.body.receiptId);
    expect((await report(admin, { productId: pr })).body.purchases).toMatchObject({ netCostCents: 1000, reversals: { facts: 0 } });
    const reversal = await call("POST receipts", admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "reverse", receiptId, reason: "Entrada lançada por engano" });
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(200);
    const after = (await report(admin, { productId: pr })).body.purchases as { netCostCents: number; reversals: { facts: number; units: number; costMicros: number }; rows: { facts: number; costMicros: number }[] };
    expect(after.rows[0]).toMatchObject({ facts: 1, costMicros: 1_000_000_000 }); // a compra continua inteira
    expect(after.reversals).toEqual({ facts: 1, units: 5, costMicros: 1_000_000_000 });
    expect(after.netCostCents).toBe(0);
  });

  it("ajuste de contagem aparece à parte (fora de perda, CMV e resultado)", async () => {
    const adj = await call("POST adjustments", admin, "POST", "/api/inventory/adjustments", { key: randomUUID(), action: "adjust", productId: L.pl, delta: -1, reason: "Falta encontrada na contagem" });
    expect(adj.status, JSON.stringify(adj.body)).toBe(200);
    const a = (await report(admin, { productId: L.pl })).body.adjustments as { netUnits: number; netCostCents: number };
    expect(a).toMatchObject({ netUnits: -1, netCostCents: -200 });
    expect(((await report(admin, { productId: L.pl })).body.losses as { totals: { units: number } }).totals.units).toBe(3); // continua só a quebra
  });

  it("a visão da cantina mostra a perda em UNIDADES, sem custo, e nunca a compra", async () => {
    const r = await report(cantina, { productId: L.pl });
    expect(r.body.losses).toEqual({ rows: [{ productId: L.pl, name: names.get(L.pl), reasonCode: "breakage", units: 3 }], totalUnits: 3 });
    expect(r.body.purchases).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ pendências em vez de zero */

const P: { pm: string; badPath: string; costless: string } = { pm: "", badPath: "", costless: "" };

describe("custo ou receita ausente e documento ilegível são PENDÊNCIA, nunca zero", () => {
  it("baixa sem custo: receita conta, CMV não, lucro fica PARCIAL; resultado deixa de ser definitivo", async () => {
    P.pm = await newProduct({ price: 200, stock: 0, cat: CAT2, name: "Produto pendente de registro" });
    P.costless = `stockCosts/${P.pm}/movements/m000000001`;
    synthetic.push(P.costless);
    await db().doc(P.costless).set({ seq: 1, type: "sale_exit", quantity: -3, onHandAfter: 0, referenceType: "order", referenceId: "inexistente", revenueCents: 600, createdAt: Timestamp.now() }); // sem totalCostMicros
    const r = await report(admin, { productId: P.pm });
    const t = realizedOf(r).totals;
    expect(t).toMatchObject({ units: 3, revenueCents: 600, cogsCents: 0, missingCostUnits: 3, complete: false });
    expect(t.grossProfitCents).toBe(0); // base do lucro vazia: a tela mostra "pendente", não R$ 0,00 como se fosse resultado
    const pend = r.body.pendencies as { code: string; count: number }[];
    expect(pend).toEqual(expect.arrayContaining([expect.objectContaining({ code: "cost_missing", count: 3 }), expect.objectContaining({ code: "origin_missing", count: 1 })]));
    const channels = realizedOf(r).byChannel;
    expect(channels).toEqual([expect.objectContaining({ key: "unknown", units: 3 })]);
  });

  it("documento ilegível (sem quantidade) é contado como pendência e torna o resultado da escola parcial", async () => {
    P.badPath = `stockCosts/${P.pm}/movements/m000000002`;
    synthetic.push(P.badPath);
    await db().doc(P.badPath).set({ seq: 2, type: "sale_exit", referenceType: "order", referenceId: "x", createdAt: Timestamp.now() });
    const r = await report(admin);
    expect((r.body.pendencies as { code: string; count: number }[]).find((p) => p.code === "unreadable_baixas de venda")?.count).toBeGreaterThanOrEqual(1);
    const result = r.body.result as { resultCents: number; grossProfitCents: number; lossCostCents: number; feesCents: number; definitive: boolean };
    expect(result.definitive).toBe(false);
    expect(result.resultCents).toBe(result.grossProfitCents - result.lossCostCents - result.feesCents); // contas do resultado fecham
  });

  it("exportação mostra custo VAZIO e situação explícita (não '0,00'), e o produto como PARCIAL", async () => {
    const detail = csvRows(await (await exportRaw(admin, { view: "detail", productId: P.pm })).text());
    const h = detail[0]!;
    expect(detail[1]![h.indexOf("CMV exato (R$)")]).toBe("");
    expect(detail[1]![h.indexOf("Situação")]).toBe("Sem custo registrado");
    const products = csvRows(await (await exportRaw(admin, { view: "products", productId: P.pm })).text());
    const ph = products[0]!;
    expect(products[1]![ph.indexOf("Situação")]).toBe("PARCIAL");
    expect(products[1]![ph.indexOf("Unidades sem custo")]).toBe("3");
  });
});

/* ----------------------------------------------------------- períodos no fuso America/Sao_Paulo */

describe("limites do período: o dia local vai de 00:00 a 24:00 de America/Sao_Paulo", () => {
  it("23:59 de um dia e 00:00 do seguinte caem em dias diferentes; o fim do período é exclusivo", async () => {
    const px = await newProduct({ price: 100, stock: 0, cat: CAT3, name: "Produto de fronteira" });
    const late = `stockCosts/${px}/movements/m000000001`;
    const early = `stockCosts/${px}/movements/m000000002`;
    synthetic.push(late, early);
    const mk = (seqNo: number, at: Date) => ({ seq: seqNo, type: "sale_exit", quantity: -1, onHandAfter: 0, referenceType: "order", referenceId: "fronteira", revenueCents: 100, totalCostMicros: -40_000_000, createdAt: Timestamp.fromDate(at) });
    await db().doc(late).set(mk(1, school.localInstant(d(-3), "23:59")));
    await db().doc(early).set(mk(2, school.localInstant(d(-2), "00:00")));
    const day1 = realizedOf(await report(admin, { from: d(-3), to: d(-3), productId: px }));
    const day2 = realizedOf(await report(admin, { from: d(-2), to: d(-2), productId: px }));
    expect([day1.totals.units, day1.byDay.map((x) => x.key)]).toEqual([1, [d(-3)]]);
    expect([day2.totals.units, day2.byDay.map((x) => x.key)]).toEqual([1, [d(-2)]]);
    const both = realizedOf(await report(admin, { from: d(-3), to: d(-2), productId: px }));
    expect(both.byDay.map((x) => [x.key, x.units])).toEqual([[d(-3), 1], [d(-2), 1]]);
    expect(both.totals).toMatchObject({ units: 2, revenueCents: 200, costMicros: 80_000_000 });
    expect(realizedOf(await report(admin, { from: d(-1), to: d(-1), productId: px })).totals.units).toBe(0);
  });
});

/* ---------------------------------------------------------------- visão da cantina e privacidade */

describe("a cantina não recebe custo, margem, lucro, taxa nem dado de aluno (A30)", () => {
  it("nenhuma chave de custo/lucro/taxa/resultado/compra/carteira e nenhum nome de aluno, em nenhum filtro", async () => {
    for (const params of [{}, { productId: S.pa }, { productId: F.pb }, { categoryId: CAT2 }, { shiftId: ST }]) {
      const r = await report(cantina, params);
      expect(r.status).toBe(200);
      const keys: string[] = [];
      const strings: string[] = [];
      walk(r.body, (k) => keys.push(k), (s) => strings.push(s));
      expect(keys.filter((k) => /cost|cogs|profit|margin|fee|result|purchase|ledger|wallet|estimate|check|student/i.test(k)), JSON.stringify(params)).toEqual([]);
      expect(strings.filter((s) => /Aluno Relatório/.test(s))).toEqual([]);
    }
  });

  it("os números da cantina batem com os da administração (mesma projeção, corte só nos campos)", async () => {
    const c = realizedOf(await report(cantina, { productId: F.pb }));
    const a = realizedOf(await report(admin, { productId: F.pb }));
    expect([c.totals.units, c.totals.revenueCents]).toEqual([a.totals.units, a.totals.revenueCents]);
    expect(c.byChannel.map((x) => [x.key, x.units, x.revenueCents])).toEqual(a.byChannel.map((x) => [x.key, x.units, x.revenueCents]));
    expect((await report(cantina, { productId: F.pb })).body.pending).toMatchObject({ totals: { orders: 2, units: 3, valueCents: 1500 } });
  });

  it("exportação da cantina não tem coluna de custo/margem/lucro/taxa", async () => {
    for (const view of ["summary", "products", "detail", "losses", "pending", "cancellations"]) {
      const res = await exportRaw(cantina, { view });
      expect(res.status, view).toBe(200);
      const text = await res.text();
      expect(text, view).not.toMatch(/CMV|Lucro|Margem|Taxa|custo|Resultado|Carteiras/i);
      expect(res.headers.get("x-report-scope")).toBe("operational");
    }
  });
});

/* --------------------------------------------------------------------------- reversões externas pendentes */

describe("reversões externas (reembolso/chargeback): posição de hoje separada de receita e de perda", () => {
  it("pendências abertas e o já absorvido aparecem à parte; a cantina nem vê a seção", async () => {
    const read = async () => (await report(admin)).body.reversals as { pendencies: number; open: number; openedCents: number; outstandingCents: number; recoveredCents: number; writtenOffCents: number };
    const before = await read();
    const open = `paymentPendencies/rvp_${tag}_1`;
    const done = `paymentPendencies/rvp_${tag}_2`;
    synthetic.push(open, done);
    await db().doc(open).set({ pendencyId: `rvp_${tag}_1`, status: "open", openedCents: 1000, outstandingCents: 700, recoveredCents: 300, writtenOffCents: 0 });
    await db().doc(done).set({ pendencyId: `rvp_${tag}_2`, status: "resolved", openedCents: 500, outstandingCents: 0, recoveredCents: 0, writtenOffCents: 500 });
    const after = await read();
    expect({ pendencies: after.pendencies - before.pendencies, open: after.open - before.open, openedCents: after.openedCents - before.openedCents, outstandingCents: after.outstandingCents - before.outstandingCents, recoveredCents: after.recoveredCents - before.recoveredCents, writtenOffCents: after.writtenOffCents - before.writtenOffCents }).toEqual({
      pendencies: 2,
      open: 1,
      openedCents: 1500,
      outstandingCents: 700,
      recoveredCents: 300,
      writtenOffCents: 500,
    });
    const codes = ((await report(admin)).body.pendencies as { code: string }[]).map((p) => p.code);
    expect(codes).toContain("reversal_open");
    expect(JSON.stringify((await report(cantina)).body)).not.toMatch(/reversal|pendenc.*revers/i);
    // a receita realizada do dia não muda com a pendência
    expect(realizedOf(await report(admin, { productId: S.pa })).totals.revenueCents).toBe(5000);
  });
});

/* ------------------------------------------------------------------------------ carteiras e conferências */

describe("carteira, taxas e conferências da escola inteira (administração)", () => {
  it("o livro separa crédito de recarga, compra, reembolso e transferência; os reembolsos conferem com os cancelamentos", async () => {
    const r = await report(admin);
    const ledger = r.body.ledger as { rows: { type: string; entries: number; amountCents: number }[]; walletBalanceCents: number | null; walletCount: number | null } | null;
    expect(ledger).not.toBeNull();
    const type = (t: string) => ledger!.rows.find((x) => x.type === t);
    expect(type("advance_purchase")?.amountCents).toBeLessThan(0);
    expect(type("counter_purchase")?.amountCents).toBeLessThan(0);
    expect(type("order_refund")?.amountCents).toBeGreaterThanOrEqual(500);
    // Esperado calculado à parte, direto dos documentos de origem do dia (consulta independente da projeção)
    const start = Timestamp.fromDate(school.localInstant(BASE, "00:00"));
    const end = Timestamp.fromDate(school.localInstant(d(1), "00:00"));
    const rawCancel = (await db().collectionGroup("cancellations").where("createdAt", ">=", start).where("createdAt", "<", end).get()).docs.reduce((n, x) => n + Number(x.get("refundCents")), 0);
    const rawEntries = (await db().collectionGroup("entries").where("createdAt", ">=", start).where("createdAt", "<", end).get()).docs.map((x) => x.data() as { type: string; amountCents: number });
    const sumOf = (t: string) => rawEntries.filter((e) => e.type === t).reduce((n, e) => n + e.amountCents, 0);
    expect(rawCancel).toBeGreaterThanOrEqual(500);
    expect(type("order_refund")?.amountCents).toBe(sumOf("order_refund"));
    expect(type("advance_purchase")?.amountCents).toBe(sumOf("advance_purchase"));
    expect(type("counter_purchase")?.amountCents).toBe(sumOf("counter_purchase"));
    expect(type("topup")?.amountCents ?? 0).toBe(sumOf("topup"));
    const checks = r.body.checks as { id: string; ok: boolean; expected: number; actual: number }[];
    expect(checks.find((c) => c.id === "refunds_ledger")).toMatchObject({ expected: rawCancel, actual: sumOf("order_refund"), ok: rawCancel === sumOf("order_refund") });
    expect(checks.find((c) => c.id === "transfers_net_zero")).toMatchObject({ expected: 0, actual: sumOf("transfer_in") + sumOf("transfer_out") });
    expect(checks.filter((c) => /^(units|revenue|cost)_/.test(c.id)).every((c) => c.ok)).toBe(true); // agrupamentos fecham entre si
    expect(checks.find((c) => c.id === "sold_within_paid")).toMatchObject({ kind: "cross", expected: 0, actual: 0, ok: true }); // nenhuma baixa passa do valor pago do pedido
    expect(checks.find((c) => c.id === "refunds_ledger")?.ok).toBe(true); // nesta suíte todo reembolso nasce junto do cancelamento
    // saldo agregado das carteiras conferido por soma independente dos documentos
    const wallets = await db().collection("wallets").get();
    expect(ledger!.walletBalanceCents).toBe(wallets.docs.reduce((n, w) => n + Number(w.get("balanceCents") ?? 0), 0));
    expect(ledger!.walletCount).toBe(wallets.size);
  });

  it("taxa efetiva do período vem do relatório financeiro (uma por recebimento) e a seção da escola inteira some com filtro", async () => {
    const r = await report(admin);
    expect(r.body.fees).toMatchObject({ unknownCount: expect.any(Number), effectiveCents: expect.any(Number) });
    expect(r.body.skipped).toEqual({});
    const f = await report(admin, { shiftId: ST });
    expect(f.body.result).toBeNull();
    expect(f.body.fees).toBeNull();
    expect(f.body.ledger).toBeNull();
    expect((f.body.skipped as Record<string, string>).result).toContain("turno");
  });

  it("recebimentos externos e liquidação = relatório financeiro da F20 (mesma função, sem recontar); venda direta em dinheiro entra uma vez", async () => {
    const mine = (await report(admin)).body.receipts as Record<string, number>;
    const f20 = (await call("GET finance report", admin, "GET", `/api/admin/finance/report?from=${BASE}&to=${BASE}`)).body.totals as Record<string, number>;
    for (const k of ["count", "grossCents", "reversedCents", "feeConfirmedCents", "feeInformedCents", "feeEstimatedCents", "feeUnknownCount", "feeEffectiveCents", "netExpectedCents", "netRealCents", "settledGrossCents", "pendingGrossCents", "overdueGrossCents"]) expect(mine[k], k).toBe(f20[k]);
    // as vendas diretas em dinheiro deste arquivo (R$ 20,00 + R$ 30,00 + R$ 5,00 + R$ 8,00 ...) estão no bruto recebido, que NÃO é a receita de vendas
    expect(mine.grossCents).toBeGreaterThanOrEqual(2000 + 3000 + 500);
    expect(((await report(admin, { productId: S.pa })).body as { receipts: unknown }).receipts).toBeNull(); // seção da escola inteira
    expect(JSON.stringify((await report(cantina)).body)).not.toContain("grossCents");
  });

  it("ambiente de teste aparece identificado no relatório e na exportação", async () => {
    expect((await report(admin)).body.production).toBe(false);
    const summary = csvRows(await (await exportRaw(admin, { view: "summary" })).text());
    expect(summary.find((r) => r[0] === "Ambiente")?.slice(0, 3)).toEqual(["Ambiente", "Teste / homologação", "Dados FICTÍCIOS: não representam a operação real da escola"]);
  });
});

/* ------------------------------------------------------------------------------------- exportação */

describe("exportação CSV e XLSX: segura, completa e conferindo com o resumo", () => {
  it("nome de produto com fórmula é neutralizado; detalhe soma o total do resumo por produto", async () => {
    const evil = await newProduct({ price: 100, stock: 20, cat: CAT2, name: "=1+1+PRODUTO" });
    expect((await sellDirect([{ productId: evil, quantity: 4 }])).status).toBe(200);
    const res = await exportRaw(admin, { view: "products", categoryId: CAT2 });
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain(`relatorio-products-${BASE}_${BASE}.csv`);
    const buffer = Buffer.from(await res.arrayBuffer());
    expect([...buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 (fetch.text() o descartaria)
    const text = buffer.toString("utf8");
    expect(text).toContain("'=1+1+PRODUTO");
    for (const cell of csvRows(text).flat()) expect(cell.startsWith("="), cell).toBe(false);
    const products = csvRows(text);
    const detail = csvRows(await (await exportRaw(admin, { view: "detail", categoryId: CAT2 })).text());
    const ph = products[0]!;
    const total = products.at(-1)!;
    const dh = detail[0]!;
    const money = (s: string) => Math.round(Number(s.replace(",", ".")) * 100);
    expect(total[0]).toBe("TOTAL");
    expect(detail.slice(1).reduce((n, r) => n + Number(r[dh.indexOf("Unidades")]), 0)).toBe(Number(total[ph.indexOf("Unidades")]));
    expect(detail.slice(1).reduce((n, r) => n + money(r[dh.indexOf("Receita (R$)")]!), 0)).toBe(money(total[ph.indexOf("Receita (R$)")]!));
    const exactCmv = detail.slice(1).reduce((n, r) => n + (r[dh.indexOf("CMV exato (R$)")] === "" ? 0 : Math.round(Number(r[dh.indexOf("CMV exato (R$)")]!.replace(",", ".")) * 1e8)), 0);
    expect(exactCmv).toBeGreaterThan(0);
    // o resumo da tela (JSON) e o CSV do mesmo filtro dizem o mesmo
    const screen = realizedOf(await report(admin, { categoryId: CAT2 })).totals;
    expect(Number(total[ph.indexOf("Unidades")])).toBe(screen.units);
    expect(money(total[ph.indexOf("Receita (R$)")]!)).toBe(screen.revenueCents);
  });

  it("XLSX válido (ZIP 'PK'), tipo correto, sem fórmula e com o texto neutralizado", async () => {
    const res = await exportRaw(admin, { view: "products", categoryId: CAT2, format: "xlsx" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toContain(".xlsx");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("PK");
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toContain("worksheets/sheet1.xml");
    expect(raw).not.toContain("<f>");
    expect(Buffer.from(bytes).toString("utf8")).toContain("'=1+1+PRODUTO");
  });

  it("exportação NUNCA é truncada em silêncio: teto estourado = 409, e o relatório avisa que é parcial", async () => {
    const r = await reportsMod.exportSales(db(), actorOf(admin, "admin"), { view: "detail", from: BASE, to: BASE }, () => new Date(), 1).catch((e: unknown) => e);
    expect(r).toMatchObject({ status: 409, code: "export_truncated" });
    const partial = (await reportsMod.salesReport(db(), actorOf(admin, "admin"), { from: BASE, to: BASE }, () => new Date(), 1)) as { truncated: string[]; result: { definitive: boolean } | null; pendencies: { code: string }[] };
    expect(partial.truncated).toContain("movimentos de estoque");
    expect(partial.result?.definitive).toBe(false);
    expect(partial.pendencies.map((p) => p.code)).toContain("truncated_movimentos de estoque");
  });

  it("exportação de filtro que omite a seção é recusada em vez de entregar arquivo enganoso", async () => {
    const res = await exportRaw(admin, { view: "ledger", shiftId: ST });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("view_unavailable");
    expect((await exportRaw(admin, { view: "inexistente" })).status).toBe(400);
    expect((await exportRaw(admin, { view: "products", format: "pdf" })).status).toBe(400);
  });
});
