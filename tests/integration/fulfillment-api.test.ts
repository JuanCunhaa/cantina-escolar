// Preparação, entrega e não retirada (F13) contra Auth/Firestore Emulator: entrega direta e parcial com baixa de estoque/custo
// históricos pela reserva do PRÓPRIO pedido, sem novo débito na carteira; replay, mesma chave com payload diferente, clique
// duplo e entregas concorrentes; falha intermediária (planejado sem entrada, falha no último passo); autorização revogada;
// não retirada sem reembolso/perda automáticos e sua resolução (cobrança retida classificada, descarte = perda explícita);
// consultas do dia/painel e a visão da família. Pedidos reais nascem do checkout real; o saldo vem SÓ de fixture do emulador.
// Corrida ENTREGA × CANCELAMENTO não é provada aqui: o cancelamento é da F14 (registrado como integração a comprovar).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
type Result = { status: number; body: Json };
type Item = { lineNo: number; productId: string; quantity: number; deliveredQty?: number; reservationId: string };

let placeAdvanceOrders: typeof import("@/modules/orders/commands").placeAdvanceOrders;
let commandErrorResponse: typeof import("@/modules/access/command-route").commandErrorResponse;
let receiptsRoute: Handler;
let lossesRoute: Handler;
let capacityRoute: Handler;
let reconcileRoute: Handler;
let prepareRoute: Handler;
let deliverRoute: Handler;
let notPickedUpRoute: Handler;
let resolveRoute: Handler;
let dayRoute: Handler;
let panelRoute: Handler;
let detailRoute: Handler;
let listRoute: Handler;
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
const SM = `shf_${tag}_m`;
const ST = `shf_${tag}_t`;
const CLS_A = `cls_${tag}_a`;
const CLS_B = `cls_${tag}_b`;
const CAT = `cat_${tag}`;
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
  ({ commandErrorResponse } = await import("@/modules/access/command-route"));
  receiptsRoute = (await import("@/app/api/inventory/receipts/route")).POST as unknown as Handler;
  lossesRoute = (await import("@/app/api/inventory/losses/route")).POST as unknown as Handler;
  capacityRoute = (await import("@/app/api/inventory/capacity/route")).POST as unknown as Handler;
  reconcileRoute = (await import("@/app/api/inventory/reconcile/route")).GET as unknown as Handler;
  prepareRoute = (await import("@/app/api/operations/orders/[id]/prepare/route")).POST as unknown as Handler;
  deliverRoute = (await import("@/app/api/operations/orders/[id]/deliver/route")).POST as unknown as Handler;
  notPickedUpRoute = (await import("@/app/api/operations/orders/[id]/not-picked-up/route")).POST as unknown as Handler;
  resolveRoute = (await import("@/app/api/operations/orders/[id]/resolve/route")).POST as unknown as Handler;
  dayRoute = (await import("@/app/api/operations/orders/route")).GET as unknown as Handler;
  panelRoute = (await import("@/app/api/operations/preparation/route")).GET as unknown as Handler;
  detailRoute = (await import("@/app/api/orders/[id]/route")).GET as unknown as Handler;
  listRoute = (await import("@/app/api/orders/route")).GET as unknown as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ checkLedger, parseWalletState } = await import("@/modules/wallet/model"));
  school = await import("@/lib/dates/school-time");
  BASE = school.localDateOf(new Date());
  NOW = school.localInstant(BASE, "09:00");
  [admin, guardianA, guardianB, cantina, secretaria] = await Promise.all([
    createTestUser("fadm", "admin"),
    createTestUser("fresp-a", "guardian"),
    createTestUser("fresp-b", "guardian"),
    createTestUser("fcant", "cantina"),
    createTestUser("fsec", "secretaria"),
  ]);
  await globalDoc(`shifts/${SM}`, { name: `Manhã ${tag}`, nameSlug: "manha", status: "active" });
  await globalDoc(`shifts/${ST}`, { name: `Tarde ${tag}`, nameSlug: "tarde", status: "active" });
  await globalDoc(`classes/${CLS_A}`, { name: `Turma A ${tag}`, nameSlug: "turma-a", status: "active" });
  await globalDoc(`classes/${CLS_B}`, { name: `Turma B ${tag}`, nameSlug: "turma-b", status: "active" });
  await globalDoc(`categories/${CAT}`, { name: `Categoria ${tag}`, status: "active" });
  for (let i = 0; i <= 9; i++) await globalDoc(`calendarDays/${d(i)}`, { kind: "extra" });
});

/** Documentos GLOBAIS criados aqui: removidos no fim (outros arquivos compartilham o emulador). */
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
const actorOf = (user: TestUser) => ({ uid: user.uid, role: "guardian" as const, permissions: [] as never[] });

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

async function buy(user: TestUser, body: unknown): Promise<Result> {
  try {
    const result = await placeAdvanceOrders(db(), actorOf(user), body, () => NOW);
    return { status: 200, body: result as unknown as Json };
  } catch (error) {
    const response = commandErrorResponse(error, "teste");
    return { status: response.status, body: (await response.json()) as Json };
  }
}

type Line = { productId: string; quantity?: number };
function cart(studentId: string, shiftId: string, days: Record<string, Line[]>) {
  return {
    key: randomUUID(),
    studentId,
    expectedShiftId: shiftId,
    days: Object.entries(days).map(([date, lines]) => ({ date, lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity ?? 1, expectedPriceCents: prices.get(l.productId)! })) })),
  };
}

