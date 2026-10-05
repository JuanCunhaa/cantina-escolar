// Cancelamento e reembolso (F14) contra Auth/Firestore Emulator: total e parcial das quantidades remanescentes, pelo
// responsável (dentro do prazo salvo no pedido) e pela equipe (excepcional, com motivo); reembolso SÓ à carteira original,
// pelo valor PAGO registrado (A16), com livro/saldo, reserva/cota, uso da F09 e auditoria na MESMA transação; replay, resposta
// perdida, autorização revogada, limite exato do prazo, falha intermediária, aluno arquivado e as corridas entrega × cancelamento,
// dois cancelamentos e resolução de não retirado × cancelamento (A22/A23/A35). Pedidos reais nascem do checkout real; o saldo
// vem SÓ de fixture do emulador (não comprova nada no Firestore real).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
type Result = { status: number; body: Json };
type Item = { lineNo: number; productId: string; quantity: number; deliveredQty?: number; canceledQty?: number; reservationId: string; subtotalCents: number };

let placeAdvanceOrders: typeof import("@/modules/orders/commands").placeAdvanceOrders;
let cancelOrder: typeof import("@/modules/orders/cancellation").cancelOrder;
let commandErrorResponse: typeof import("@/modules/access/command-route").commandErrorResponse;
let receiptsRoute: Handler;
let capacityRoute: Handler;
let lossesRoute: Handler;
let reconcileRoute: Handler;
let deliverRoute: Handler;
let notPickedUpRoute: Handler;
let resolveRoute: Handler;
let cancelRoute: Handler;
let dayRoute: Handler;
let panelRoute: Handler;
let detailRoute: Handler;
let listRoute: Handler;
let statementRoute: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let checkLedger: typeof import("@/modules/wallet/model").checkLedger;
let parseWalletState: typeof import("@/modules/wallet/model").parseWalletState;
let school: typeof import("@/lib/dates/school-time");

let admin: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let cantina: TestUser;
let secretaria: TestUser;

const tag = randomUUID().slice(0, 6);
const ST = `shc_${tag}_t`;
const SM = `shc_${tag}_m`;
const CLS = `clc_${tag}`;
const CAT = `cac_${tag}`;
let BASE = "";
let NOW = new Date();
let seq = 0;
const d = (n: number) => school.addDays(BASE, n);
const prices = new Map<string, number>();
const noCtx = { params: Promise.resolve({ id: "" }) };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  ({ placeAdvanceOrders } = await import("@/modules/orders/commands"));
  ({ cancelOrder } = await import("@/modules/orders/cancellation"));
  ({ commandErrorResponse } = await import("@/modules/access/command-route"));
  receiptsRoute = (await import("@/app/api/inventory/receipts/route")).POST as unknown as Handler;
  capacityRoute = (await import("@/app/api/inventory/capacity/route")).POST as unknown as Handler;
  lossesRoute = (await import("@/app/api/inventory/losses/route")).POST as unknown as Handler;
  reconcileRoute = (await import("@/app/api/inventory/reconcile/route")).GET as unknown as Handler;
  deliverRoute = (await import("@/app/api/operations/orders/[id]/deliver/route")).POST as unknown as Handler;
  notPickedUpRoute = (await import("@/app/api/operations/orders/[id]/not-picked-up/route")).POST as unknown as Handler;
  resolveRoute = (await import("@/app/api/operations/orders/[id]/resolve/route")).POST as unknown as Handler;
  cancelRoute = (await import("@/app/api/orders/[id]/cancel/route")).POST as unknown as Handler;
  dayRoute = (await import("@/app/api/operations/orders/route")).GET as unknown as Handler;
  panelRoute = (await import("@/app/api/operations/preparation/route")).GET as unknown as Handler;
  detailRoute = (await import("@/app/api/orders/[id]/route")).GET as unknown as Handler;
  listRoute = (await import("@/app/api/orders/route")).GET as unknown as Handler;
  statementRoute = (await import("@/app/api/wallets/entries/route")).GET as unknown as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ checkLedger, parseWalletState } = await import("@/modules/wallet/model"));
  school = await import("@/lib/dates/school-time");
  BASE = school.localDateOf(new Date());
  NOW = school.localInstant(BASE, "09:00");
  [admin, guardianA, guardianB, cantina, secretaria] = await Promise.all([
    createTestUser("cadm", "admin"),
    createTestUser("cresp-a", "guardian"),
    createTestUser("cresp-b", "guardian"),
    createTestUser("ccant", "cantina"),
    createTestUser("csec", "secretaria"),
  ]);
  await globalDoc(`shifts/${ST}`, { name: `Tarde ${tag}`, nameSlug: "tarde", status: "active" });
  await globalDoc(`shifts/${SM}`, { name: `Manhã ${tag}`, nameSlug: "manha", status: "active" });
  await globalDoc(`classes/${CLS}`, { name: `Turma ${tag}`, nameSlug: "turma", status: "active" });
  await globalDoc(`categories/${CAT}`, { name: `Categoria ${tag}`, status: "active" });
  for (let i = 0; i <= 9; i++) await globalDoc(`calendarDays/${d(i)}`, { kind: "extra" });
});

const globalDocs: string[] = [];
const globalDoc = async (path: string, data: Record<string, string | number | boolean | null | string[]>) => {
  globalDocs.push(path);
  await writeDemoDoc(targetFromEnv(), path, data);
};
afterAll(async () => {
  for (const path of globalDocs.splice(0)) await adminDb().doc(path).delete();
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
async function call(handler: Handler, user: TestUser | null, method: string, url: string, body?: unknown, id = ""): Promise<Result> {
  const response = await handler(authed(method, url, user, body), id ? ctx(id) : noCtx);
  return { status: response.status, body: (await response.json()) as Json };
}
async function viaCommand(run: () => Promise<unknown>): Promise<Result> {
  try {
    return { status: 200, body: (await run()) as Json };
  } catch (error) {
    const response = commandErrorResponse(error, "teste");
    return { status: response.status, body: (await response.json()) as Json };
  }
}

const buy = (user: TestUser, body: unknown) => viaCommand(() => placeAdvanceOrders(db(), actorOf(user), body, () => NOW));
type Line = { productId: string; quantity?: number };
function cart(studentId: string, shiftId: string, days: Record<string, Line[]>) {
  return {
    key: randomUUID(),
    studentId,
    expectedShiftId: shiftId,
    days: Object.entries(days).map(([date, lines]) => ({ date, lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity ?? 1, expectedPriceCents: prices.get(l.productId)! })) })),
  };
}

async function newStudent(over: { cents?: number; status?: "active" | "inactive" } = {}) {
  const id = `stu_${tag}_${++seq}`;
  await seedStudentAccess({ studentId: id, name: `Aluno ${seq}`, guardianUids: [guardianA.uid], allowSitePurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name: `Aluno ${seq}`, status: over.status ?? "active", userUid: null, shiftId: ST, classId: CLS, version: 3 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: true, allowCounterPurchase: false, configVersion: 1 });
  await fundDemoWallet(targetFromEnv(), id, over.cents ?? 50000);
  return id;
}

async function newProduct(over: { price?: number; mode?: "physical" | "planned"; stock?: number; capacity?: Record<string, number> } = {}) {
  const id = `prd_${tag}_${++seq}`;
  const price = over.price ?? 500;
  await globalDoc(`products/${id}`, { name: `Produto ${seq}`, description: "", categoryId: CAT, priceCents: price, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [SM, ST], availabilityMode: over.mode ?? "physical", status: "active", version: 1 });
  await globalDoc(`defaultMenuRules/${id}`, { shiftIds: [SM, ST], version: 1 });
  prices.set(id, price);
  if ((over.mode ?? "physical") === "physical") {
    const r = await call(receiptsRoute, admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: over.stock ?? 500, unitCost: "1,00" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  for (const [date, capacity] of Object.entries(over.capacity ?? {})) {
    const [day, shiftId] = date.split("@");
    const r = await call(capacityRoute, admin, "POST", "/api/inventory/capacity", { key: randomUUID(), productId: id, date: day, shiftId: shiftId ?? ST, capacity });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return id;
}

/** Pedido real pelo checkout do site (relógio injetado: 09:00 de hoje, turno da tarde). `date` padrão: hoje. */
async function placeOrder(lines: Line[], over: { student?: string; date?: string } = {}) {
  const student = over.student ?? (await newStudent());
  const r = await buy(guardianA, cart(student, ST, { [over.date ?? BASE]: lines }));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const orderId = (r.body.orders as { orderId: string }[])[0]!.orderId;
  return { student, orderId };
}
const itemsOf = async (orderId: string) => (await doc(`orders/${orderId}`))!.items as Item[];
const lineOf = async (orderId: string, productId: string) => (await itemsOf(orderId)).find((i) => i.productId === productId)!.lineNo;
const cutoffOf = async (orderId: string) => ((await doc(`orders/${orderId}`))!.policy.cancelCutoffAt as { toDate(): Date }).toDate();

type CancelBody = { key?: string; reason?: string; lines?: { lineNo: number; quantity: number }[]; discards?: { lineNo: number; quantity: number }[] };
const body = (b: CancelBody) => ({ key: randomUUID(), reason: "Mudança de planos da família", ...b });
/** Comando direto com relógio injetado (limite do prazo e corridas controladas). */
const cancelAs = (user: TestUser, role: "guardian" | "cantina" | "admin", orderId: string, b: CancelBody = {}, clock: () => Date = () => NOW) => {
  const payload = { ...body(b), orderId };
  return viaCommand(() => cancelOrder(db(), actorOf(user, role), payload, clock));
};
const cancelHttp = (user: TestUser | null, orderId: string, b: CancelBody = {}) => call(cancelRoute, user, "POST", `/api/orders/${orderId}/cancel`, body(b), orderId);
const deliver = (user: TestUser | null, orderId: string, studentId: string, lines: { lineNo: number; quantity: number }[], key: string = randomUUID()) =>
  call(deliverRoute, user, "POST", `/api/operations/orders/${orderId}/deliver`, { key, studentId, lines }, orderId);
const notPickedUp = (user: TestUser | null, orderId: string) => call(notPickedUpRoute, user, "POST", `/api/operations/orders/${orderId}/not-picked-up`, { key: randomUUID(), reason: "Família avisou que não virá" }, orderId);
const resolve = (user: TestUser | null, orderId: string, b: Record<string, unknown> = {}) =>
  call(resolveRoute, user, "POST", `/api/operations/orders/${orderId}/resolve`, { key: randomUUID(), resolution: "cancel_refund", reason: "Política da escola: reembolso", ...b }, orderId);

async function snapshot(studentId: string, productIds: string[], date = BASE) {
  const wallet = await doc(`wallets/${studentId}`);
  const entries = (await db().collection(`wallets/${studentId}/entries`).get()).size;
  const usage = Number((await doc(`studentUsage/${studentId}/days/${date}`))?.committedCents ?? 0);
  const weekStart = school.weekStartOf(date);
  const week = Number((await doc(`studentUsage/${studentId}/weeks/${weekStart}`))?.committedCents ?? 0);
  const stock: Record<string, { onHand: number; reserved: number; reservations: string[]; movements: number; valueMicros: number }> = {};
  for (const id of productIds) {
    const balance = await doc(`stockBalances/${id}`);
    stock[id] = {
      onHand: Number(balance?.onHand ?? 0),
      reserved: Object.values((balance?.reservedByDate ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0),
      reservations: (await db().collection(`stockBalances/${id}/reservations`).get()).docs.map((x) => `${x.id}:${x.get("status")}:${x.get("deliveredQty")}/${x.get("releasedQty")}`),
      movements: (await db().collection(`stockCosts/${id}/movements`).get()).size,
      valueMicros: Number((await doc(`stockCosts/${id}`))?.valueMicros ?? 0),
    };
  }
  return { balanceCents: Number(wallet?.balanceCents ?? 0), version: Number(wallet?.version ?? 0), entries, usage, week, stock };
}
async function expectLedger(studentId: string) {
  const wallet = parseWalletState(await doc(`wallets/${studentId}`));
  const rows = (await db().collection(`wallets/${studentId}/entries`).orderBy("seq").get()).docs.map((x) => x.data() as { seq: number; amountCents: number; balanceAfterCents: number });
  expect(checkLedger(wallet, rows)).toEqual([]);
}
async function expectStock(productId: string) {
  const r = await call(reconcileRoute, admin, "GET", `/api/inventory/reconcile?productId=${productId}`);
  expect((r.body.products as { problems: string[] }[])[0]!.problems).toEqual([]);
}
const refunds = async (studentId: string) => (await db().collection(`wallets/${studentId}/entries`).where("type", "==", "order_refund").get()).docs.map((x) => x.data());
const cancellationsOf = async (orderId: string) => (await db().collection(`orders/${orderId}/cancellations`).get()).docs.map((x) => x.data());
const exits = async (productId: string) => (await db().collection(`stockCosts/${productId}/movements`).where("type", "==", "sale_exit").get()).docs.map((x) => x.data());
const losses = async (productId: string) => (await db().collection(`stockCosts/${productId}/movements`).where("type", "==", "loss").get()).docs.map((x) => x.data());

/** Conservação do dinheiro de UM pedido: receita das entregas + reembolsos + (retido) = total pago; nunca mais que o pago. */
async function moneyOf(orderId: string, productIds: string[]) {
  const order = (await doc(`orders/${orderId}`))!;
  let revenue = 0;
  for (const p of productIds) revenue += (await exits(p)).filter((m) => m.referenceId === orderId).reduce((n, m) => n + Number(m.revenueCents ?? 0), 0);
  return { total: Number(order.totalCents), refunded: Number(order.refundedCents ?? 0), revenue };
}

/* ------------------------------------------------------------------------------------------------ total */

describe("cancelamento total pelo responsável: tudo na mesma transação (A13/A16/A22)", () => {
  it("reembolsa o valor PAGO à carteira do aluno, libera reserva e uso, sem entrada física, e audita", async () => {
    const a = await newProduct({ price: 600, stock: 50 });
    const b = await newProduct({ price: 250, stock: 50 });
    const { student, orderId } = await placeOrder([{ productId: a, quantity: 2 }, { productId: b }]);
    const before = await snapshot(student, [a, b]);
    expect(before.stock[a]).toMatchObject({ reserved: 2 });
    expect(before.usage).toBe(1450);

    const key = randomUUID();
    const payload = { key, reason: "Mudança de planos da família" };
    const r = await viaCommand(() => cancelOrder(db(), actorOf(guardianA), { ...payload, orderId }, () => NOW));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, kind: "family", status: "cancelled", refundCents: 1450, canceledUnits: 3, remainingUnits: 0, wallet: { studentId: student, balanceCents: before.balanceCents + 1450, version: before.version + 1 } });
    expect(JSON.stringify(r.body)).not.toMatch(/cost|Cost|micros|movement/i);

    const after = await snapshot(student, [a, b]);
    // Dinheiro: crédito único na carteira ORIGINAL, UM lançamento imutável no livro, livro reconcilia.
    expect([after.balanceCents, after.version, after.entries]).toEqual([before.balanceCents + 1450, before.version + 1, before.entries + 1]);
    expect(await refunds(student)).toEqual([expect.objectContaining({ type: "order_refund", amountCents: 1450, orderId, seq: after.version, balanceAfterCents: after.balanceCents, actorUid: guardianA.uid })]);
    await expectLedger(student);
    // Disponibilidade: reserva liberada, SEM entrada física (onHand e movimentos intactos).
    for (const p of [a, b]) expect(after.stock[p]).toMatchObject({ onHand: before.stock[p]!.onHand, reserved: 0, movements: before.stock[p]!.movements, valueMicros: before.stock[p]!.valueMicros });
    expect(after.stock[a]!.reservations.some((x) => x.includes(":released:0/2") || x.includes(":cancelled:0/2") || x.endsWith("0/2"))).toBe(true);
    // Uso da F09 (data do CONSUMO) volta a zero.
    expect([after.usage, after.week]).toEqual([0, 0]);
    // Pedido, evento imutável e auditoria.
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "cancelled", canceledQty: 3, refundedCents: 1450, cancelCount: 1, version: 2 });
    expect((await itemsOf(orderId)).map((i) => i.canceledQty)).toEqual([2, 1]);
    expect(await cancellationsOf(orderId)).toEqual([expect.objectContaining({ orderId, studentId: student, kind: "family", refundCents: 1450, canceledUnits: 3, reason: payload.reason, actorUid: guardianA.uid, walletSeq: after.version })]);
    expect(await doc(`auditLog/${guardianA.uid}__orders.cancel__${key}`)).toMatchObject({ action: "orders.cancel", reason: payload.reason, target: { type: "order", id: orderId }, after: { status: "cancelled", refundCents: 1450, kind: "family" } });
    await expectStock(a);
    await expectStock(b);
  });

  it("A16: o preço atual do produto não entra — pedido comprado a R$ 8 devolve R$ 8 mesmo com o cadastro em R$ 9", async () => {
    const p = await newProduct({ price: 800, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    await db().doc(`products/${p}`).update({ priceCents: 900, priceVersion: 2 });
    const r = await cancelAs(guardianA, "guardian", orderId);
    expect(r.body).toMatchObject({ refundCents: 1600 });
    expect((await refunds(student)).map((x) => x.amountCents)).toEqual([1600]);
  });

  it("o cliente não define o valor: campos de valor/preço no corpo são recusados e nada muda", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    const before = await snapshot(student, [p]);
    for (const extra of [{ refundCents: 99999 }, { amountCents: 1 }, { studentId: "outro" }, { priceCents: 1 }]) {
      const r = await call(cancelRoute, guardianA, "POST", `/api/orders/${orderId}/cancel`, { ...body({}), ...extra }, orderId);
      expect(r.status).toBe(400);
    }
    expect(await snapshot(student, [p])).toEqual(before);
  });
});

/* ---------------------------------------------------------------------------------------------- parcial */

describe("cancelamento parcial e teto do reembolso (A22)", () => {
  it("cancela parte do item: valor proporcional, restante segue o fluxo, entrega depois conserva dinheiro/unidades/custo", async () => {
    const p = await newProduct({ price: 400, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    const start = await snapshot(student, [p]);

    const r = await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 1 }] });
    expect(r.body).toMatchObject({ status: "paid", refundCents: 400, canceledUnits: 1, remainingUnits: 2, items: [{ lineNo: 1, quantity: 3, deliveredQty: 0, remainingQty: 2 }] });
    expect(await snapshot(student, [p])).toMatchObject({ balanceCents: start.balanceCents + 400, usage: 800, stock: { [p]: { onHand: 30, reserved: 2 } } });

    // O que sobrou é entregue normalmente (receita só das 2 unidades) e o resto não pode mais ser cancelado.
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }])).body).toMatchObject({ status: "delivered", remainingUnits: 0 });
    const money = await moneyOf(orderId, [p]);
    expect(money).toEqual({ total: 1200, refunded: 400, revenue: 800 });
    expect(money.refunded + money.revenue).toBe(money.total);
    expect((await cancelAs(guardianA, "guardian", orderId)).body.error).toBe("already_delivered");
    const end = await snapshot(student, [p]);
    expect(end).toMatchObject({ balanceCents: start.balanceCents + 400, usage: 800, stock: { [p]: { onHand: 28, reserved: 0 } } });
    await expectLedger(student);
    await expectStock(p);
  });

  it("acumulado nunca passa do pago: cancela 1, depois 2 (resto), e qualquer nova tentativa é recusada sem crédito", async () => {
    const p = await newProduct({ price: 500, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    expect((await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 1 }] })).body.refundCents).toBe(500);
    expect((await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 3 }] })).body).toMatchObject({ error: "quantity_exceeds_remaining", details: { remaining: 2, requested: 3 } });
    expect((await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 9, quantity: 1 }] })).body.error).toBe("line_not_found");
    expect((await cancelAs(guardianA, "guardian", orderId)).body).toMatchObject({ status: "cancelled", refundCents: 1000 });
    expect((await cancelAs(guardianA, "guardian", orderId)).body.error).toBe("already_cancelled");
    expect((await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 1 }] })).body.error).toBe("already_cancelled");
    expect(await doc(`orders/${orderId}`)).toMatchObject({ refundedCents: 1500, canceledQty: 3, cancelCount: 2 });
    expect((await refunds(student)).map((x) => x.amountCents).sort()).toEqual([1000, 500]);
    expect((await snapshot(student, [p])).usage).toBe(0);
    await expectLedger(student);
  });

  it("centavos preservados no rateio: valor pago fracionado por unidade (333 + 334 + 333 = 1000)", async () => {
    const p = await newProduct({ price: 500, stock: 30 });
    const { orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    // Fixture do EMULADOR: subtotal efetivamente pago que não divide por 3 (como um desconto rateado), mantendo total e livro coerentes.
    await db().doc(`orders/${orderId}`).update({ items: (await itemsOf(orderId)).map((i) => ({ ...i, subtotalCents: 1000 })), totalCents: 1000 });
    const amounts: number[] = [];
    for (let i = 0; i < 3; i++) amounts.push(Number((await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 1 }] })).body.refundCents));
    expect(amounts).toEqual([333, 334, 333]);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ refundedCents: 1000, status: "cancelled" });
  });

  it("cancelar um item e entregar o outro: pedido entregue, só o item cancelado volta, uso conserva o entregue", async () => {
    const a = await newProduct({ price: 300, stock: 20 });
    const b = await newProduct({ price: 700, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: a }, { productId: b }]);
    expect((await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: await lineOf(orderId, b), quantity: 1 }] })).body).toMatchObject({ refundCents: 700, status: "paid" });
    expect((await deliver(cantina, orderId, student, [{ lineNo: await lineOf(orderId, a), quantity: 1 }])).body.status).toBe("delivered");
    expect(await moneyOf(orderId, [a, b])).toEqual({ total: 1000, refunded: 700, revenue: 300 });
    expect((await snapshot(student, [a, b])).usage).toBe(300);
  });
});