async function newStudent(over: { shift?: string; name?: string; classId?: string; cents?: number } = {}) {
  const id = `stu_${tag}_${++seq}`;
  const name = over.name ?? `Aluno ${seq}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardianA.uid], allowSitePurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, status: "active", userUid: null, shiftId: over.shift ?? ST, classId: over.classId ?? CLS_A, version: 3 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: true, allowCounterPurchase: false, configVersion: 1 });
  await fundDemoWallet(targetFromEnv(), id, over.cents ?? 50000);
  return id;
}

async function newProduct(over: { price?: number; mode?: "physical" | "planned"; stock?: number; capacity?: Record<string, number> } = {}) {
  const id = `prd_${tag}_${++seq}`;
  const price = over.price ?? 500;
  await globalDoc(`products/${id}`, {
    name: `Produto ${seq}`,
    description: "",
    categoryId: CAT,
    priceCents: price,
    priceVersion: 1,
    channels: ["advance", "counter"],
    shiftIds: [SM, ST],
    availabilityMode: over.mode ?? "physical",
    status: "active",
    version: 1,
  });
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
/** Entrada física de produto planejado para hoje (custo R$ 1,00 cada). */
async function receivePlanned(productId: string, quantity: number) {
  const r = await call(receiptsRoute, admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId, kind: "production", quantity, unitCost: "1,00", availableOn: BASE });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Pedido real pelo checkout do site, para HOJE (turno da tarde: compra aberta às 09:00 do relógio injetado). */
async function placeOrder(lines: Line[], over: { student?: string; date?: string; shift?: string } = {}) {
  const student = over.student ?? (await newStudent());
  const r = await buy(guardianA, cart(student, over.shift ?? ST, { [over.date ?? BASE]: lines }));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const orderId = (r.body.orders as { orderId: string }[])[0]!.orderId;
  return { student, orderId };
}
const itemsOf = async (orderId: string) => (await doc(`orders/${orderId}`))!.items as Item[];
const lineOf = async (orderId: string, productId: string) => (await itemsOf(orderId)).find((i) => i.productId === productId)!.lineNo;

const deliver = (user: TestUser | null, orderId: string, studentId: string, lines: { lineNo: number; quantity: number }[], key: string = randomUUID()) =>
  call(deliverRoute, user, "POST", `/api/operations/orders/${orderId}/deliver`, { key, studentId, lines }, orderId);
const prepare = (user: TestUser | null, orderId: string, to: "preparing" | "ready") => call(prepareRoute, user, "POST", `/api/operations/orders/${orderId}/prepare`, { key: randomUUID(), to }, orderId);
const notPickedUp = (user: TestUser | null, orderId: string, reason = "Família avisou que não virá") =>
  call(notPickedUpRoute, user, "POST", `/api/operations/orders/${orderId}/not-picked-up`, { key: randomUUID(), reason }, orderId);
const resolve = (user: TestUser | null, orderId: string, body: Record<string, unknown> = {}) =>
  call(resolveRoute, user, "POST", `/api/operations/orders/${orderId}/resolve`, { key: randomUUID(), resolution: "close_charged", reason: "Política da escola: cobrança mantida", ...body }, orderId);

/** Estado observável: carteira/livro (não pode mudar numa entrega), estoque físico, reservas e custo. */
async function snapshot(studentId: string, productIds: string[]) {
  const wallet = await doc(`wallets/${studentId}`);
  const entries = (await db().collection(`wallets/${studentId}/entries`).get()).size;
  const stock: Record<string, { onHand: number; reserved: number; reservations: string[]; movements: number; valueMicros: number }> = {};
  for (const id of productIds) {
    const balance = await doc(`stockBalances/${id}`);
    const reservations = (await db().collection(`stockBalances/${id}/reservations`).get()).docs.map((x) => `${x.id}:${x.get("status")}:${x.get("deliveredQty")}/${x.get("releasedQty")}`);
    stock[id] = {
      onHand: Number(balance?.onHand ?? 0),
      reserved: Object.values((balance?.reservedByDate ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0),
      reservations,
      movements: (await db().collection(`stockCosts/${id}/movements`).get()).size,
      valueMicros: Number((await doc(`stockCosts/${id}`))?.valueMicros ?? 0),
    };
  }
  return { balanceCents: Number(wallet?.balanceCents ?? 0), version: Number(wallet?.version ?? 0), entries, stock };
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
const exits = async (productId: string) => (await db().collection(`stockCosts/${productId}/movements`).where("type", "==", "sale_exit").get()).docs.map((x) => x.data());
const deliveriesOf = async (orderId: string) => (await db().collection(`orders/${orderId}/deliveries`).get()).docs.map((x) => x.data());

/* ------------------------------------------------------------------------------------------ entrega direta */

describe("entrega direta: baixa pela reserva do pedido, sem novo débito (A19)", () => {
  it("entrega tudo de uma vez: estoque baixa UMA vez, custo histórico no livro, carteira/livro intactos", async () => {
    const a = await newProduct({ price: 600, stock: 50 });
    const b = await newProduct({ price: 250, stock: 50 });
    const { student, orderId } = await placeOrder([{ productId: a, quantity: 2 }, { productId: b }]);
    const before = await snapshot(student, [a, b]);
    expect(before.stock[a]).toMatchObject({ onHand: 50, reserved: 2 });

    const key = randomUUID();
    const r = await deliver(cantina, orderId, student, [{ lineNo: await lineOf(orderId, a), quantity: 2 }, { lineNo: await lineOf(orderId, b), quantity: 1 }], key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, status: "delivered", remainingUnits: 0, orderId });
    expect(JSON.stringify(r.body)).not.toMatch(/cost|Cost|micros/i); // custo nunca volta a quem opera

    const order = (await doc(`orders/${orderId}`))!;
    expect(order).toMatchObject({ status: "delivered", deliveredQty: 3, deliveryCount: 1, version: 2 });
    expect(Object.fromEntries((order.items as Item[]).map((i) => [i.productId, i.deliveredQty]))).toEqual({ [a]: 2, [b]: 1 });
    expect(order.deliveredAt).toBeTruthy();

    const after = await snapshot(student, [a, b]);
    // Carteira e livro NÃO mudam: o pedido já foi pago no checkout.
    expect([after.balanceCents, after.version, after.entries]).toEqual([before.balanceCents, before.version, before.entries]);
    await expectLedger(student);
    // Estoque: baixa só das unidades entregues; reserva consumida; custo no livro.
    expect(after.stock[a]).toMatchObject({ onHand: 48, reserved: 0, movements: before.stock[a]!.movements + 1 });
    expect(after.stock[b]).toMatchObject({ onHand: 49, reserved: 0 });
    expect(after.stock[a]!.reservations.some((x) => x.includes(":fulfilled:2/0"))).toBe(true);
    const [exit] = await exits(a);
    expect(exit).toMatchObject({ type: "sale_exit", quantity: -2, referenceType: "order", referenceId: orderId, consumptionDate: BASE, revenueCents: 1200 });
    expect(Math.abs(Number(exit!.totalCostMicros))).toBe(2 * Math.abs(Number(exit!.unitCostMicros))); // custo médio R$ 1,00 × 2, exato
    // Evento da entrega e auditoria.
    expect(await deliveriesOf(orderId)).toEqual([expect.objectContaining({ orderId, studentId: student, seq: 1, totalUnits: 3, actorUid: cantina.uid })]);
    expect(await doc(`auditLog/${cantina.uid}__orders.deliver__${key}`)).toMatchObject({ action: "orders.deliver", target: { type: "order", id: orderId }, after: { status: "delivered", deliveredQty: 3 } });
    await expectStock(a);
    await expectStock(b);
  });

  it("entrega direta funciona a partir de 'agendado', 'em preparação' e 'pronto', sem obrigar a clicar nas etapas", async () => {
    const p = await newProduct({ stock: 20 });
    for (const stage of [null, "preparing", "ready"] as const) {
      const { student, orderId } = await placeOrder([{ productId: p }]);
      if (stage) expect((await prepare(cantina, orderId, stage)).status).toBe(200);
      const r = await deliver(admin, orderId, student, [{ lineNo: 1, quantity: 1 }]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.status).toBe("delivered");
    }
  });
});

/* ----------------------------------------------------------------------------------------- entrega parcial */

describe("entrega parcial por quantidade de item (A22 parcial)", () => {
  it("entrega em partes: situação agregada, restante, estoque e custo conservados; carteira intacta", async () => {
    const p = await newProduct({ price: 400, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    const start = await snapshot(student, [p]);

    const first = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }]);
    expect(first.body).toMatchObject({ status: "partially_delivered", remainingUnits: 2, items: [{ lineNo: 1, quantity: 3, deliveredQty: 1, remainingQty: 2 }] });
    expect(await snapshot(student, [p])).toMatchObject({ stock: { [p]: { onHand: 29, reserved: 2 } } });
    // Pedido parcial é pendente (restante) e não pode ser preparado de novo.
    expect((await prepare(cantina, orderId, "ready")).body.error).toBe("invalid_transition");

    const second = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }]);
    expect(second.body).toMatchObject({ status: "delivered", remainingUnits: 0 });

    const end = await snapshot(student, [p]);
    expect([end.balanceCents, end.version, end.entries]).toEqual([start.balanceCents, start.version, start.entries]);
    expect(end.stock[p]).toMatchObject({ onHand: 27, reserved: 0 });
    // Conservação de unidades e custo: Σ saídas = 3 un. = entregue; custo total = 3 × R$ 1,00 e valor restante = 27 × R$ 1,00.
    const movements = await exits(p);
    expect(movements.reduce((n, m) => n + Math.abs(Number(m.quantity)), 0)).toBe(3);
    const unit = Math.abs(Number(movements[0]!.unitCostMicros));
    expect(movements.reduce((n, m) => n + Math.abs(Number(m.totalCostMicros)), 0)).toBe(3 * unit);
    expect(end.stock[p]!.valueMicros).toBe(27 * unit);
    expect((await deliveriesOf(orderId)).map((x) => x.seq).sort()).toEqual([1, 2]);
    await expectStock(p);
  });

  it("um item entregue e o outro pendente: situação parcial; o item pendente segue reservado", async () => {
    const a = await newProduct({ stock: 10 });
    const b = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: a }, { productId: b, quantity: 2 }]);
    const r = await deliver(cantina, orderId, student, [{ lineNo: await lineOf(orderId, a), quantity: 1 }]);
    expect(r.body.status).toBe("partially_delivered");
    expect(await snapshot(student, [a, b])).toMatchObject({ stock: { [a]: { onHand: 9, reserved: 0 }, [b]: { onHand: 10, reserved: 2 } } });
  });

  it("quantidade acima do restante, linha inexistente, aluno trocado e dia errado são recusados sem efeito", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    const other = await newStudent();
    const before = await snapshot(student, [p]);
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 3 }])).body).toMatchObject({ error: "quantity_exceeds_remaining", details: { remaining: 2, requested: 3 } });
    expect((await deliver(cantina, orderId, student, [{ lineNo: 9, quantity: 1 }])).body.error).toBe("line_not_found");
    expect((await deliver(cantina, orderId, other, [{ lineNo: 1, quantity: 1 }])).body.error).toBe("student_mismatch");
    expect((await deliver(cantina, "ord_inexistente", student, [{ lineNo: 1, quantity: 1 }])).status).toBe(404);
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 0 }])).status).toBe(400);
    expect(await snapshot(student, [p])).toEqual(before);

    const future = await placeOrder([{ productId: p }], { date: d(1), student });
    expect((await deliver(cantina, future.orderId, student, [{ lineNo: 1, quantity: 1 }])).body).toMatchObject({ error: "not_consumption_date", details: { consumptionDate: d(1), today: BASE } });
    expect((await prepare(cantina, future.orderId, "preparing")).body.error).toBe("not_consumption_date");
    expect((await notPickedUp(cantina, future.orderId)).body.error).toBe("not_consumption_date");
  });
});

/* ------------------------------------------------------------------------------- replay, clique duplo, corrida */

describe("idempotência e concorrência (A19/A35)", () => {
  it("replay com a mesma chave devolve a resposta original e não baixa de novo; payload diferente com a mesma chave conflita", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    const key = randomUUID();
    const first = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }], key);
    const again = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }], key);
    expect(first.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, deliveryId: first.body.deliveryId, status: "partially_delivered" });
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }], key)).body.error).toBe("idempotency_conflict");
    expect(await snapshot(student, [p])).toMatchObject({ stock: { [p]: { onHand: 9, reserved: 1 } } });
    expect((await exits(p)).length).toBe(1);
    expect(await deliveriesOf(orderId)).toHaveLength(1);
  });

  it("clique duplo com chaves diferentes: a segunda entrega é recusada e não baixa de novo", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }])).status).toBe(200);
    const second = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }]);
    expect(second.body.error).toBe("already_delivered");
    expect(await snapshot(student, [p])).toMatchObject({ stock: { [p]: { onHand: 9, reserved: 0 } } });
    expect((await exits(p)).length).toBe(1);
  });

  it("8 entregas simultâneas da MESMA última unidade: exatamente uma vence, uma única baixa", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    const results = await Promise.all(Array.from({ length: 8 }, () => deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }])));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(["already_delivered", "quantity_exceeds_remaining"]).toContain(r.body.error);
    expect(await snapshot(student, [p])).toMatchObject({ stock: { [p]: { onHand: 9, reserved: 0 } } });
    expect((await exits(p)).length).toBe(1);
    expect(await deliveriesOf(orderId)).toHaveLength(1);
    expect((await doc(`orders/${orderId}`))!.deliveredQty).toBe(1);
    await expectStock(p);
  });

  it("6 entregas simultâneas de 1 unidade sobre um pedido de 3: nunca excede o restante (3 vencem)", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }])));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect((await doc(`orders/${orderId}`))).toMatchObject({ deliveredQty: 3, status: "delivered" });
    expect(await snapshot(student, [p])).toMatchObject({ stock: { [p]: { onHand: 7, reserved: 0 } } });
    expect((await exits(p)).reduce((n, m) => n + Math.abs(Number(m.quantity)), 0)).toBe(3);
    await expectStock(p);
  });

  it("duas entregas de 2 sobre 3 restantes: só uma passa (nunca 4 de 3)", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    const results = await Promise.all([deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }]), deliver(admin, orderId, student, [{ lineNo: 1, quantity: 2 }])]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe("quantity_exceeds_remaining");
    expect(await snapshot(student, [p])).toMatchObject({ stock: { [p]: { onHand: 8, reserved: 1 } } });
  });

  it("entregas simultâneas de pedidos DIFERENTES do mesmo produto baixam cada uma uma vez e o estoque reconcilia", async () => {
    const p = await newProduct({ stock: 10 });
    const orders = await Promise.all([1, 2, 3, 4].map(() => placeOrder([{ productId: p }])));
    const results = await Promise.all(orders.map((o) => deliver(cantina, o.orderId, o.student, [{ lineNo: 1, quantity: 1 }])));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await snapshot(orders[0]!.student, [p])).toMatchObject({ stock: { [p]: { onHand: 6, reserved: 0 } } });
    expect((await exits(p)).length).toBe(4);
    await expectStock(p);
  });

  it("falha no ÚLTIMO passo (auditoria) depois de planejar o estoque: nada persiste; o retry com a mesma chave baixa uma só vez", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    const key = randomUUID();
    const auditId = `${cantina.uid}__orders.deliver__${key}`;
    await db().doc(`auditLog/${auditId}`).set({ action: "bloqueio-de-teste" }); // o create() da auditoria falha (ALREADY_EXISTS)
    const before = await snapshot(student, [p]);
    const failed = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }], key);
    expect(failed.status).toBe(500);
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "paid", version: 1 });
    expect(await deliveriesOf(orderId)).toHaveLength(0);
    expect(await doc(`idempotencyRecords/${cantina.uid}__orders.deliver__${key}`)).toBeUndefined();

    await db().doc(`auditLog/${auditId}`).delete();
    const retry = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }], key);
    expect(retry.status).toBe(200);
    expect((await exits(p)).length).toBe(1);
    expect(await snapshot(student, [p])).toMatchObject({ stock: { [p]: { onHand: 9, reserved: 0 } } });
  });
});

/* --------------------------------------------------------------------------- reservas de outros pedidos / físico */

describe("não consome o que está reservado para outro pedido (A19)", () => {
  it("estoque exato de 5 para dois pedidos (2 e 3): cada um entrega só a própria reserva e o outro continua coberto", async () => {
    const p = await newProduct({ stock: 5 });
    const a = await placeOrder([{ productId: p, quantity: 2 }]);
    const b = await placeOrder([{ productId: p, quantity: 3 }]);
    expect((await deliver(cantina, a.orderId, a.student, [{ lineNo: 1, quantity: 3 }])).body.error).toBe("quantity_exceeds_remaining");
    expect((await deliver(cantina, a.orderId, a.student, [{ lineNo: 1, quantity: 2 }])).status).toBe(200);
    expect(await snapshot(a.student, [p])).toMatchObject({ stock: { [p]: { onHand: 3, reserved: 3 } } }); // as 3 do pedido B seguem reservadas
    expect((await deliver(cantina, b.orderId, b.student, [{ lineNo: 1, quantity: 3 }])).status).toBe(200);
    expect(await snapshot(b.student, [p])).toMatchObject({ stock: { [p]: { onHand: 0, reserved: 0 } } });
    await expectStock(p);
  });

  it("pedido adulterado para apontar a reserva de OUTRO pedido: recusa (reservation_mismatch) e nada muda", async () => {
    const p = await newProduct({ stock: 10 });
    const a = await placeOrder([{ productId: p }]);
    const b = await placeOrder([{ productId: p, quantity: 2 }]);
    const itemsA = await itemsOf(a.orderId);
    const itemsB = await itemsOf(b.orderId);
    await db().doc(`orders/${a.orderId}`).update({ items: [{ ...itemsA[0], reservationId: itemsB[0]!.reservationId }] }); // fixture de adulteração
    const before = await snapshot(a.student, [p]);
    expect((await deliver(cantina, a.orderId, a.student, [{ lineNo: 1, quantity: 1 }])).body.error).toBe("reservation_mismatch");
    expect(await snapshot(a.student, [p])).toEqual(before);
  });

  it("estoque físico some depois da compra (perda): a entrega é recusada, sem inventar unidade", async () => {
    const p = await newProduct({ stock: 1 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    // Perda REAL registrada pela cantina: o físico some e o pedido fica sem lastro (a perda não cancela nada sozinha).
    const loss = await call(lossesRoute, cantina, "POST", "/api/inventory/losses", { key: randomUUID(), productId: p, quantity: 1, reason: "breakage", note: "Caiu no chão" });
    expect(loss.status, JSON.stringify(loss.body)).toBe(200);
    const before = await snapshot(student, [p]);
    const r = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }]);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("insufficient_stock");
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "paid" });
  });
});

/* --------------------------------------------------------------------------------------- produto planejado */

describe("produto planejado exige entrada física antes da entrega (A19)", () => {
  it("sem entrada: entry_required diz o que registrar e nada muda; com a entrada, entrega e baixa uma vez", async () => {
    const p = await newProduct({ mode: "planned", price: 700, capacity: { [`${BASE}@${ST}`]: 5 } });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    const before = await snapshot(student, [p]);
    const refused = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }]);
    expect(refused.body).toMatchObject({ error: "entry_required", details: { missingUnits: 2, productId: p, date: BASE } });
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "paid", version: 1 });

    await receivePlanned(p, 2);
    const ok = await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }]);
    expect(ok.body).toMatchObject({ status: "delivered" });
    expect((await snapshot(student, [p])).stock[p]).toMatchObject({ onHand: 0, reserved: 0 });
    const [exit] = await exits(p);
    expect(Math.abs(Number(exit!.totalCostMicros))).toBe(2 * Math.abs(Number(exit!.unitCostMicros)));
    await expectStock(p);
  });

  it("falha intermediária: 2 itens, o planejado sem entrada derruba TODA a entrega (o físico não é baixado); depois da entrada o retry com a mesma chave passa", async () => {
    const planned = await newProduct({ mode: "planned", capacity: { [`${BASE}@${ST}`]: 5 } });
    const physical = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: planned }, { productId: physical }]);
    const lines = [{ lineNo: await lineOf(orderId, planned), quantity: 1 }, { lineNo: await lineOf(orderId, physical), quantity: 1 }];
    const key = randomUUID();
    const before = await snapshot(student, [planned, physical]);
    expect((await deliver(cantina, orderId, student, lines, key)).body.error).toBe("entry_required");
    expect(await snapshot(student, [planned, physical])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "paid", version: 1 });
    expect((await doc(`orders/${orderId}`))!.deliveredQty).toBeUndefined();

    await receivePlanned(planned, 1);
    expect((await deliver(cantina, orderId, student, lines, key)).status).toBe(200);
    expect(await snapshot(student, [planned, physical])).toMatchObject({ stock: { [planned]: { onHand: 0, reserved: 0 }, [physical]: { onHand: 9, reserved: 0 } } });
  });
});

/* ------------------------------------------------------------------------------------------- autorização */

describe("autorização atual no servidor", () => {
  it("só cantina e administração operam; família, secretaria e anônimo são negados sem efeito", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    const before = await snapshot(student, [p]);
    for (const [user, status] of [[guardianA, 403], [guardianB, 403], [secretaria, 403], [null, 401]] as const) {
      expect((await deliver(user, orderId, student, [{ lineNo: 1, quantity: 1 }])).status).toBe(status);
      expect((await prepare(user, orderId, "preparing")).status).toBe(status);
      expect((await notPickedUp(user, orderId)).status).toBe(status);
      expect((await call(dayRoute, user, "GET", "/api/operations/orders")).status).toBe(status);
      expect((await call(panelRoute, user, "GET", "/api/operations/preparation")).status).toBe(status);
    }
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "paid", version: 1 });
  });

  it("autorização REVOGADA entre a autenticação e o comando: perfil desativado/rebaixado é negado, inclusive o replay", async () => {
    const staff = await createTestUser("frev", "cantina");
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    const key = randomUUID();
    expect((await deliver(staff, orderId, student, [{ lineNo: 1, quantity: 1 }], key)).status).toBe(200);

    await db().doc(`users/${staff.uid}`).update({ status: "disabled" });
    const before = await snapshot(student, [p]);
    expect((await deliver(staff, orderId, student, [{ lineNo: 1, quantity: 1 }])).status).toBe(403);
    expect((await deliver(staff, orderId, student, [{ lineNo: 1, quantity: 1 }], key)).status).toBe(403); // replay também reautoriza
    await db().doc(`users/${staff.uid}`).update({ status: "active", role: "guardian" });
    expect((await deliver(staff, orderId, student, [{ lineNo: 1, quantity: 1 }])).status).toBe(403);
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ deliveredQty: 1, status: "partially_delivered" });
  });
});

/* ---------------------------------------------------------------------------------------------- preparo */

describe("preparo: agendado → em preparação → pronto", () => {
  it("avança, recusa retrocesso/repetição e registra auditoria; a entrega depois do preparo é normal", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    const entriesBefore = (await snapshot(student, [p])).entries;
    const r1 = await prepare(cantina, orderId, "preparing");
    expect(r1.body).toMatchObject({ status: "preparing", version: 2, statusLabel: "Em preparo" });
    expect((await prepare(cantina, orderId, "preparing")).body.error).toBe("invalid_transition");
    const r2 = await prepare(cantina, orderId, "ready");
    expect(r2.body).toMatchObject({ status: "ready", version: 3 });
    expect((await prepare(cantina, orderId, "preparing")).body.error).toBe("invalid_transition");
    expect((await doc(`orders/${orderId}`))).toMatchObject({ prep: "ready", status: "ready" });
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }])).body.status).toBe("delivered");
    expect((await prepare(cantina, orderId, "ready")).body.error).toBe("invalid_transition");
    // Preparo não mexe em carteira nem estoque.
    expect((await snapshot(student, [p])).entries).toBe(entriesBefore);
  });
});

/* ----------------------------------------------------------------------------------------- não retirada */

describe("não retirada: sem reembolso nem perda automáticos, resolução explícita (A27)", () => {
  it("marcar não retirado só registra: carteira, livro, estoque e reserva intactos; bloqueia entrega e aparece para resolução", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    const before = await snapshot(student, [p]);
    expect((await call(notPickedUpRoute, cantina, "POST", `/api/operations/orders/${orderId}/not-picked-up`, { key: randomUUID(), reason: "ok" }, orderId)).status).toBe(400); // motivo curto demais
    const r = await notPickedUp(cantina, orderId);
    expect(r.body).toMatchObject({ status: "not_picked_up", remainingUnits: 2, remainingCents: 1000 });

    expect(await snapshot(student, [p])).toEqual(before); // nada de reembolso, perda ou liberação silenciosos
    expect((await db().collection(`stockCosts/${p}/movements`).where("type", "==", "loss").get()).size).toBe(0);
    const saved = (await doc(`orders/${orderId}`))!;
    expect(saved).toMatchObject({ status: "not_picked_up", nonPickup: { reason: "Família avisou que não virá", remainingUnits: 2, remainingCents: 1000, resolution: null } });

    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }])).body.error).toBe("order_not_picked_up");
    expect((await prepare(cantina, orderId, "ready")).body.error).toBe("invalid_transition");
    expect((await notPickedUp(cantina, orderId)).body.error).toBe("invalid_transition");

    // Fica VISÍVEL na lista do dia e no painel de pendências (não existe pendência invisível).
    const day = await call(dayRoute, cantina, "GET", `/api/operations/orders?date=${BASE}&status=not_picked_up`);
    expect((day.body.orders as { orderId: string; needsResolution: boolean }[]).find((o) => o.orderId === orderId)).toMatchObject({ needsResolution: true, remainingUnits: 0 });
    const panel = await call(panelRoute, cantina, "GET", "/api/operations/preparation");
    expect((panel.body.attention as { orderId: string; marked: boolean; remainingCents: number }[]).find((o) => o.orderId === orderId)).toMatchObject({ marked: true, remainingCents: 1000 });
  });

  it("resolução é só da administração, exige motivo e recusa reembolso/reagendamento ainda inexistentes (F14/F16)", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    await notPickedUp(cantina, orderId);
    const before = await snapshot(student, [p]);
    expect((await resolve(cantina, orderId)).status).toBe(403);
    expect((await resolve(secretaria, orderId)).status).toBe(403);
    expect((await resolve(guardianA, orderId)).status).toBe(403);
    expect((await resolve(null, orderId)).status).toBe(401);
    expect((await resolve(admin, orderId, { reason: "x" })).status).toBe(400);
    expect((await resolve(admin, orderId, { resolution: "cancel_refund" })).body).toMatchObject({ error: "resolution_unavailable", details: { availableIn: "F14" } });
    expect((await resolve(admin, orderId, { resolution: "reschedule" })).body).toMatchObject({ error: "resolution_unavailable", details: { availableIn: "F16" } });
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "not_picked_up" });
  });

  it("encerrar com cobrança (devolvendo ao estoque): valor mantido classificado, sem novo lançamento, sem reembolso, sem perda", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }])).body.status).toBe("partially_delivered");
    await notPickedUp(cantina, orderId);
    const before = await snapshot(student, [p]);
    expect(before.stock[p]).toMatchObject({ onHand: 9, reserved: 2 });

    const key = randomUUID();
    const r = await call(resolveRoute, admin, "POST", `/api/operations/orders/${orderId}/resolve`, { key, resolution: "close_charged", reason: "Política da escola: cobrança mantida" }, orderId);
    expect(r.body).toMatchObject({ status: "not_picked_up_closed", classification: "retained_charge_not_picked_up", retainedCents: 1000, returnedUnits: 2, discardedUnits: 0 });

    const after = await snapshot(student, [p]);
    expect([after.balanceCents, after.version, after.entries]).toEqual([before.balanceCents, before.version, before.entries]); // sem reembolso nem nova receita
    await expectLedger(student);
    expect(after.stock[p]).toMatchObject({ onHand: 9, reserved: 0, movements: before.stock[p]!.movements }); // reserva liberada, físico intacto, sem perda
    expect((await db().collection(`stockCosts/${p}/movements`).where("type", "==", "loss").get()).size).toBe(0);
    expect((await exits(p)).length).toBe(1); // só a entrega real é "saída por venda"
    const saved = (await doc(`orders/${orderId}`))!;
    expect(saved).toMatchObject({ status: "not_picked_up_closed", nonPickup: { resolution: { kind: "close_charged", classification: "retained_charge_not_picked_up", amountCents: 1000, returnedUnits: 2, discardedUnits: 0, resolvedByUid: admin.uid } } });
    expect(await doc(`auditLog/${admin.uid}__orders.resolve__${key}`)).toMatchObject({ action: "orders.resolve_not_picked_up", reason: "Política da escola: cobrança mantida" });

    expect((await resolve(admin, orderId)).body.error).toBe("already_resolved");
    expect((await call(resolveRoute, admin, "POST", `/api/operations/orders/${orderId}/resolve`, { key, resolution: "close_charged", reason: "Política da escola: cobrança mantida" }, orderId)).body.replayed).toBe(true);
    expect(await snapshot(student, [p])).toEqual(after);
    expect((await call(panelRoute, cantina, "GET", "/api/operations/preparation")).body.attention).not.toEqual(expect.arrayContaining([expect.objectContaining({ orderId })]));
    await expectStock(p);
  });

  it("descarte é perda EXPLÍCITA: só as unidades listadas viram movimento de perda; o resto volta à disponibilidade", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    await notPickedUp(cantina, orderId);
    expect((await resolve(admin, orderId, { discards: [{ lineNo: 1, quantity: 4 }] })).body.error).toBe("quantity_exceeds_remaining");
    expect((await resolve(admin, orderId, { discards: [{ lineNo: 7, quantity: 1 }] })).body.error).toBe("line_not_found");
    const before = await snapshot(student, [p]);
    expect(before.stock[p]).toMatchObject({ onHand: 10, reserved: 3 }); // recusas não mexeram em nada

    const r = await resolve(admin, orderId, { discards: [{ lineNo: 1, quantity: 2 }] });
    expect(r.body).toMatchObject({ status: "not_picked_up_closed", retainedCents: 1500, returnedUnits: 1, discardedUnits: 2 });
    const after = await snapshot(student, [p]);
    expect([after.balanceCents, after.entries]).toEqual([before.balanceCents, before.entries]);
    expect(after.stock[p]).toMatchObject({ onHand: 8, reserved: 0 });
    const losses = (await db().collection(`stockCosts/${p}/movements`).where("type", "==", "loss").get()).docs.map((x) => x.data());
    expect(losses).toEqual([expect.objectContaining({ quantity: -2, reasonCode: "discard", referenceType: "order", referenceId: orderId })]);
    expect(Math.abs(Number(losses[0]!.totalCostMicros))).toBe(2 * Math.abs(Number(losses[0]!.unitCostMicros)));
    await expectStock(p);
  });

  it("descarte que deixa OUTRO pedido sem lastro físico avisa (shortfallUnits e pedidos afetados) e audita", async () => {
    const p = await newProduct({ stock: 3 });
    const x = await placeOrder([{ productId: p, quantity: 2 }]);
    const y = await placeOrder([{ productId: p }]);
    await notPickedUp(cantina, x.orderId);
    const loss = await call(lossesRoute, cantina, "POST", "/api/inventory/losses", { key: randomUUID(), productId: p, quantity: 1, reason: "breakage", note: "Quebra de uma unidade" });
    expect(loss.status, JSON.stringify(loss.body)).toBe(200); // já falta 1 unidade para as 3 reservadas

    const key = randomUUID();
    const r = await call(resolveRoute, admin, "POST", `/api/operations/orders/${x.orderId}/resolve`, { key, resolution: "close_charged", reason: "Política da escola: cobrança mantida", discards: [{ lineNo: 1, quantity: 2 }] }, x.orderId);
    expect(r.body).toMatchObject({ status: "not_picked_up_closed", discardedUnits: 2, shortfallUnits: 1, affectedOrders: [y.orderId] });
    expect(await doc(`auditLog/${admin.uid}__orders.resolve__${key}`)).toMatchObject({ after: { shortfallUnits: 1, affectedOrders: [y.orderId] } });
    // nada cancela o pedido afetado sozinho: ele segue pago e a entrega é recusada por falta de lastro
    expect(await doc(`orders/${y.orderId}`)).toMatchObject({ status: "paid" });
    expect((await deliver(cantina, y.orderId, y.student, [{ lineNo: 1, quantity: 1 }])).body.error).toBe("insufficient_stock");
  });

  it("falha intermediária na resolução (descarte de planejado sem unidade física): tudo desfeito, pedido segue pendente", async () => {
    const p = await newProduct({ mode: "planned", capacity: { [`${BASE}@${ST}`]: 5 } });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    await notPickedUp(cantina, orderId);
    const before = await snapshot(student, [p]);
    expect((await resolve(admin, orderId, { discards: [{ lineNo: 1, quantity: 1 }] })).body.error).toBe("insufficient_stock");
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${orderId}`)).toMatchObject({ status: "not_picked_up", nonPickup: { resolution: null } });
    // Sem descarte (nada físico a perder), encerrar com cobrança libera só a cota reservada.
    expect((await resolve(admin, orderId)).body).toMatchObject({ status: "not_picked_up_closed", returnedUnits: 2 });
    expect((await snapshot(student, [p])).stock[p]).toMatchObject({ reserved: 0, onHand: 0 });
  });

  it("não retirado só se marca com algo por entregar (entregue por completo é recusado)", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }]);
    expect((await notPickedUp(cantina, orderId)).body.error).toBe("invalid_transition");
  });
});