/* ------------------------------------------------------------------------------------------ prazo e papéis */

describe("prazo do pedido e autorização (A13)", () => {
  it("limite exato: um instante antes cancela; exatamente no limite (agora >= limite) a família é recusada sem efeito", async () => {
    const p = await newProduct({ stock: 30 });
    const early = await placeOrder([{ productId: p }]);
    const cutoff = await cutoffOf(early.orderId);
    const ok = await cancelAs(guardianA, "guardian", early.orderId, {}, () => new Date(cutoff.getTime() - 1));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const late = await placeOrder([{ productId: p }]);
    const before = await snapshot(late.student, [p]);
    for (const offset of [0, 1, 3_600_000]) {
      const r = await cancelAs(guardianA, "guardian", late.orderId, {}, () => new Date(cutoff.getTime() + offset));
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("cancel_deadline_passed");
    }
    expect(await snapshot(late.student, [p])).toEqual(before);
    expect(await doc(`orders/${late.orderId}`)).toMatchObject({ status: "paid", version: 1 });
    expect(await cancellationsOf(late.orderId)).toHaveLength(0);
  });

  it("o prazo é o SALVO no pedido: alterar o horário depois não muda o que a família vê (a decisão usa o snapshot)", async () => {
    const p = await newProduct({ stock: 30 });
    const { orderId } = await placeOrder([{ productId: p }]);
    const cutoff = await cutoffOf(orderId);
    // Mesmo que o calendário/horários mudassem agora, o comando só lê `policy.cancelCutoffAt` do pedido: prova pela troca do snapshot.
    await db().doc(`orders/${orderId}`).update({ "policy.cancelCutoffAt": new Date(cutoff.getTime() - 7_200_000) });
    expect((await cancelAs(guardianA, "guardian", orderId, {}, () => new Date(cutoff.getTime() - 60_000))).body.error).toBe("cancel_deadline_passed");
    await db().doc(`orders/${orderId}`).update({ "policy.cancelCutoffAt": cutoff });
    expect((await cancelAs(guardianA, "guardian", orderId, {}, () => new Date(cutoff.getTime() - 60_000))).status).toBe(200);
  });

  it("depois do prazo só a equipe autorizada cancela, com motivo, e a auditoria registra ator e papel", async () => {
    const p = await newProduct({ price: 450, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    const cutoff = await cutoffOf(orderId);
    const late = () => new Date(cutoff.getTime() + 3_600_000);
    expect((await cancelAs(guardianA, "guardian", orderId, {}, late)).body.error).toBe("cancel_deadline_passed");
    expect((await call(cancelRoute, cantina, "POST", `/api/orders/${orderId}/cancel`, { key: randomUUID() }, orderId)).status).toBe(400); // sem motivo
    expect((await call(cancelRoute, cantina, "POST", `/api/orders/${orderId}/cancel`, { key: randomUUID(), reason: "ok" }, orderId)).status).toBe(400);
    const key = randomUUID();
    const r = await viaCommand(() => cancelOrder(db(), actorOf(cantina, "cantina"), { key, orderId, reason: "Produto indisponível hoje" }, late));
    expect(r.body).toMatchObject({ kind: "operational", status: "cancelled", refundCents: 900 });
    expect(await doc(`auditLog/${cantina.uid}__orders.cancel__${key}`)).toMatchObject({ actorUid: cantina.uid, actorRole: "cantina", reason: "Produto indisponível hoje", after: { kind: "operational", refundCents: 900 } });
    expect((await refunds(student)).map((x) => x.actorUid)).toEqual([cantina.uid]);
  });

  it("aluno, secretaria, outra família e anônimo não cancelam; pedido inexistente e de outra família respondem igual (403)", async () => {
    const studentUser = await createTestUser("calu", "student");
    const p = await newProduct({ stock: 30 });
    const own = await newStudent();
    await writeDemoDoc(targetFromEnv(), `students/${own}`, { name: "Aluno Login", status: "active", userUid: studentUser.uid, shiftId: ST, classId: CLS, version: 3 });
    await writeDemoDoc(targetFromEnv(), `studentPolicies/${own}`, { allowSitePurchase: true, allowCounterPurchase: false, configVersion: 1 });
    const { student, orderId } = await placeOrder([{ productId: p }], { student: own, date: d(3) });
    const before = await snapshot(student, [p], d(3));
    expect((await cancelHttp(studentUser, orderId)).status).toBe(403); // aluno não cancela sozinho, mesmo podendo comprar
    expect((await cancelHttp(secretaria, orderId)).status).toBe(403);
    expect((await cancelHttp(guardianB, orderId)).status).toBe(403);
    expect((await cancelHttp(guardianB, `ord_inexistente_${tag}`)).status).toBe(403);
    expect((await cancelHttp(guardianA, `ord_inexistente_${tag}`)).status).toBe(403);
    expect((await cancelHttp(null, orderId)).status).toBe(401);
    expect(await snapshot(student, [p], d(3))).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "paid", version: 1 });
  });

  it("autorização REVOGADA: vínculo encerrado e perfil desativado/rebaixado negam, inclusive o replay da mesma chave", async () => {
    const p = await newProduct({ stock: 30 });
    const g2 = await createTestUser("crev-g", "guardian");
    const student = await newStudent();
    await seedStudentAccess({ studentId: student, name: "Aluno com 2 responsáveis", guardianUids: [guardianA.uid, g2.uid], allowSitePurchase: true });
    await writeDemoDoc(targetFromEnv(), `students/${student}`, { name: "Aluno com 2 responsáveis", status: "active", userUid: null, shiftId: ST, classId: CLS, version: 3 });
    const first = await placeOrder([{ productId: p, quantity: 2 }], { student, date: d(3) });
    const key = randomUUID();
    const send = (user: TestUser, k = key, lines?: { lineNo: number; quantity: number }[]) =>
      call(cancelRoute, user, "POST", `/api/orders/${first.orderId}/cancel`, { key: k, reason: "Mudança de planos da família", ...(lines ? { lines } : {}) }, first.orderId);
    expect((await send(g2, key, [{ lineNo: 1, quantity: 1 }])).status).toBe(200);

    await db().doc(`guardianStudentLinks/${g2.uid}_${student}`).update({ status: "revoked" });
    const before = await snapshot(student, [p], d(3));
    expect((await send(g2, randomUUID())).status).toBe(403);
    expect((await send(g2, key, [{ lineNo: 1, quantity: 1 }])).status).toBe(403); // replay reautoriza com o vínculo ATUAL
    expect(await snapshot(student, [p], d(3))).toEqual(before);

    const staff = await createTestUser("crev-s", "cantina");
    const second = await placeOrder([{ productId: p }], { student, date: d(3) });
    const k2 = randomUUID();
    const sendStaff = (k = k2) => call(cancelRoute, staff, "POST", `/api/orders/${second.orderId}/cancel`, { key: k, reason: "Cancelamento operacional" }, second.orderId);
    await db().doc(`users/${staff.uid}`).update({ status: "disabled" });
    expect((await sendStaff()).status).toBe(403);
    await db().doc(`users/${staff.uid}`).update({ status: "active", role: "guardian" }); // rebaixado: sem vínculo com o aluno
    expect((await sendStaff()).status).toBe(403);
    expect(await doc(`orders/${second.orderId}`)).toMatchObject({ status: "paid", version: 1 });
  });

  it("pedido sem prazo registrado: a família é recusada (prazo desconhecido) e a equipe ainda cancela", async () => {
    const p = await newProduct({ stock: 30 });
    const { orderId } = await placeOrder([{ productId: p }], { date: d(3) });
    await db().doc(`orders/${orderId}`).update({ policy: null });
    expect((await cancelAs(guardianA, "guardian", orderId)).body.error).toBe("cancel_deadline_unknown");
    expect((await cancelAs(cantina, "cantina", orderId)).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------------------- entregue/resolvido */

describe("não cancela o que já foi entregue, cancelado ou resolvido", () => {
  it("entregue por completo: recusado para família e equipe; parcialmente entregue: só o restante é cancelável", async () => {
    const p = await newProduct({ price: 500, stock: 30 });
    const done = await placeOrder([{ productId: p }]);
    await deliver(cantina, done.orderId, done.student, [{ lineNo: 1, quantity: 1 }]);
    const before = await snapshot(done.student, [p]);
    expect((await cancelAs(guardianA, "guardian", done.orderId)).body.error).toBe("already_delivered");
    expect((await cancelAs(admin, "admin", done.orderId)).body.error).toBe("already_delivered");
    expect(await snapshot(done.student, [p])).toEqual(before);

    const part = await placeOrder([{ productId: p, quantity: 3 }]);
    await deliver(cantina, part.orderId, part.student, [{ lineNo: 1, quantity: 1 }]);
    expect((await cancelAs(guardianA, "guardian", part.orderId, { lines: [{ lineNo: 1, quantity: 3 }] })).body).toMatchObject({ error: "quantity_exceeds_remaining", details: { remaining: 2 } });
    const r = await cancelAs(guardianA, "guardian", part.orderId);
    expect(r.body).toMatchObject({ status: "delivered", refundCents: 1000, remainingUnits: 0 }); // o entregue (R$ 5,00) não volta
    expect(await moneyOf(part.orderId, [p])).toEqual({ total: 1500, refunded: 1000, revenue: 500 });
    expect((await doc(`orders/${part.orderId}`))!.deliveredAt).toBeTruthy(); // virou "entregue" por cancelamento do restante: mesmo carimbo da entrega completa
  });

  it("semântica de `deliveredAt` (F15): cancelamento SEM entrega física nunca vira entrega (pedido, recibo, linha do tempo); cancelar o restante usa o instante da última entrega", async () => {
    const p = await newProduct({ price: 500, stock: 30 });
    // 1. Cancelamento total, nada entregue: situação "cancelled", sem `deliveredAt`, sem entrega no recibo.
    const none = await placeOrder([{ productId: p, quantity: 2 }]);
    expect((await cancelAs(guardianA, "guardian", none.orderId)).body).toMatchObject({ status: "cancelled", refundCents: 1000 });
    const cancelled = (await doc(`orders/${none.orderId}`))!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.deliveredAt).toBeUndefined();
    expect(Number(cancelled.deliveredQty ?? 0)).toBe(0);
    expect((await db().collection(`orders/${none.orderId}/deliveries`).get()).size).toBe(0);
    const receipt = await call(detailRoute, guardianA, "GET", `/api/orders/${none.orderId}`, undefined, none.orderId);
    expect(receipt.body).toMatchObject({ status: "cancelled", group: "cancelled", deliveries: [] });
    expect((receipt.body.timeline as { kind: string }[]).some((t) => t.kind === "delivery")).toBe(false);
    expect((receipt.body.items as { deliveredQty: number }[]).every((i) => i.deliveredQty === 0)).toBe(true);
    const completed = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${none.student}&group=completed`);
    expect((completed.body.orders as unknown[]).length).toBe(0);

    // 2. Cancelamento parcial sem entrega e depois do restante: continua sem entrega.
    const split = await placeOrder([{ productId: p, quantity: 3 }]);
    await cancelAs(guardianA, "guardian", split.orderId, { lines: [{ lineNo: 1, quantity: 1 }] });
    expect((await doc(`orders/${split.orderId}`))!.deliveredAt).toBeUndefined();
    await cancelAs(guardianA, "guardian", split.orderId);
    expect(await doc(`orders/${split.orderId}`)).toMatchObject({ status: "cancelled" });
    expect((await doc(`orders/${split.orderId}`))!.deliveredAt).toBeUndefined();

    // 3. Entrega parcial + cancelamento do restante: ENTREGUE, com o instante da última entrega (não o do cancelamento).
    const part = await placeOrder([{ productId: p, quantity: 3 }]);
    const d = await deliver(cantina, part.orderId, part.student, [{ lineNo: 1, quantity: 1 }]);
    expect(d.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 25)); // instantes de servidor distintos
    expect((await cancelAs(guardianA, "guardian", part.orderId)).body).toMatchObject({ status: "delivered" });
    const delivery = (await db().collection(`orders/${part.orderId}/deliveries`).get()).docs[0]!;
    const stamped = (await doc(`orders/${part.orderId}`))!.deliveredAt as { toMillis(): number };
    expect(stamped.toMillis()).toBe((delivery.get("createdAt") as { toMillis(): number }).toMillis());
  });

  it("pedido de data PASSADA e sem entrega: a cantina não cancela direto (marca não retirado); a administração cancela e a família também fica de fora", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    // Fixture do EMULADOR: o dia do consumo já passou e o uso comprometido (F09) acompanha a data.
    await db().doc(`orders/${orderId}`).update({ consumptionDate: d(-1) });
    await db().doc(`studentUsage/${student}/days/${d(-1)}`).set({ studentId: student, date: d(-1), committedCents: 500, version: 1 });
    await db().doc(`studentUsage/${student}/weeks/${school.weekStartOf(d(-1))}`).set({ studentId: student, weekStart: school.weekStartOf(d(-1)), committedCents: 500, version: 1 });
    const before = await snapshot(student, [p], d(-1));
    expect((await cancelAs(cantina, "cantina", orderId)).body).toMatchObject({ error: "past_date_requires_resolution" });
    expect(await snapshot(student, [p], d(-1))).toEqual(before);
    expect((await cancelAs(admin, "admin", orderId)).status).toBe(200);
    expect((await refunds(student)).length).toBe(1);
  });

  it("linha de valor pago ZERO (desconto total): cancela e libera reserva/uso sem lançamento nem mudança de saldo", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p }], { date: d(3) });
    await db().doc(`orders/${orderId}`).update({ items: (await itemsOf(orderId)).map((i) => ({ ...i, subtotalCents: 0 })), totalCents: 0 }); // fixture do emulador
    const before = await snapshot(student, [p], d(3));
    const r = await cancelAs(guardianA, "guardian", orderId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "cancelled", refundCents: 0, wallet: { entryId: null, balanceCents: before.balanceCents, version: before.version } });
    const after = await snapshot(student, [p], d(3));
    expect([after.balanceCents, after.version, after.entries]).toEqual([before.balanceCents, before.version, before.entries]);
    expect(after).toMatchObject({ usage: 0, stock: { [p]: { reserved: 0 } } });
    expect(await refunds(student)).toHaveLength(0);
  });

  it("não retirado pendente ou resolvido não se cancela pelo comando comum (a administração resolve)", async () => {
    const p = await newProduct({ stock: 30 });
    const a = await placeOrder([{ productId: p }]);
    await notPickedUp(cantina, a.orderId);
    const r = await cancelAs(admin, "admin", a.orderId);
    expect(r.body).toMatchObject({ error: "use_resolution" });
    expect((await cancelAs(guardianA, "guardian", a.orderId)).body.error).toBe("use_resolution");
    expect((await resolve(admin, a.orderId, { resolution: "close_charged", reason: "Cobrança mantida pela política" })).status).toBe(200);
    expect((await cancelAs(admin, "admin", a.orderId)).body.error).toBe("already_resolved");
    expect((await refunds(a.student)).length).toBe(0);
  });
});

/* ---------------------------------------------------------------------------- estoque, cota e descarte */

describe("disponibilidade física × dinheiro: liberar reserva não é entrada; descarte é perda explícita", () => {
  it("equipe cancela e DESCARTA parte: reembolso integral, perda só das unidades listadas com custo e motivo, sem entrada fictícia", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    const before = await snapshot(student, [p]);
    expect((await cancelAs(admin, "admin", orderId, { discards: [{ lineNo: 1, quantity: 4 }] })).body.error).toBe("discard_exceeds_canceled");
    expect((await cancelAs(admin, "admin", orderId, { lines: [{ lineNo: 1, quantity: 2 }], discards: [{ lineNo: 1, quantity: 3 }] })).body.error).toBe("discard_exceeds_canceled");
    expect(await snapshot(student, [p])).toEqual(before);

    const r = await cancelAs(admin, "admin", orderId, { discards: [{ lineNo: 1, quantity: 2 }], reason: "Preparado e estragado" });
    expect(r.body).toMatchObject({ status: "cancelled", refundCents: 1500, discardedUnits: 2, shortfallUnits: 0 });
    const after = await snapshot(student, [p]);
    expect(after).toMatchObject({ balanceCents: before.balanceCents + 1500, stock: { [p]: { onHand: 8, reserved: 0 } } });
    const [loss] = await losses(p);
    expect(loss).toMatchObject({ type: "loss", quantity: -2, reasonCode: "discard", referenceType: "order", referenceId: orderId });
    expect(String(loss!.reason)).toContain("Preparado e estragado");
    expect(Math.abs(Number(loss!.totalCostMicros))).toBe(2 * Math.abs(Number(loss!.unitCostMicros)));
    expect(after.stock[p]!.movements).toBe(before.stock[p]!.movements + 1); // só a perda; nenhuma entrada
    expect(await cancellationsOf(orderId)).toEqual([expect.objectContaining({ discards: [expect.objectContaining({ quantity: 2 })] })]);
    await expectStock(p);
  });

  it("família não descarta; cantina descarta (tem permissão de perda); sem descarte a unidade apenas volta à disponibilidade", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { orderId } = await placeOrder([{ productId: p }], { date: d(3) });
    expect((await cancelAs(guardianA, "guardian", orderId, { discards: [{ lineNo: 1, quantity: 1 }] })).status).toBe(403);
    const clean = await placeOrder([{ productId: p }], { date: d(3) });
    const r = await cancelAs(cantina, "cantina", clean.orderId);
    expect(r.body).toMatchObject({ discardedUnits: 0 });
    expect((await losses(p)).length).toBe(0);
  });

  it("produto planejado: a cota reservada é liberada no cancelamento (sem entrada física)", async () => {
    const p = await newProduct({ mode: "planned", price: 700, capacity: { [`${d(3)}@${ST}`]: 5 } });
    const capId = `${p}_${d(3)}_${ST}`;
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }], { date: d(3) });
    expect(await doc(`dailyCapacity/${capId}`)).toMatchObject({ reserved: 3 });
    const r = await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 2 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await doc(`dailyCapacity/${capId}`)).toMatchObject({ reserved: 1 });
    expect((await snapshot(student, [p], d(3))).stock[p]).toMatchObject({ onHand: 0, movements: 0 });
    expect((await cancelAs(guardianA, "guardian", orderId)).status).toBe(200);
    expect(await doc(`dailyCapacity/${capId}`)).toMatchObject({ reserved: 0 });
  });

  it("descarte que deixa OUTRO pedido sem lastro físico avisa (shortfall e pedidos afetados) e audita, como na resolução da F13", async () => {
    const p = await newProduct({ price: 500, stock: 3 });
    const x = await placeOrder([{ productId: p, quantity: 1 }], { date: d(1) });
    const y = await placeOrder([{ productId: p, quantity: 2 }], { date: d(2) });
    const loss = await call(lossesRoute, cantina, "POST", "/api/inventory/losses", { key: randomUUID(), productId: p, quantity: 1, reason: "breakage", note: "Quebra de uma unidade" }); // 2 em mãos para 3 reservadas
    expect(loss.status, JSON.stringify(loss.body)).toBe(200);
    const key = randomUUID();
    const r = await viaCommand(() => cancelOrder(db(), actorOf(admin, "admin"), { key, orderId: x.orderId, reason: "Descarte após cancelamento", discards: [{ lineNo: 1, quantity: 1 }] }, () => NOW));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "cancelled", refundCents: 500, discardedUnits: 1, shortfallUnits: 1, affectedOrders: [y.orderId] });
    expect(await doc(`auditLog/${admin.uid}__orders.cancel__${key}`)).toMatchObject({ after: { shortfallUnits: 1, affectedOrders: [y.orderId] } });
  });
});

/* -------------------------------------------------------------------------------- aluno arquivado */

describe("aluno arquivado: a carteira original recebe o reembolso e o cadastro NÃO é reativado", () => {
  it("responsável vinculado e equipe cancelam; crédito na carteira do aluno; status e versão do cadastro intactos; auditoria guarda o status", async () => {
    const p = await newProduct({ price: 600, stock: 30 });
    const a = await placeOrder([{ productId: p }], { date: d(3) });
    const b = await placeOrder([{ productId: p, quantity: 2 }], { date: d(3) });
    await db().doc(`students/${a.student}`).update({ status: "archived" });
    await db().doc(`students/${b.student}`).update({ status: "archived" });
    const studentBefore = await doc(`students/${a.student}`);
    const walletBefore = await doc(`wallets/${a.student}`);

    const key = randomUUID();
    const r = await viaCommand(() => cancelOrder(db(), actorOf(guardianA), { key, orderId: a.orderId, reason: "Aluno saiu da escola" }, () => NOW));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "cancelled", refundCents: 600, wallet: { studentId: a.student } });
    expect(Number((await doc(`wallets/${a.student}`))!.balanceCents)).toBe(Number(walletBefore!.balanceCents) + 600);
    expect(await doc(`students/${a.student}`)).toEqual(studentBefore); // nada reativado nem alterado
    expect(await doc(`auditLog/${guardianA.uid}__orders.cancel__${key}`)).toMatchObject({ after: { studentStatus: "archived", studentId: a.student } });
    expect(await cancellationsOf(a.orderId)).toEqual([expect.objectContaining({ studentStatus: "archived" })]);
    await expectLedger(a.student);

    // A equipe também cancela; a carteira do aluno arquivado segue sendo a original (outro aluno nunca recebe).
    const s = await cancelAs(admin, "admin", b.orderId);
    expect(s.body).toMatchObject({ refundCents: 1200, wallet: { studentId: b.student } });
    expect((await doc(`students/${b.student}`))!.status).toBe("archived");
    expect(await refunds(a.student)).toHaveLength(1);
    expect(await refunds(b.student)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------------------ idempotência */

describe("replay, resposta perdida, payload diferente e falha intermediária (A35)", () => {
  it("mesma chave devolve a resposta original sem novo crédito; payload diferente com a mesma chave conflita", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }], { date: d(3) });
    const key = randomUUID();
    const send = (extra: object = {}) => call(cancelRoute, guardianA, "POST", `/api/orders/${orderId}/cancel`, { key, reason: "Mudança de planos da família", lines: [{ lineNo: 1, quantity: 1 }], ...extra }, orderId);
    const first = await send();
    const again = await send(); // "resposta perdida": o cliente repete o MESMO envio
    expect(first.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, cancellationId: first.body.cancellationId, refundCents: 500 });
    expect((await send({ lines: [{ lineNo: 1, quantity: 2 }] })).body.error).toBe("idempotency_conflict");
    expect((await refunds(student)).length).toBe(1);
    expect((await cancellationsOf(orderId)).length).toBe(1);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ canceledQty: 1, refundedCents: 500, version: 2 });
    await expectLedger(student);
  });

  it("clique duplo com chaves DIFERENTES sobre o mesmo restante: um crédito só", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p }], { date: d(3) });
    expect((await cancelAs(guardianA, "guardian", orderId)).status).toBe(200);
    expect((await cancelAs(guardianA, "guardian", orderId)).body.error).toBe("already_cancelled");
    expect((await refunds(student)).length).toBe(1);
  });

  it("falha no ÚLTIMO passo (auditoria) depois de planejar tudo: nada persiste; o retry com a mesma chave credita uma só vez", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }], { date: d(3) });
    const key = randomUUID();
    const auditId = `${guardianA.uid}__orders.cancel__${key}`;
    await db().doc(`auditLog/${auditId}`).set({ action: "bloqueio-de-teste" });
    const before = await snapshot(student, [p], d(3));
    const payload = { key, orderId, reason: "Mudança de planos da família" };
    const failed = await viaCommand(() => cancelOrder(db(), actorOf(guardianA), payload, () => NOW));
    expect(failed.status).toBe(500);
    expect(await snapshot(student, [p], d(3))).toEqual(before); // carteira, livro, reserva, cota e uso intactos
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "paid", version: 1 });
    expect(await cancellationsOf(orderId)).toHaveLength(0);
    expect(await doc(`idempotencyRecords/${guardianA.uid}__orders.cancel__${key}`)).toBeUndefined();

    await db().doc(`auditLog/${auditId}`).delete();
    const retry = await viaCommand(() => cancelOrder(db(), actorOf(guardianA), payload, () => NOW));
    expect(retry.status).toBe(200);
    expect((await refunds(student)).length).toBe(1);
    expect(await snapshot(student, [p], d(3))).toMatchObject({ balanceCents: before.balanceCents + 1000, usage: 0, stock: { [p]: { reserved: 0 } } });
  });

  it("falha intermediária por ESTOQUE (descarte sem unidade física): a transação inteira é desfeita, inclusive o crédito", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }], { date: d(3) });
    await db().doc(`stockBalances/${p}`).update({ onHand: 0 }); // some o físico (perda externa): descartar 2 é impossível
    const before = await snapshot(student, [p], d(3));
    const r = await cancelAs(admin, "admin", orderId, { discards: [{ lineNo: 1, quantity: 2 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("insufficient_stock");
    expect(await snapshot(student, [p], d(3))).toEqual(before);
    expect((await doc(`orders/${orderId}`))!.canceledQty).toBeUndefined();
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "paid", version: 1 });
  });
});

/* ---------------------------------------------------------------------------------------- corridas */

describe("corridas: entrega × cancelamento, dois cancelamentos, resolução × cancelamento (A23)", () => {
  it("ENTREGA × CANCELAMENTO da última unidade (8 pedidos, ambos ao mesmo tempo): nunca entregue COM estorno, nunca crédito duplicado", async () => {
    // Um produto por pedido: a corrida é por PEDIDO (entrega × cancelamento); produtos separados evitam concentrar 16 escritores num só documento de estoque.
    const products = await Promise.all(Array.from({ length: 8 }, () => newProduct({ price: 500, stock: 10 })));
    const orders = await Promise.all(products.map((product) => placeOrder([{ productId: product }])));
    const results = await Promise.all(
      orders.flatMap((o, i) => [
        i % 2 === 0 ? deliver(cantina, o.orderId, o.student, [{ lineNo: 1, quantity: 1 }]) : cancelAs(guardianA, "guardian", o.orderId),
        i % 2 === 0 ? cancelAs(guardianA, "guardian", o.orderId) : deliver(cantina, o.orderId, o.student, [{ lineNo: 1, quantity: 1 }]),
      ]),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(orders.length); // exatamente um comando vence por pedido
    for (const o of orders) {
      const order = (await doc(`orders/${o.orderId}`))!;
      const refunded = (await refunds(o.student)).length;
      const delivered = (await exits(products[orders.indexOf(o)]!)).filter((m) => m.referenceId === o.orderId).length;
      expect([order.status, refunded, delivered]).toSatisfy(([s, r, e]: [string, number, number]) => (s === "delivered" && r === 0 && e === 1) || (s === "cancelled" && r === 1 && e === 0));
      const snap = await snapshot(o.student, [products[orders.indexOf(o)]!]);
      expect(snap.balanceCents).toBe(50000 - 500 + (order.status === "cancelled" ? 500 : 0));
      expect(snap.usage).toBe(order.status === "cancelled" ? 0 : 500);
      await expectLedger(o.student);
    }
    for (const product of products) await expectStock(product);
  });

  it("ENTREGA PARCIAL × CANCELAMENTO do restante: cancelar 2 e entregar 2 de 3 — soma nunca passa de 3 e o dinheiro conserva", async () => {
    const p = await newProduct({ price: 400, stock: 40 });
    for (let round = 0; round < 4; round++) {
      const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
      const results = await Promise.all([cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 2 }] }), deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }])]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const order = (await doc(`orders/${orderId}`))!;
      const item = (order.items as Item[])[0]!;
      expect((item.deliveredQty ?? 0) + (item.canceledQty ?? 0)).toBe(2);
      const money = await moneyOf(orderId, [p]);
      expect(money.revenue + money.refunded).toBe(800); // 2 unidades liquidadas; 1 continua reservada e paga
      expect((await snapshot(student, [p])).stock[p]).toMatchObject({ reserved: expect.any(Number) });
      await expectLedger(student);
    }
    await expectStock(p);
  });

  it("DOIS CANCELAMENTOS simultâneos (família ×2 com chaves diferentes + equipe): exatamente um crédito", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }], { date: d(3) });
    const results = await Promise.all([cancelAs(guardianA, "guardian", orderId), cancelAs(guardianA, "guardian", orderId), cancelAs(cantina, "cantina", orderId), cancelAs(admin, "admin", orderId)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(["already_cancelled", "quantity_exceeds_remaining"]).toContain(r.body.error);
    expect(await refunds(student)).toHaveLength(1);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ refundedCents: 1000, canceledQty: 2, status: "cancelled" });
    expect(await snapshot(student, [p], d(3))).toMatchObject({ balanceCents: 50000, usage: 0, stock: { [p]: { reserved: 0 } } });
    await expectLedger(student);
  });

  it("6 cancelamentos parciais de 1 unidade sobre um pedido de 3: três vencem, o acumulado nunca passa do pago", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }], { date: d(3) });
    const results = await Promise.all(Array.from({ length: 6 }, () => cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 1 }] })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ refundedCents: 1500, canceledQty: 3, status: "cancelled" });
    expect((await refunds(student)).map((x) => x.amountCents)).toEqual([500, 500, 500]);
    expect((await snapshot(student, [p], d(3))).balanceCents).toBe(50000);
    await expectLedger(student);
  });

  it("MESMA chave ×6 ao mesmo tempo: um crédito, as demais respostas iguais ou replay", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }], { date: d(3) });
    const payload = { key: randomUUID(), orderId, reason: "Mudança de planos da família" };
    const results = await Promise.all(Array.from({ length: 6 }, () => viaCommand(() => cancelOrder(db(), actorOf(guardianA), payload, () => NOW))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.cancellationId)).size).toBe(1);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect(await refunds(student)).toHaveLength(1);
    await expectLedger(student);
  });

  it("RESOLUÇÃO de não retirado × CANCELAMENTO (e × marcar não retirado): uma só liquidação, sem crédito duplicado nem cobrança retida junto", async () => {
    const p = await newProduct({ price: 500, stock: 30 });
    // (a) pedido marcado: resolver (cancel_refund) × cancelar pela equipe × resolver de novo.
    const a = await placeOrder([{ productId: p, quantity: 2 }]);
    expect((await notPickedUp(cantina, a.orderId)).status).toBe(200);
    const raced = await Promise.all([resolve(admin, a.orderId), cancelAs(cantina, "cantina", a.orderId), resolve(admin, a.orderId), cancelAs(guardianA, "guardian", a.orderId)]);
    expect(raced.filter((r) => r.status === 200)).toHaveLength(1);
    expect(raced.find((r) => r.status === 200)!.body).toMatchObject({ resolution: "cancel_refund", refundCents: 1000 });
    expect(await refunds(a.student)).toHaveLength(1);
    expect(await doc(`orders/${a.orderId}`)).toMatchObject({ status: "cancelled", refundedCents: 1000 });
    expect((await doc(`orders/${a.orderId}`))!.nonPickup.resolution).toMatchObject({ kind: "cancel_refund" });

    // (b) cancelar × MARCAR como não retirado: ou cancela (e a marcação é recusada) ou marca (e o cancelamento exige resolução).
    for (let round = 0; round < 4; round++) {
      const b = await placeOrder([{ productId: p }]);
      const [mark, cancel] = await Promise.all([notPickedUp(cantina, b.orderId), cancelAs(cantina, "cantina", b.orderId)]);
      const status = (await doc(`orders/${b.orderId}`))!.status;
      if (status === "cancelled") {
        expect([mark.status, cancel.status]).toEqual([409, 200]);
        expect(await refunds(b.student)).toHaveLength(1);
      } else {
        expect([status, mark.status, cancel.status]).toEqual(["not_picked_up", 200, 409]);
        expect(cancel.body.error).toBe("use_resolution");
        expect(await refunds(b.student)).toHaveLength(0);
      }
      await expectLedger(b.student);
    }
    await expectStock(p);
  });
});

/* ------------------------------------------------------------------------- resolução cancel_refund (F13) */

describe("resolução 'cancelar e reembolsar' de não retirado (integra F13 × F14)", () => {
  it("restante não retirado volta à carteira original (o entregue fica), libera reserva/uso, classifica e audita", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }]);
    await notPickedUp(cantina, orderId);
    const before = await snapshot(student, [p]);
    expect(before).toMatchObject({ usage: 1500, stock: { [p]: { onHand: 19, reserved: 2 } } });
    expect((await resolve(cantina, orderId)).status).toBe(403);
    expect((await resolve(admin, orderId, { reason: "x" })).status).toBe(400);
    expect((await resolve(admin, orderId, { resolution: "reschedule" })).body).toMatchObject({ error: "resolution_unavailable", details: { availableIn: "F16" } });
    expect(await snapshot(student, [p])).toEqual(before);

    const key = randomUUID();
    const r = await call(resolveRoute, admin, "POST", `/api/operations/orders/${orderId}/resolve`, { key, resolution: "cancel_refund", reason: "Política da escola: reembolso" }, orderId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ resolution: "cancel_refund", classification: "refunded_not_picked_up", status: "delivered", refundCents: 1000, retainedCents: 0, returnedUnits: 2, discardedUnits: 0, wallet: { studentId: student, balanceCents: before.balanceCents + 1000 } });
    const after = await snapshot(student, [p]);
    expect(after).toMatchObject({ balanceCents: before.balanceCents + 1000, usage: 500, stock: { [p]: { onHand: 19, reserved: 0, movements: before.stock[p]!.movements } } });
    expect(await refunds(student)).toEqual([expect.objectContaining({ amountCents: 1000, orderId })]);
    expect(await moneyOf(orderId, [p])).toEqual({ total: 1500, refunded: 1000, revenue: 500 });
    expect(await doc(`auditLog/${admin.uid}__orders.resolve__${key}`)).toMatchObject({ after: { resolution: "cancel_refund", refundCents: 1000, studentId: student } });
    // replay e nova tentativa
    expect((await call(resolveRoute, admin, "POST", `/api/operations/orders/${orderId}/resolve`, { key, resolution: "cancel_refund", reason: "Política da escola: reembolso" }, orderId)).body.replayed).toBe(true);
    expect((await resolve(admin, orderId)).body.error).toBe("already_resolved");
    expect(await refunds(student)).toHaveLength(1);
    await expectLedger(student);
    await expectStock(p);
  });

  it("com descarte explícito: reembolso integral e perda só das unidades listadas, separados; sem descarte não há perda", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    await notPickedUp(cantina, orderId);
    const r = await resolve(admin, orderId, { discards: [{ lineNo: 1, quantity: 1 }] });
    expect(r.body).toMatchObject({ status: "cancelled", refundCents: 1000, returnedUnits: 1, discardedUnits: 1 });
    expect((await losses(p)).map((x) => x.quantity)).toEqual([-1]);
    expect(await snapshot(student, [p])).toMatchObject({ stock: { [p]: { onHand: 19, reserved: 0 } } });
    await expectStock(p);
  });

  it("falha intermediária na resolução (descarte impossível): pedido segue pendente e sem crédito", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    await notPickedUp(cantina, orderId);
    await db().doc(`stockBalances/${p}`).update({ onHand: 0 });
    const before = await snapshot(student, [p]);
    expect((await resolve(admin, orderId, { discards: [{ lineNo: 1, quantity: 2 }] })).status).toBe(409);
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "not_picked_up" });
  });
});

/* ----------------------------------------------------------------------------- telas e visão da família */

describe("Meus pedidos, recibo, extrato e telas operacionais refletem o cancelamento sem expor dados internos", () => {
  it("detalhe da família: cancelamentos, devolvido, 'cancelável' antes do prazo; extrato com o reembolso; aba Cancelados; sem ator/estoque/custo", async () => {
    const p = await newProduct({ price: 400, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }], { date: d(3) });
    const open = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(open.body).toMatchObject({ cancelable: true, refundedCents: 0, cancellations: [] });

    await cancelAs(cantina, "cantina", orderId, { lines: [{ lineNo: 1, quantity: 1 }], reason: "Motivo interno da cantina" });
    const partial = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(partial.body).toMatchObject({
      status: "paid",
      refundedCents: 400,
      items: [{ quantity: 3, canceledQty: 1, remainingQty: 2 }],
      cancellations: [{ by: "school", reason: null, refundCents: 400, lines: [{ quantity: 1, refundCents: 400 }] }],
    });
    // motivo da EQUIPE é interno: não sai para a família.
    expect(JSON.stringify(partial.body)).not.toContain("Motivo interno da cantina");

    await cancelAs(guardianA, "guardian", orderId, { reason: "Mudança de planos da família" });
    const done = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(done.body).toMatchObject({ status: "cancelled", group: "cancelled", refundedCents: 1200, cancelable: false });
    expect((done.body.timeline as { kind: string }[]).filter((t) => t.kind === "cancellation")).toHaveLength(2);
    expect((done.body.cancellations as { by: string; reason: string | null }[]).find((c) => c.by === "guardian")!.reason).toBe("Mudança de planos da família"); // o motivo do PRÓPRIO responsável aparece
    const text = JSON.stringify(done.body);
    for (const secret of [cantina.uid, guardianA.uid, "reservationId", "actorUid", "movement", "Micros", "cancellationId"]) expect(text).not.toContain(secret);

    const tab = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${student}&group=cancelled`);
    expect((tab.body.orders as { orderId: string; refundedCents: number }[]).find((o) => o.orderId === orderId)).toMatchObject({ refundedCents: 1200 });
    const pending = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${student}&group=pending`);
    expect((pending.body.orders as { orderId: string }[]).map((o) => o.orderId)).not.toContain(orderId);
    const stmt = await call(statementRoute, guardianA, "GET", `/api/wallets/entries?studentId=${student}`);
    expect((stmt.body.entries as { type: string; amountCents: number; orderId: string | null }[]).filter((e) => e.type === "order_refund").map((e) => [e.amountCents, e.orderId])).toEqual(expect.arrayContaining([[400, orderId], [800, orderId]]));
    expect((await call(detailRoute, guardianB, "GET", `/api/orders/${orderId}`, undefined, orderId)).status).toBe(403);
  });

  it("linha do tempo em ordem cronológica: cancelamento do responsável antes da entrega do restante", async () => {
    const p = await newProduct({ price: 400, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    expect((await cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 1 }] })).status).toBe(200);
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }])).status).toBe(200);
    const detail = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect((detail.body.timeline as { kind: string }[]).map((t) => t.kind)).toEqual(["created", "paid", "cancellation", "delivery"]);
  });

  it("depois do prazo (dia do consumo, horário passado) o detalhe não oferece cancelamento à família", async () => {
    const p = await newProduct({ stock: 30 });
    const { orderId } = await placeOrder([{ productId: p }], { date: d(3) });
    await db().doc(`orders/${orderId}`).update({ "policy.cancelCutoffAt": new Date(Date.now() - 60_000) });
    expect((await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId)).body).toMatchObject({ cancelable: false });
  });

  it("lista do dia e painel da cantina: canceladas aparecem e a conservação agendadas = canceladas + entregues + restantes + não retiradas vale", async () => {
    const p = await newProduct({ price: 500, stock: 30 });
    const a = await placeOrder([{ productId: p, quantity: 3 }]);
    await cancelAs(cantina, "cantina", a.orderId, { lines: [{ lineNo: 1, quantity: 1 }] });
    await deliver(cantina, a.orderId, a.student, [{ lineNo: 1, quantity: 1 }]);
    const b = await placeOrder([{ productId: p, quantity: 2 }]);
    await cancelAs(cantina, "cantina", b.orderId);
    const day = await call(dayRoute, cantina, "GET", `/api/operations/orders?date=${BASE}`);
    const rows = day.body.orders as { orderId: string; status: string; items: { canceledQty: number; deliveredQty: number; remainingQty: number }[] }[];
    expect(rows.find((o) => o.orderId === a.orderId)).toMatchObject({ status: "partially_delivered", items: [{ canceledQty: 1, deliveredQty: 1, remainingQty: 1 }] });
    expect(rows.find((o) => o.orderId === b.orderId)).toMatchObject({ status: "cancelled", items: [{ canceledQty: 2, remainingQty: 0 }] });
    const panel = await call(panelRoute, cantina, "GET", `/api/operations/preparation?date=${BASE}`);
    const row = (panel.body.rows as { productId: string; scheduled: number; canceled: number; delivered: number; remaining: number; notPickedUp: number }[]).find((r) => r.productId === p)!;
    expect(row.scheduled).toBe(row.canceled + row.delivered + row.remaining + row.notPickedUp);
    expect(row).toMatchObject({ scheduled: 5, canceled: 3, delivered: 1, remaining: 1 });
  });
});