/* ------------------------------------------------------------------------------------ pedidos do dia / painel */

describe("pedidos do dia e painel de preparação", () => {
  it("filtra por data/turno/turma/situação, busca por nome sem acento e conta por situação; só quem opera lê", async () => {
    const p = await newProduct({ stock: 50 });
    const maria = await newStudent({ name: `Maria José ${tag}`, classId: CLS_A, shift: ST });
    const joao = await newStudent({ name: `João Pedro ${tag}`, classId: CLS_B, shift: ST });
    const ana = await newStudent({ name: `Ana Clara ${tag}`, classId: CLS_B, shift: SM });
    const mine = [(await placeOrder([{ productId: p, quantity: 2 }], { student: maria })).orderId, (await placeOrder([{ productId: p }], { student: joao })).orderId, (await placeOrder([{ productId: p }], { student: ana, date: d(1), shift: SM })).orderId];
    await prepare(cantina, mine[1]!, "ready");

    const all = await call(dayRoute, cantina, "GET", `/api/operations/orders?date=${BASE}&shiftId=${ST}&q=${encodeURIComponent(tag)}`);
    const rows = all.body.orders as { orderId: string; studentName: string; className: string; status: string; items: { remainingQty: number }[] }[];
    expect(rows.map((r) => r.orderId).sort()).toEqual([mine[0]!, mine[1]!].sort());
    expect(rows[0]!.className).toBe(`Turma A ${tag}`); // ordenado por turma, depois nome
    expect(all.body).toMatchObject({ date: BASE, today: BASE, canDeliver: true, truncated: false });

    const byClass = await call(dayRoute, cantina, "GET", `/api/operations/orders?date=${BASE}&classId=${CLS_B}&q=${encodeURIComponent(`joao pedro ${tag}`)}`);
    expect((byClass.body.orders as { orderId: string }[]).map((r) => r.orderId)).toEqual([mine[1]]); // "joao" acha "João"
    const ready = await call(dayRoute, cantina, "GET", `/api/operations/orders?date=${BASE}&status=ready&q=${encodeURIComponent(tag)}`);
    expect((ready.body.orders as { orderId: string }[]).map((r) => r.orderId)).toEqual([mine[1]]);
    expect((all.body.counts as Record<string, number>)).toMatchObject({ paid: 1, ready: 1 });

    // aviso da lista do dia: só pendências (sem ler totais do dia nem a previsão)
    const onlyAttention = await call(panelRoute, cantina, "GET", "/api/operations/preparation?scope=attention");
    expect([onlyAttention.status, onlyAttention.body.rows, onlyAttention.body.forecast]).toEqual([200, [], []]);
    expect((await call(panelRoute, cantina, "GET", "/api/operations/preparation?scope=tudo")).status).toBe(400);

    const tomorrow = await call(dayRoute, admin, "GET", `/api/operations/orders?date=${d(1)}&q=${encodeURIComponent(tag)}`);
    expect(tomorrow.body).toMatchObject({ canDeliver: false });
    expect((tomorrow.body.orders as { orderId: string }[]).map((r) => r.orderId)).toEqual([mine[2]]);
    expect((await call(dayRoute, cantina, "GET", "/api/operations/orders?date=2026-13-45")).status).toBe(400);
  });

  it("totais por produto/data/turno conservam agendadas = canceladas + entregues + restantes + não retiradas; previsão de 7 dias; pendências", async () => {
    const p = await newProduct({ price: 300, stock: 100 });
    const x = await placeOrder([{ productId: p, quantity: 4 }]);
    const y = await placeOrder([{ productId: p, quantity: 2 }]);
    const z = await placeOrder([{ productId: p, quantity: 1 }]);
    await placeOrder([{ productId: p, quantity: 5 }], { date: d(3) });
    await placeOrder([{ productId: p, quantity: 7 }], { date: d(7) }); // fora dos 7 dias de previsão (hoje … hoje+6)
    await deliver(cantina, x.orderId, x.student, [{ lineNo: 1, quantity: 1 }]);
    await deliver(cantina, y.orderId, y.student, [{ lineNo: 1, quantity: 2 }]);
    await notPickedUp(cantina, z.orderId);

    const panel = await call(panelRoute, cantina, "GET", `/api/operations/preparation?date=${BASE}&shiftId=${ST}`);
    const row = (panel.body.rows as Record<string, number | string>[]).find((r) => r.productId === p)!;
    expect(row).toMatchObject({ scheduled: 7, delivered: 3, canceled: 0, remaining: 3, notPickedUp: 1, consumptionDate: BASE, shiftId: ST });
    expect(Number(row.scheduled)).toBe(Number(row.canceled) + Number(row.delivered) + Number(row.remaining) + Number(row.notPickedUp));
    const forecast = (panel.body.forecast as { productId: string; consumptionDate: string; scheduled: number }[]).filter((r) => r.productId === p);
    expect(forecast.map((r) => [r.consumptionDate, r.scheduled])).toEqual([[BASE, 7], [d(3), 5]]);
    expect(panel.body).toMatchObject({ forecastFrom: BASE, forecastTo: d(6) });
    expect((panel.body.attention as { orderId: string }[]).map((a) => a.orderId)).toContain(z.orderId);
  });

  it("pedido vencido sem entrega nem marcação aparece como pendência (não marcado) em vez de ficar invisível", async () => {
    const p = await newProduct({ stock: 10 });
    const { orderId } = await placeOrder([{ productId: p }], { date: d(1) });
    await db().doc(`orders/${orderId}`).update({ consumptionDate: d(-1) }); // fixture do emulador: envelhece o pedido
    const panel = await call(panelRoute, cantina, "GET", "/api/operations/preparation");
    expect((panel.body.attention as { orderId: string; marked: boolean }[]).find((a) => a.orderId === orderId)).toMatchObject({ marked: false, remainingUnits: 1 });
    expect((await deliver(cantina, orderId, "x", [{ lineNo: 1, quantity: 1 }])).status).toBe(409); // nem entrega fora do dia
  });
});

/* ----------------------------------------------------------------------------- Meus pedidos / detalhe / recibo */

describe("Meus pedidos, detalhe e recibo refletem o estado operacional sem expor dados internos (A26 parcial)", () => {
  it("entrega parcial: situação, progresso por item, linha do tempo e abas; sem ator, reserva, custo nem motivo interno", async () => {
    const p = await newProduct({ price: 400, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }]);
    await prepare(cantina, orderId, "ready");
    await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }]);

    const detail = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      status: "partially_delivered",
      group: "pending",
      statusLabel: expect.stringContaining("Entregue em parte"),
      items: [{ quantity: 3, deliveredQty: 1, remainingQty: 2, unitPriceCents: 400, subtotalCents: 1200 }],
      deliveries: [{ lines: [{ quantity: 1 }] }],
      nonPickup: null,
      receipt: { amountCents: -1200 },
    });
    expect((detail.body.timeline as { kind: string }[]).map((t) => t.kind)).toEqual(["created", "paid", "ready", "delivery"]);
    const text = JSON.stringify(detail.body);
    for (const secret of [cantina.uid, admin.uid, "reservationId", "actorUid", "movement", "Micros", "deliveryId"]) expect(text).not.toContain(secret);

    await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }]);
    const done = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${student}&group=completed`);
    expect((done.body.orders as { orderId: string; status: string; items: { deliveredQty: number }[] }[]).find((o) => o.orderId === orderId)).toMatchObject({ status: "delivered", items: [{ deliveredQty: 3 }] });
    const pending = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${student}&group=pending`);
    expect((pending.body.orders as { orderId: string }[]).map((o) => o.orderId)).not.toContain(orderId);
    expect((await call(detailRoute, guardianB, "GET", `/api/orders/${orderId}`, undefined, orderId)).status).toBe(403); // outra família continua sem acesso
  });

  it("não retirado pendente e encerrado: a família vê a situação e a classificação, nunca o motivo interno nem quem decidiu", async () => {
    const p = await newProduct({ price: 500, stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    await notPickedUp(cantina, orderId, "Observação interna sigilosa da equipe");
    const pending = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(pending.body).toMatchObject({ status: "not_picked_up", group: "pending", statusLabel: expect.stringContaining("aguardando resolução"), nonPickup: { resolved: false, retainedCents: 1000, classification: null } });

    await resolve(admin, orderId, { reason: "Decisão interna da direção" });
    const closed = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(closed.body).toMatchObject({ status: "not_picked_up_closed", group: "completed", nonPickup: { resolved: true, retainedCents: 1000, classification: expect.stringContaining("Cobrança mantida") } });
    const text = JSON.stringify(closed.body);
    for (const secret of ["Observação interna", "Decisão interna", cantina.uid, admin.uid]) expect(text).not.toContain(secret);
    expect((closed.body.timeline as { kind: string }[]).map((t) => t.kind)).toEqual(["created", "paid", "not_picked_up", "resolved"]);
    const completed = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${student}&group=completed`);
    expect((completed.body.orders as { orderId: string }[]).map((o) => o.orderId)).toContain(orderId);
  });
});
