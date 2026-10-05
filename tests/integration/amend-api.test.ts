// Reagendamento/antecipação e troca de produtos (F16) contra Auth/Firestore Emulator. Reagendar: libera reserva/cota/uso da
// origem e reserva/compromete no destino (calendário, janela, cardápio, cota e limites do aluno) na MESMA transação, sem nova
// cobrança e com os preços do pedido; horário encerrado só com a exceção operacional explícita da equipe. Troca: só unidades
// remanescentes, crédito = valor PAGO do que sai, cobrança = preço atual do que entra e SÓ a diferença na carteira original.
// Replay, clique duplo, resposta perdida, autorização revogada, falha intermediária e corridas com entrega, cancelamento, outra
// troca e outro reagendamento (A11/A22/A24/A35). Pedidos reais nascem do checkout real; o saldo vem SÓ de fixture do emulador.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
type Result = { status: number; body: Json };
type Item = { lineNo: number; productId: string; quantity: number; deliveredQty?: number; canceledQty?: number; exchangedQty?: number; reservationId: string; subtotalCents: number; unitPriceCents: number; exchange?: { exchangeId: string } };

let placeAdvanceOrders: typeof import("@/modules/orders/commands").placeAdvanceOrders;
let rescheduleOrder: typeof import("@/modules/orders/amend").rescheduleOrder;
let exchangeItems: typeof import("@/modules/orders/amend").exchangeItems;
let quoteExchange: typeof import("@/modules/orders/amend").quoteExchange;
let cancelOrder: typeof import("@/modules/orders/cancellation").cancelOrder;
let commandErrorResponse: typeof import("@/modules/access/command-route").commandErrorResponse;
let receiptsRoute: Handler;
let capacityRoute: Handler;
let reconcileRoute: Handler;
let deliverRoute: Handler;
let notPickedUpRoute: Handler;
let resolveRoute: Handler;
let rescheduleRoute: Handler;
let exchangeRoute: Handler;
let quoteRoute: Handler;
let optionsRoute: Handler;
let detailRoute: Handler;
let statementRoute: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let checkLedger: typeof import("@/modules/wallet/model").checkLedger;
let parseWalletState: typeof import("@/modules/wallet/model").parseWalletState;
let school: typeof import("@/lib/dates/school-time");

let admin: TestUser;
let guardianA: TestUser;
let cantina: TestUser;
let secretaria: TestUser;

const tag = randomUUID().slice(0, 6);
const ST = `sha_${tag}_t`;
const SM = `sha_${tag}_m`;
const CLS = `cla_${tag}`;
const CAT = `caa_${tag}`;
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
  ({ rescheduleOrder, exchangeItems, quoteExchange } = await import("@/modules/orders/amend"));
  ({ cancelOrder } = await import("@/modules/orders/cancellation"));
  ({ commandErrorResponse } = await import("@/modules/access/command-route"));
  receiptsRoute = (await import("@/app/api/inventory/receipts/route")).POST as unknown as Handler;
  capacityRoute = (await import("@/app/api/inventory/capacity/route")).POST as unknown as Handler;
  reconcileRoute = (await import("@/app/api/inventory/reconcile/route")).GET as unknown as Handler;
  deliverRoute = (await import("@/app/api/operations/orders/[id]/deliver/route")).POST as unknown as Handler;
  notPickedUpRoute = (await import("@/app/api/operations/orders/[id]/not-picked-up/route")).POST as unknown as Handler;
  resolveRoute = (await import("@/app/api/operations/orders/[id]/resolve/route")).POST as unknown as Handler;
  rescheduleRoute = (await import("@/app/api/operations/orders/[id]/reschedule/route")).POST as unknown as Handler;
  exchangeRoute = (await import("@/app/api/operations/orders/[id]/exchange/route")).POST as unknown as Handler;
  quoteRoute = (await import("@/app/api/operations/orders/[id]/exchange/quote/route")).POST as unknown as Handler;
  optionsRoute = (await import("@/app/api/operations/orders/[id]/amend-options/route")).GET as unknown as Handler;
  detailRoute = (await import("@/app/api/orders/[id]/route")).GET as unknown as Handler;
  statementRoute = (await import("@/app/api/wallets/entries/route")).GET as unknown as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ checkLedger, parseWalletState } = await import("@/modules/wallet/model"));
  school = await import("@/lib/dates/school-time");
  BASE = school.localDateOf(new Date());
  NOW = school.localInstant(BASE, "09:00");
  [admin, guardianA, cantina, secretaria] = await Promise.all([
    createTestUser("aadm", "admin"),
    createTestUser("aresp", "guardian"),
    createTestUser("acant", "cantina"),
    createTestUser("asec", "secretaria"),
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
type Role = "guardian" | "cantina" | "admin";
const actorOf = (user: TestUser, role: Role = "guardian") => ({ uid: user.uid, role, permissions: [] as never[] });

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

type Line = { productId: string; quantity?: number };
function cart(studentId: string, days: Record<string, Line[]>, confirmed = false) {
  return {
    key: randomUUID(),
    studentId,
    expectedShiftId: ST,
    confirmed,
    days: Object.entries(days).map(([date, lines]) => ({ date, lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity ?? 1, expectedPriceCents: prices.get(l.productId)! })) })),
  };
}

async function newStudent(over: { cents?: number; daily?: number; weekly?: number; blocked?: string[] } = {}) {
  const id = `stu_${tag}_${++seq}`;
  await seedStudentAccess({ studentId: id, name: `Aluno ${seq}`, guardianUids: [guardianA.uid], allowSitePurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name: `Aluno ${seq}`, status: "active", userUid: null, shiftId: ST, classId: CLS, version: 3 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, {
    allowSitePurchase: true,
    allowCounterPurchase: false,
    configVersion: 1,
    ...(over.daily !== undefined ? { dailyLimitCents: over.daily } : {}),
    ...(over.weekly !== undefined ? { weeklyLimitCents: over.weekly } : {}),
    ...(over.blocked ? { blockedProductIds: over.blocked } : {}),
  });
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
    const r = await call(capacityRoute, admin, "POST", "/api/inventory/capacity", { key: randomUUID(), productId: id, date, shiftId: ST, capacity });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return id;
}

/** Pedido real pelo checkout do site (relógio 09:00 de hoje, turno da tarde). `date` padrão: hoje+3. */
async function placeOrder(lines: Line[], over: { student?: string; date?: string; confirmed?: boolean } = {}) {
  const student = over.student ?? (await newStudent());
  const r = await viaCommand(() => placeAdvanceOrders(db(), actorOf(guardianA), cart(student, { [over.date ?? d(3)]: lines }, over.confirmed), () => NOW));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const orderId = (r.body.orders as { orderId: string }[])[0]!.orderId;
  return { student, orderId };
}
const orderOf = async (orderId: string) => (await doc(`orders/${orderId}`))!;
const itemsOf = async (orderId: string) => (await orderOf(orderId)).items as Item[];

type ReschedBody = { key?: string; toDate?: string; toShiftId?: string; reason?: string; overrideCutoff?: boolean; exceptionId?: string };
const reschedAs = (user: TestUser, role: Role, orderId: string, b: ReschedBody = {}, clock: () => Date = () => NOW) =>
  viaCommand(() => rescheduleOrder(db(), actorOf(user, role), { key: randomUUID(), toShiftId: ST, reason: "Aluno comprou para a data errada", ...b, orderId }, clock));
const reschedHttp = (user: TestUser | null, orderId: string, b: ReschedBody = {}) =>
  call(rescheduleRoute, user, "POST", `/api/operations/orders/${orderId}/reschedule`, { key: randomUUID(), toShiftId: ST, reason: "Aluno comprou para a data errada", ...b }, orderId);

type Swap = { remove: { lineNo: number; quantity: number }[]; add: { productId: string; quantity: number }[] };
const swapBody = (s: Swap) => ({ remove: s.remove, add: s.add.map((a) => ({ ...a, expectedPriceCents: prices.get(a.productId)! })) });
const quoteAs = (user: TestUser, role: Role, orderId: string, s: Swap, clock: () => Date = () => NOW) => viaCommand(() => quoteExchange(db(), actorOf(user, role), { ...swapBody(s), orderId }, clock));
const exchangeAs = (user: TestUser, role: Role, orderId: string, s: Swap, diff: number, b: { key?: string; overrideCutoff?: boolean; exceptionId?: string } = {}, clock: () => Date = () => NOW) =>
  viaCommand(() => exchangeItems(db(), actorOf(user, role), { key: randomUUID(), reason: "Aluno pediu outro produto", expectedDifferenceCents: diff, ...b, ...swapBody(s), orderId }, clock));

const deliver = (user: TestUser | null, orderId: string, studentId: string, lines: { lineNo: number; quantity: number }[]) =>
  call(deliverRoute, user, "POST", `/api/operations/orders/${orderId}/deliver`, { key: randomUUID(), studentId, lines }, orderId);
const cancelAs = (user: TestUser, role: Role, orderId: string, b: { lines?: { lineNo: number; quantity: number }[] } = {}) =>
  viaCommand(() => cancelOrder(db(), actorOf(user, role), { key: randomUUID(), reason: "Mudança de planos da família", ...b, orderId }, () => NOW));

const usageOf = async (studentId: string, date: string) => Number((await doc(`studentUsage/${studentId}/days/${date}`))?.committedCents ?? 0);
const weekOf = async (studentId: string, date: string) => Number((await doc(`studentUsage/${studentId}/weeks/${school.weekStartOf(date)}`))?.committedCents ?? 0);
const reservationsOf = async (productId: string, orderId: string) =>
  (await db().collection(`stockBalances/${productId}/reservations`).where("orderRef", "==", orderId).get()).docs.map((x) => ({ id: x.id, ...(x.data() as { consumptionDate: string; quantity: number; deliveredQty: number; releasedQty: number; status: string }) }));
const activeUnits = async (productId: string, orderId: string) => (await reservationsOf(productId, orderId)).reduce((n, r) => n + r.quantity - r.deliveredQty - r.releasedQty, 0);
const reservedOn = async (productId: string, date: string) => Number(((await doc(`stockBalances/${productId}`))?.reservedByDate as Record<string, number> | undefined)?.[date] ?? 0);
const entriesOf = async (studentId: string, type?: string) => {
  const col = db().collection(`wallets/${studentId}/entries`);
  return (await (type ? col.where("type", "==", type) : col).get()).docs.map((x) => x.data());
};

async function wallet(studentId: string) {
  const w = await doc(`wallets/${studentId}`);
  return { balanceCents: Number(w?.balanceCents ?? 0), version: Number(w?.version ?? 0), entries: (await entriesOf(studentId)).length };
}
async function expectLedger(studentId: string) {
  const w = parseWalletState(await doc(`wallets/${studentId}`));
  const rows = (await db().collection(`wallets/${studentId}/entries`).orderBy("seq").get()).docs.map((x) => x.data() as { seq: number; amountCents: number; balanceAfterCents: number });
  expect(checkLedger(w, rows)).toEqual([]);
}
async function expectStock(productId: string) {
  const r = await call(reconcileRoute, admin, "GET", `/api/inventory/reconcile?productId=${productId}`);
  expect((r.body.products as { problems: string[] }[])[0]!.problems).toEqual([]);
}
/** Estado comparável do aluno/produtos: tudo que um comando recusado NÃO pode mudar. */
async function state(studentId: string, productIds: string[], dates: string[]) {
  const out: Record<string, unknown> = { wallet: await wallet(studentId) };
  for (const date of dates) out[`usage:${date}`] = [await usageOf(studentId, date), await weekOf(studentId, date)];
  for (const p of productIds) {
    const b = await doc(`stockBalances/${p}`);
    out[`stock:${p}`] = { onHand: b?.onHand, reservedByDate: b?.reservedByDate, reservations: (await db().collection(`stockBalances/${p}/reservations`).get()).size };
  }
  return out;
}
/**
 * Conservação do dinheiro do pedido: total LÍQUIDO = Σ subtotais − Σ créditos das trocas, e o saldo do aluno = início − Σ
 * débitos do pedido + Σ créditos (livro). O restante a liquidar de cada linha nunca é negativo.
 */
async function expectOrderMoney(orderId: string) {
  const o = await orderOf(orderId);
  const items = o.items as Item[];
  const credits = (await db().collection(`orders/${orderId}/exchanges`).get()).docs.reduce((n, x) => n + Number(x.get("creditCents")), 0);
  expect(Number(o.totalCents)).toBe(items.reduce((n, i) => n + i.subtotalCents, 0) - credits);
  const ledger = (await entriesOf(String(o.studentId))).filter((e) => e.orderId === orderId).reduce((n, e) => n + Number(e.amountCents), 0);
  expect(0 - ledger).toBe(Number(o.totalCents) - Number(o.refundedCents ?? 0));
  for (const i of items) expect(i.quantity - (i.deliveredQty ?? 0) - (i.canceledQty ?? 0) - (i.exchangedQty ?? 0)).toBeGreaterThanOrEqual(0);
}

/* ---------------------------------------------------------------------------------------------- reagendar */

describe("reagendar: libera a origem, valida o destino e preserva pagamento/preço (A24)", () => {
  it("move o restante para outra data: reserva e uso saem da origem e entram no destino; carteira e livro intactos; evento e auditoria", async () => {
    const a = await newProduct({ price: 600, stock: 50 });
    const b = await newProduct({ price: 250, stock: 50 });
    const { student, orderId } = await placeOrder([{ productId: a, quantity: 2 }, { productId: b }]);
    const before = await wallet(student);
    expect([await usageOf(student, d(3)), await reservedOn(a, d(3))]).toEqual([1450, 2]);
    // Preço do cadastro muda depois da compra: o pedido reagendado mantém o preço contratado.
    await db().doc(`products/${a}`).update({ priceCents: 900, priceVersion: 2 });

    const key = randomUUID();
    const r = await reschedAs(cantina, "cantina", orderId, { key, toDate: d(5) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, status: "paid", from: { date: d(3), shiftId: ST }, to: { date: d(5), shiftId: ST }, movedUnits: 3, cutoffOverride: false, charged: 0, version: 2 });

    expect(await wallet(student)).toEqual(before); // sem segunda cobrança, sem lançamento
    expect([await usageOf(student, d(3)), await usageOf(student, d(5))]).toEqual([0, 1450]);
    expect([await reservedOn(a, d(3)), await reservedOn(a, d(5)), await reservedOn(b, d(5))]).toEqual([0, 2, 1]);
    expect(await activeUnits(a, orderId)).toBe(2);
    const o = await orderOf(orderId);
    expect(o).toMatchObject({ consumptionDate: d(5), shiftId: ST, totalCents: 1450, status: "paid", rescheduleCount: 1, originalConsumptionDate: d(3), version: 2 });
    expect((o.items as Item[]).map((i) => [i.unitPriceCents, i.subtotalCents])).toEqual([[600, 1200], [250, 250]]);
    expect((o.policy.cancelCutoffAt as { toDate(): Date }).toDate().toISOString()).toBe(school.localInstant(d(5), "15:00").toISOString());
    const events = (await db().collection(`orders/${orderId}/reschedules`).get()).docs.map((x) => x.data());
    expect(events).toEqual([expect.objectContaining({ kind: "operational", from: { date: d(3), shiftId: ST }, to: { date: d(5), shiftId: ST }, movedUnits: 3, movedCents: 1450, cutoffOverride: false, actorUid: cantina.uid, reason: "Aluno comprou para a data errada" })]);
    expect(await doc(`auditLog/${cantina.uid}__orders.reschedule__${key}`)).toMatchObject({ action: "orders.reschedule", reason: "Aluno comprou para a data errada", before: { consumptionDate: d(3) }, after: { consumptionDate: d(5), charged: 0 } });
    await expectStock(a);
    await expectStock(b);
    await expectLedger(student);

    // A família vê a nova data e o reagendamento, sem motivo/ator internos; o recibo continua o do pagamento original.
    const detail = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(detail.body).toMatchObject({ consumptionDate: d(5), totalCents: 1450, reschedules: [{ fromDate: d(3), toDate: d(5) }] });
    expect(JSON.stringify(detail.body)).not.toMatch(/Aluno comprou para a data errada|reservation|actorUid/);
  });

  it("a entrega no destino baixa pela reserva NOVA, sem novo débito; o cancelamento depois reembolsa o valor pago e libera o uso do destino", async () => {
    const p = await newProduct({ price: 500, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 3 }], { date: d(2) });
    expect((await reschedAs(cantina, "cantina", orderId, { toDate: BASE })).status).toBe(200); // antecipa para hoje (09:00: antes do fechamento)
    const before = await wallet(student);
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 2 }])).status).toBe(200);
    expect(await wallet(student)).toEqual(before);
    const r = await cancelAs(guardianA, "guardian", orderId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ refundCents: 500, status: "delivered" });
    expect([await usageOf(student, BASE), await usageOf(student, d(2))]).toEqual([1000, 0]);
    expect(await activeUnits(p, orderId)).toBe(0);
    await expectOrderMoney(orderId);
    await expectStock(p);
    await expectLedger(student);
  });

  it("horário de compra do destino encerrado: recusado sem a exceção operacional; com ela, antecipa para hoje e fica auditado", async () => {
    const p = await newProduct({ price: 500, stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p }], { date: d(2) });
    const late = () => school.localInstant(BASE, "15:00"); // fechamento da tarde: 14:00
    const before = await state(student, [p], [BASE, d(2)]);
    const refused = await reschedAs(cantina, "cantina", orderId, { toDate: BASE }, late);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "after_cutoff", details: { overridable: true } });
    expect(await state(student, [p], [BASE, d(2)])).toEqual(before);

    const key = randomUUID();
    const ok = await reschedAs(cantina, "cantina", orderId, { key, toDate: BASE, overrideCutoff: true }, late);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ cutoffOverride: true, to: { date: BASE } });
    expect((await db().collection(`orders/${orderId}/reschedules`).get()).docs[0]!.get("cutoffOverride")).toBe(true);
    expect(await doc(`auditLog/${cantina.uid}__orders.reschedule__${key}`)).toMatchObject({ after: { cutoffOverride: true } });
    // Exceção marcada sem necessidade (destino ainda aberto) não é registrada como usada.
    const other = await placeOrder([{ productId: p }], { date: d(2) });
    const open = await reschedAs(cantina, "cantina", other.orderId, { toDate: d(4), overrideCutoff: true });
    expect(open.body).toMatchObject({ cutoffOverride: false });
  });

  it("o responsável não reagenda (nem com exceção de horário): só a equipe com permissão; secretaria, aluno e anônimo também não", async () => {
    const p = await newProduct({ stock: 10 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    const studentUser = await createTestUser("aalu", "student");
    const before = await state(student, [p], [d(3), d(4)]);
    for (const user of [guardianA, secretaria, studentUser]) expect((await reschedHttp(user, orderId, { toDate: d(4), overrideCutoff: true })).status).toBe(403);
    expect((await reschedHttp(null, orderId, { toDate: d(4) })).status).toBe(401);
    for (const user of [guardianA, secretaria]) {
      expect((await call(optionsRoute, user, "GET", `/api/operations/orders/${orderId}/amend-options`, undefined, orderId)).status).toBe(403);
      expect((await call(quoteRoute, user, "POST", `/api/operations/orders/${orderId}/exchange/quote`, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: p, quantity: 1, expectedPriceCents: 500 }] }, orderId)).status).toBe(403);
    }
    expect(await state(student, [p], [d(3), d(4)])).toEqual(before);
    expect((await reschedHttp(cantina, orderId, { toDate: d(4) })).status).toBe(200);
    expect((await reschedHttp(admin, orderId, { toDate: d(5) })).status).toBe(200);
  });

  it("autorização REVOGADA: operador desativado/rebaixado é negado, inclusive o replay da mesma chave", async () => {
    const p = await newProduct({ stock: 10 });
    const { orderId } = await placeOrder([{ productId: p }]);
    const staff = await createTestUser("arev", "cantina");
    const key = randomUUID();
    expect((await reschedHttp(staff, orderId, { key, toDate: d(4) })).status).toBe(200);
    await db().doc(`users/${staff.uid}`).update({ status: "disabled" });
    expect((await reschedHttp(staff, orderId, { key, toDate: d(4) })).status).toBe(403);
    await db().doc(`users/${staff.uid}`).update({ status: "active", role: "secretaria" });
    expect((await reschedHttp(staff, orderId, { key, toDate: d(4) })).status).toBe(403);
    expect((await reschedHttp(staff, orderId, { toDate: d(5) })).status).toBe(403);
    expect(await orderOf(orderId)).toMatchObject({ consumptionDate: d(4), version: 2 });
  });

  it("destino inválido não muda nada: dia fechado, fora da janela, mesma data, outro turno, produto fora do cardápio, aluno inativo", async () => {
    const p = await newProduct({ stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    const before = await state(student, [p], [d(3), d(6), d(8)]);
    await db().doc(`calendarDays/${d(6)}`).set({ kind: "closed" });
    try {
      expect((await reschedAs(cantina, "cantina", orderId, { toDate: d(6) })).body.error).toBe("non_operating_day");
    } finally {
      await db().doc(`calendarDays/${d(6)}`).set({ kind: "extra" });
    }
    expect((await reschedAs(cantina, "cantina", orderId, { toDate: d(8) })).body.error).toBe("beyond_window");
    expect((await reschedAs(cantina, "cantina", orderId, { toDate: d(3) })).body.error).toBe("same_destination");
    expect((await reschedAs(cantina, "cantina", orderId, { toDate: d(4), toShiftId: SM })).body).toMatchObject({ error: "shift_changed", details: { shiftId: ST } });
    await db().doc(`products/${p}`).update({ channels: ["counter"] });
    expect((await reschedAs(cantina, "cantina", orderId, { toDate: d(4) })).body.error).toBe("item_unavailable");
    await db().doc(`products/${p}`).update({ channels: ["advance", "counter"] });
    await db().doc(`students/${student}`).update({ status: "inactive" });
    expect((await reschedAs(cantina, "cantina", orderId, { toDate: d(4) })).body.error).toBe("student_inactive");
    await db().doc(`students/${student}`).update({ status: "active" });
    expect(await state(student, [p], [d(3), d(6), d(8)])).toEqual(before);
    expect(await orderOf(orderId)).toMatchObject({ consumptionDate: d(3), version: 1 });
  });

  it("cota do destino: produto planejado sem vaga no destino é recusado; com vaga, a cota da origem volta e a do destino sobe", async () => {
    const p = await newProduct({ price: 700, mode: "planned", capacity: { [d(3)]: 5, [d(4)]: 1, [d(5)]: 4 } });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    const before = await state(student, [p], [d(3), d(4)]);
    const r = await reschedAs(cantina, "cantina", orderId, { toDate: d(4) });
    expect(r.body).toMatchObject({ error: "capacity_exceeded", details: { limit: 1, available: 1 } });
    expect(await state(student, [p], [d(3), d(4)])).toEqual(before);
    expect((await reschedAs(cantina, "cantina", orderId, { toDate: d(5) })).status).toBe(200);
    const cap = async (date: string) => (await doc(`dailyCapacity/${p}_${date}_${ST}`))?.reserved;
    expect([await cap(d(3)), await cap(d(5))]).toEqual([0, 2]);
  });

  it("A11: limites do DESTINO revalidados — R$ 8 já no destino com teto R$ 10 recusa R$ 5; exceção administrativa cobre e fica usada", async () => {
    const p8 = await newProduct({ price: 800, stock: 20 });
    const p5 = await newProduct({ price: 500, stock: 20 });
    const student = await newStudent({ daily: 1000 });
    await placeOrder([{ productId: p8 }], { student, date: d(4) });
    const { orderId } = await placeOrder([{ productId: p5 }], { student, date: d(3) });
    const r = await reschedAs(cantina, "cantina", orderId, { toDate: d(4) });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "policy_denied", details: { violations: [{ kind: "daily_limit_exceeded", date: d(4), limitCents: 1000, committedCents: 800, requestedCents: 500 }] } });
    expect([await usageOf(student, d(3)), await usageOf(student, d(4))]).toEqual([500, 800]);

    const ex = `exa_${tag}_${++seq}`;
    await writeDemoDoc(targetFromEnv(), `studentPolicies/${student}/exceptions/${ex}`, { studentId: student, kind: "admin", status: "active", consumptionDate: d(4), maxCents: 500 });
    const ok = await reschedAs(cantina, "cantina", orderId, { toDate: d(4), exceptionId: ex });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect([await usageOf(student, d(3)), await usageOf(student, d(4))]).toEqual([0, 1300]);
    expect(await doc(`studentPolicies/${student}/exceptions/${ex}`)).toMatchObject({ status: "used", usedBy: cantina.uid, usedFor: orderId });
  });

  it("semana do consumo: mover dentro da MESMA semana com o teto semanal cheio passa (a origem sai antes de avaliar) e grava o uso semanal uma vez", async () => {
    const pair = [1, 2, 3, 4, 5, 6, 7].flatMap((i) => [1, 2, 3, 4, 5, 6, 7].filter((j) => j > i && school.weekStartOf(d(i)) === school.weekStartOf(d(j))).map((j) => [i, j] as const))[0]!;
    const [i, j] = pair;
    const p8 = await newProduct({ price: 800, stock: 20 });
    const p5 = await newProduct({ price: 500, stock: 20 });
    const student = await newStudent({ weekly: 1300 });
    await placeOrder([{ productId: p8 }], { student, date: d(i) });
    const { orderId } = await placeOrder([{ productId: p5 }], { student, date: d(j) });
    expect(await weekOf(student, d(i))).toBe(1300);
    const r = await reschedAs(cantina, "cantina", orderId, { toDate: d(i) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([await usageOf(student, d(i)), await usageOf(student, d(j)), await weekOf(student, d(i))]).toEqual([1300, 0, 1300]);
  });

  it("situações que não reagendam pelo comando comum: parte entregue, entregue, cancelado, não retirado e data passada (cantina)", async () => {
    const p = await newProduct({ stock: 40 });
    const partial = await placeOrder([{ productId: p, quantity: 2 }], { date: BASE });
    expect((await deliver(cantina, partial.orderId, partial.student, [{ lineNo: 1, quantity: 1 }])).status).toBe(200);
    expect((await reschedAs(cantina, "cantina", partial.orderId, { toDate: d(2) })).body.error).toBe("partially_delivered");
    expect((await deliver(cantina, partial.orderId, partial.student, [{ lineNo: 1, quantity: 1 }])).status).toBe(200);
    expect((await reschedAs(cantina, "cantina", partial.orderId, { toDate: d(2) })).body.error).toBe("already_delivered");
    const cancelled = await placeOrder([{ productId: p }]);
    expect((await cancelAs(guardianA, "guardian", cancelled.orderId)).status).toBe(200);
    expect((await reschedAs(cantina, "cantina", cancelled.orderId, { toDate: d(4) })).body.error).toBe("already_cancelled");
    const missed = await placeOrder([{ productId: p }], { date: BASE });
    expect((await call(notPickedUpRoute, cantina, "POST", `/api/operations/orders/${missed.orderId}/not-picked-up`, { key: randomUUID(), reason: "Aluno faltou hoje" }, missed.orderId)).status).toBe(200);
    expect((await reschedAs(cantina, "cantina", missed.orderId, { toDate: d(2) })).body.error).toBe("use_resolution");
    // Pedido de ontem (relógio no dia seguinte) sem entrega: a cantina não reagenda direto; a administração pode.
    const past = await placeOrder([{ productId: p }], { date: d(1) });
    const tomorrow = () => school.localInstant(d(2), "09:00");
    expect((await reschedAs(cantina, "cantina", past.orderId, { toDate: d(3) }, tomorrow)).body.error).toBe("past_date_requires_resolution");
    const ok = await reschedAs(admin, "admin", past.orderId, { toDate: d(3) }, tomorrow);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await expectStock(p);
  });

  it("não retirado: a administração resolve REAGENDANDO (sem cobrança), a cantina não; parte entregue não é reagendada", async () => {
    const p = await newProduct({ price: 450, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }], { date: BASE });
    expect((await call(notPickedUpRoute, cantina, "POST", `/api/operations/orders/${orderId}/not-picked-up`, { key: randomUUID(), reason: "Aluno faltou hoje" }, orderId)).status).toBe(200);
    const before = await wallet(student);
    const body = { key: randomUUID(), resolution: "reschedule", reason: "Família pediu para amanhã", toDate: d(1), toShiftId: ST };
    expect((await call(resolveRoute, cantina, "POST", `/api/operations/orders/${orderId}/resolve`, body, orderId)).status).toBe(403);
    expect((await call(resolveRoute, admin, "POST", `/api/operations/orders/${orderId}/resolve`, { ...body, discards: [{ lineNo: 1, quantity: 1 }] }, orderId)).status).toBe(400);
    const r = await call(resolveRoute, admin, "POST", `/api/operations/orders/${orderId}/resolve`, body, orderId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ resolution: "reschedule", classification: null, refundCents: 0, retainedCents: 0, wallet: null, status: "paid", rescheduledTo: { date: d(1), shiftId: ST } });
    expect(await wallet(student)).toEqual(before);
    expect(await orderOf(orderId)).toMatchObject({ status: "paid", consumptionDate: d(1), nonPickup: { resolution: { kind: "reschedule", to: { date: d(1) } } } });
    expect([await usageOf(student, BASE), await usageOf(student, d(1))]).toEqual([0, 900]);
    expect((await db().collection(`orders/${orderId}/reschedules`).get()).docs[0]!.get("kind")).toBe("not_picked_up");
    // Repetir a resolução não move de novo.
    expect((await call(resolveRoute, admin, "POST", `/api/operations/orders/${orderId}/resolve`, { ...body, key: randomUUID() }, orderId)).body.error).toBe("already_resolved");
    // Família vê "reagendado" (sem cobrança).
    const detail = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(detail.body).toMatchObject({ nonPickup: { resolved: true, kind: "reschedule" }, reschedules: [{ fromDate: BASE, toDate: d(1) }] });

    const partial = await placeOrder([{ productId: p, quantity: 2 }], { date: BASE });
    expect((await deliver(cantina, partial.orderId, partial.student, [{ lineNo: 1, quantity: 1 }])).status).toBe(200);
    expect((await call(notPickedUpRoute, cantina, "POST", `/api/operations/orders/${partial.orderId}/not-picked-up`, { key: randomUUID(), reason: "Não voltou" }, partial.orderId)).status).toBe(200);
    expect((await call(resolveRoute, admin, "POST", `/api/operations/orders/${partial.orderId}/resolve`, { ...body, key: randomUUID() }, partial.orderId)).body.error).toBe("partially_delivered");
    await expectStock(p);
  });
});

describe("reagendar: replay, clique duplo, resposta perdida e falha intermediária (A35)", () => {
  it("mesma chave devolve a resposta original sem mover de novo; payload diferente conflita; outra chave para o mesmo destino recusa", async () => {
    const p = await newProduct({ stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    const key = randomUUID();
    const first = await reschedHttp(cantina, orderId, { key, toDate: d(4) });
    const lost = await reschedHttp(cantina, orderId, { key, toDate: d(4) }); // resposta perdida: o cliente repete o MESMO envio
    expect(first.status).toBe(200);
    expect(lost.body).toMatchObject({ replayed: true, rescheduleId: first.body.rescheduleId, to: { date: d(4) } });
    expect((await reschedHttp(cantina, orderId, { key, toDate: d(5) })).body.error).toBe("idempotency_conflict");
    expect((await reschedHttp(cantina, orderId, { toDate: d(4) })).body.error).toBe("same_destination"); // clique duplo com chave nova
    expect((await reservationsOf(p, orderId)).length).toBe(2); // original (liberada) + destino
    expect([await usageOf(student, d(3)), await usageOf(student, d(4))]).toEqual([0, 1000]);
    expect(await orderOf(orderId)).toMatchObject({ rescheduleCount: 1, version: 2 });
  });

  it("falha no ÚLTIMO passo (auditoria) depois de planejar tudo: nada persiste; o retry com a mesma chave move uma vez só", async () => {
    const p = await newProduct({ stock: 20 });
    const { student, orderId } = await placeOrder([{ productId: p }]);
    const key = randomUUID();
    const auditId = `${cantina.uid}__orders.reschedule__${key}`;
    await db().doc(`auditLog/${auditId}`).set({ action: "bloqueio-de-teste" });
    const before = await state(student, [p], [d(3), d(4)]);
    const failed = await reschedAs(cantina, "cantina", orderId, { key, toDate: d(4) });
    expect(failed.status).toBe(500);
    expect(await state(student, [p], [d(3), d(4)])).toEqual(before);
    expect(await orderOf(orderId)).toMatchObject({ consumptionDate: d(3), version: 1 });
    expect((await db().collection(`orders/${orderId}/reschedules`).get()).size).toBe(0);
    expect(await doc(`idempotencyRecords/${cantina.uid}__orders.reschedule__${key}`)).toBeUndefined();
    await db().doc(`auditLog/${auditId}`).delete();
    expect((await reschedAs(cantina, "cantina", orderId, { key, toDate: d(4) })).status).toBe(200);
    expect([await usageOf(student, d(3)), await usageOf(student, d(4))]).toEqual([0, 500]);
  });

  it("falha intermediária no ESTOQUE do destino (sem unidade física válida na data): reserva e uso da origem ficam intactos", async () => {
    const p = await newProduct({ stock: 2 });
    const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
    // O lastro físico some (perda externa sem baixa registrada): o destino não tem unidade válida para reservar.
    await db().doc(`stockBalances/${p}`).update({ supplyByValidity: {} });
    const before = await state(student, [p], [d(3), d(4)]);
    const r = await reschedAs(cantina, "cantina", orderId, { toDate: d(4) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("insufficient_stock");
    expect(await state(student, [p], [d(3), d(4)])).toEqual(before);
    expect(await orderOf(orderId)).toMatchObject({ consumptionDate: d(3), version: 1 });
  });
});

describe("reagendar: corridas com entrega, cancelamento, troca e outro reagendamento (A35)", () => {
  it("ENTREGA × REAGENDAMENTO do pedido de hoje (6 pedidos, ao mesmo tempo): exatamente um vence e uso/estoque ficam coerentes", async () => {
    const products = await Promise.all(Array.from({ length: 6 }, () => newProduct({ price: 500, stock: 10 })));
    const orders = await Promise.all(products.map((product) => placeOrder([{ productId: product }], { date: BASE })));
    const results = await Promise.all(orders.flatMap((o, i) => (i % 2 === 0 ? [deliver(cantina, o.orderId, o.student, [{ lineNo: 1, quantity: 1 }]), reschedAs(cantina, "cantina", o.orderId, { toDate: d(2) })] : [reschedAs(cantina, "cantina", o.orderId, { toDate: d(2) }), deliver(cantina, o.orderId, o.student, [{ lineNo: 1, quantity: 1 }])])));
    expect(results.filter((r) => r.status === 200).length).toBe(orders.length);
    for (const [i, o] of orders.entries()) {
      const order = await orderOf(o.orderId);
      const exits = (await db().collection(`stockCosts/${products[i]}/movements`).where("type", "==", "sale_exit").get()).size;
      if (order.status === "delivered") expect([order.consumptionDate, exits, await usageOf(o.student, BASE), await usageOf(o.student, d(2))]).toEqual([BASE, 1, 500, 0]);
      else expect([order.status, order.consumptionDate, exits, await usageOf(o.student, BASE), await usageOf(o.student, d(2)), await activeUnits(products[i]!, o.orderId)]).toEqual(["paid", d(2), 0, 0, 500, 1]);
      await expectLedger(o.student);
      await expectStock(products[i]!);
    }
  });

  it("CANCELAMENTO × REAGENDAMENTO: um reembolso no máximo, uso total zero se cancelado, reserva ativa = restante", async () => {
    const p = await newProduct({ price: 500, stock: 40 });
    for (let round = 0; round < 4; round++) {
      const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
      await Promise.all([cancelAs(guardianA, "guardian", orderId), reschedAs(cantina, "cantina", orderId, { toDate: d(4) })]);
      const order = await orderOf(orderId);
      const refunds = await entriesOf(student, "order_refund");
      const used = (await usageOf(student, d(3))) + (await usageOf(student, d(4)));
      if (order.status === "cancelled") expect([refunds.length, used, await activeUnits(p, orderId)]).toEqual([1, 0, 0]);
      else expect([order.consumptionDate, refunds.length, used, await activeUnits(p, orderId)]).toEqual([d(4), 0, 1000, 2]);
      await expectOrderMoney(orderId);
      await expectLedger(student);
    }
    await expectStock(p);
  });

  it("DOIS REAGENDAMENTOS simultâneos para destinos diferentes: serializados; o uso fica todo na data final e a reserva ativa é única", async () => {
    const p = await newProduct({ price: 300, stock: 40 });
    for (let round = 0; round < 3; round++) {
      const { student, orderId } = await placeOrder([{ productId: p, quantity: 2 }]);
      const results = await Promise.all([reschedAs(cantina, "cantina", orderId, { toDate: d(4) }), reschedAs(admin, "admin", orderId, { toDate: d(5) })]);
      expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
      const order = await orderOf(orderId);
      expect([d(4), d(5)]).toContain(order.consumptionDate);
      const dates = [d(3), d(4), d(5)];
      const usage = await Promise.all(dates.map((x) => usageOf(student, x)));
      expect(usage).toEqual(dates.map((x) => (x === order.consumptionDate ? 600 : 0)));
      const active = (await reservationsOf(p, orderId)).filter((r) => r.quantity - r.deliveredQty - r.releasedQty > 0);
      expect(active.map((r) => [r.consumptionDate, r.quantity - r.deliveredQty - r.releasedQty])).toEqual([[order.consumptionDate, 2]]);
      expect(Number(order.rescheduleCount)).toBe(results.filter((r) => r.status === 200).length);
    }
    await expectStock(p);
  });

  it("TROCA × REAGENDAMENTO simultâneos: ambos podem vencer em série; dinheiro, uso e reservas sempre coerentes", async () => {
    const a = await newProduct({ price: 500, stock: 40 });
    const b = await newProduct({ price: 700, stock: 40 });
    for (let round = 0; round < 3; round++) {
      const { student, orderId } = await placeOrder([{ productId: a, quantity: 2 }]);
      const results = await Promise.all([reschedAs(cantina, "cantina", orderId, { toDate: d(4) }), exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, 200)]);
      expect(results.some((r) => r.status === 200)).toBe(true);
      const order = await orderOf(orderId);
      const exchanged = (await db().collection(`orders/${orderId}/exchanges`).get()).size === 1;
      const value = exchanged ? 1200 : 1000;
      expect(Number(order.totalCents)).toBe(value);
      expect((await usageOf(student, d(3))) + (await usageOf(student, d(4)))).toBe(value);
      expect(await usageOf(student, order.consumptionDate as string)).toBe(value);
      expect((await activeUnits(a, orderId)) + (await activeUnits(b, orderId))).toBe(2);
      await expectOrderMoney(orderId);
      await expectLedger(student);
    }
    await expectStock(a);
    await expectStock(b);
  });
});

/* ------------------------------------------------------------------------------------------------- trocar */

describe("troca: só a diferença na carteira, só o remanescente (A24/A22)", () => {
  it("1 de 2 R$ 5 por 1 R$ 7: prévia sem efeito, confirmação cobra R$ 2 num lançamento, uso/reserva/pedido/evento/auditoria juntos", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 700, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: a, quantity: 2 }]);
    const swap: Swap = { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] };
    const before = await state(student, [a, b], [d(3)]);
    const quote = await quoteAs(cantina, "cantina", orderId, swap);
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body).toMatchObject({ creditCents: 500, chargeCents: 700, differenceCents: 200, wallet: { sufficient: true }, policy: { allowed: true }, cutoffPassed: false, removed: [{ lineNo: 1, quantity: 1, creditCents: 500 }], added: [{ productId: b, quantity: 1, unitPriceCents: 700 }] });
    expect(await state(student, [a, b], [d(3)])).toEqual(before); // prévia: nada gravado nem reservado

    const key = randomUUID();
    const r = await exchangeAs(cantina, "cantina", orderId, swap, 200, { key });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const w = before.wallet as { balanceCents: number; version: number };
    expect(r.body).toMatchObject({ differenceCents: 200, creditCents: 500, chargeCents: 700, status: "paid", wallet: { studentId: student, balanceCents: w.balanceCents - 200, version: w.version + 1 } });
    expect(await entriesOf(student, "order_exchange")).toEqual([expect.objectContaining({ amountCents: -200, orderId, seq: w.version + 1, balanceAfterCents: w.balanceCents - 200, actorUid: cantina.uid })]);
    const o = await orderOf(orderId);
    expect(o).toMatchObject({ totalCents: 1200, itemCount: 2, exchangeCount: 1, version: 2 });
    expect((o.items as Item[]).map((i) => [i.lineNo, i.productId, i.quantity, i.exchangedQty ?? 0, i.subtotalCents])).toEqual([[1, a, 2, 1, 1000], [2, b, 1, 0, 700]]);
    expect([await usageOf(student, d(3)), await activeUnits(a, orderId), await activeUnits(b, orderId)]).toEqual([1200, 1, 1]);
    expect((await db().collection(`orders/${orderId}/exchanges`).get()).docs.map((x) => x.data())).toEqual([expect.objectContaining({ creditCents: 500, chargeCents: 700, differenceCents: 200, reason: "Aluno pediu outro produto", actorUid: cantina.uid })]);
    expect(await doc(`auditLog/${cantina.uid}__orders.exchange__${key}`)).toMatchObject({ action: "orders.exchange", after: { differenceCents: 200, totalCents: 1200 } });
    await expectOrderMoney(orderId);
    await expectLedger(student);
    await expectStock(a);
    await expectStock(b);

    // Família: linha trocada, troca com a diferença e o extrato com o lançamento da troca.
    const detail = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(detail.body).toMatchObject({ totalCents: 1200, exchanges: [{ differenceCents: 200, removed: [{ quantity: 1 }], added: [{ quantity: 1, subtotalCents: 700 }] }] });
    expect((detail.body.items as { exchangedQty: number; fromExchange: boolean }[]).map((i) => [i.exchangedQty, i.fromExchange])).toEqual([[1, false], [0, true]]);
    const statement = await call(statementRoute, guardianA, "GET", `/api/wallets/entries?studentId=${student}&type=order_exchange`);
    expect(statement.status, JSON.stringify(statement.body)).toBe(200);
    expect((statement.body.entries as { amountCents: number }[]).map((e) => e.amountCents)).toEqual([-200]);
  });

  it("diferença negativa devolve à carteira ORIGINAL; diferença zero não cria lançamento; o cancelamento depois devolve o valor pago do item novo", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const c = await newProduct({ price: 300, stock: 30 });
    const e = await newProduct({ price: 500, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: a, quantity: 2 }]);
    const start = await wallet(student);
    expect((await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: c, quantity: 1 }] }, -200)).body).toMatchObject({ differenceCents: -200, wallet: { balanceCents: start.balanceCents + 200 } });
    const zero = await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: e, quantity: 1 }] }, 0);
    expect(zero.body).toMatchObject({ differenceCents: 0, wallet: null });
    expect((await entriesOf(student, "order_exchange")).map((x) => x.amountCents)).toEqual([200]);
    expect(await orderOf(orderId)).toMatchObject({ totalCents: 800, exchangeCount: 2 });
    const cancel = await cancelAs(guardianA, "guardian", orderId);
    expect(cancel.body).toMatchObject({ refundCents: 800, status: "cancelled" });
    expect(await wallet(student)).toMatchObject({ balanceCents: start.balanceCents + 1000 });
    expect(await usageOf(student, d(3))).toBe(0);
    await expectOrderMoney(orderId);
    await expectLedger(student);
    for (const p of [a, c, e]) await expectStock(p);
  });

  it("só o REMANESCENTE: com 1 de 2 entregue, trocar 2 é recusado; trocar 1 preserva a entrega; total líquido = entregue + restante", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 400, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: a, quantity: 2 }], { date: BASE });
    expect((await deliver(cantina, orderId, student, [{ lineNo: 1, quantity: 1 }])).status).toBe(200);
    const swap2: Swap = { remove: [{ lineNo: 1, quantity: 2 }], add: [{ productId: b, quantity: 1 }] };
    expect((await quoteAs(cantina, "cantina", orderId, swap2)).body).toMatchObject({ error: "quantity_exceeds_remaining", details: { remaining: 1 } });
    expect((await exchangeAs(cantina, "cantina", orderId, swap2, -100)).body.error).toBe("quantity_exceeds_remaining");
    const r = await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, -100);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "partially_delivered" });
    const items = await itemsOf(orderId);
    expect(items.map((i) => [i.deliveredQty ?? 0, i.exchangedQty ?? 0])).toEqual([[1, 1], [0, 0]]);
    expect((await db().collection(`orders/${orderId}/deliveries`).get()).size).toBe(1); // entrega anterior intocada
    expect((await deliver(cantina, orderId, student, [{ lineNo: 2, quantity: 1 }])).body).toMatchObject({ status: "delivered" });
    expect((await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 2, quantity: 1 }], add: [{ productId: a, quantity: 1 }] }, 100)).body.error).toBe("already_delivered");
    expect(await orderOf(orderId)).toMatchObject({ totalCents: 900 });
    const revenue = (await db().collection(`stockCosts/${a}/movements`).where("referenceId", "==", orderId).get()).docs.concat((await db().collection(`stockCosts/${b}/movements`).where("referenceId", "==", orderId).get()).docs).reduce((n, x) => n + Number(x.get("revenueCents") ?? 0), 0);
    expect(revenue).toBe(900); // receita entregue = valor líquido pago
    await expectOrderMoney(orderId);
    await expectLedger(student);
  });

  it("saldo insuficiente para a diferença: recusado sem efeito parcial (carteira, livro, reserva, uso e pedido intactos)", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 900, stock: 30 });
    const student = await newStudent({ cents: 600 });
    const { orderId } = await placeOrder([{ productId: a }], { student });
    const before = await state(student, [a, b], [d(3)]);
    const quote = await quoteAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] });
    expect(quote.body).toMatchObject({ differenceCents: 400, wallet: { balanceCents: 100, sufficient: false } });
    const r = await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, 400);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "insufficient_balance", details: { balanceCents: 100, requiredCents: 400 } });
    expect(await state(student, [a, b], [d(3)])).toEqual(before);
    expect(await orderOf(orderId)).toMatchObject({ totalCents: 500, version: 1 });
    expect((await db().collection(`orders/${orderId}/exchanges`).get()).size).toBe(0);
  });

  it("diferença calculada no SERVIDOR: valor diferente do confirmado ou preço alterado depois da prévia recusam e devolvem a nova prévia", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 700, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: a }]);
    const swap: Swap = { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] };
    const before = await state(student, [a, b], [d(3)]);
    expect((await exchangeAs(cantina, "cantina", orderId, swap, 0)).body).toMatchObject({ error: "difference_changed", details: { quote: { differenceCents: 200 } } });
    await db().doc(`products/${b}`).update({ priceCents: 800, priceVersion: 2 });
    expect((await exchangeAs(cantina, "cantina", orderId, swap, 200)).body).toMatchObject({ error: "price_changed", details: { changes: [{ productId: b, expectedPriceCents: 700, currentPriceCents: 800 }] } });
    for (const extra of [{ differenceCents: 1 }, { amountCents: 1 }, { studentId: "outro" }]) {
      expect((await call(exchangeRoute, cantina, "POST", `/api/operations/orders/${orderId}/exchange`, { key: randomUUID(), reason: "Aluno pediu outro produto", expectedDifferenceCents: 200, ...swapBody(swap), ...extra }, orderId)).status).toBe(400);
    }
    expect(await state(student, [a, b], [d(3)])).toEqual(before);
  });

  it("política: produto BLOQUEADO não entra e o limite diário vale para o que entra (o que sai é descontado); exceção cobre", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const blocked = await newProduct({ price: 500, stock: 30 });
    const big = await newProduct({ price: 1100, stock: 30 });
    const student = await newStudent({ daily: 1000, blocked: [blocked] });
    const { orderId } = await placeOrder([{ productId: a, quantity: 2 }], { student });
    const q = await quoteAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: blocked, quantity: 1 }] });
    expect(q.body).toMatchObject({ policy: { allowed: false, violations: [{ kind: "product_blocked" }] } });
    expect((await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: blocked, quantity: 1 }] }, 0)).body.error).toBe("policy_denied");
    // R$ 10 comprometidos: trocar 1×R$ 5 por 1×R$ 11 levaria a R$ 16 (> teto R$ 10).
    expect((await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: big, quantity: 1 }] }, 600)).body).toMatchObject({ error: "policy_denied", details: { violations: [{ kind: "daily_limit_exceeded", committedCents: 500, requestedCents: 1100 }] } });
    const ex = `exa_${tag}_${++seq}`;
    await writeDemoDoc(targetFromEnv(), `studentPolicies/${student}/exceptions/${ex}`, { studentId: student, kind: "guardian", status: "active", consumptionDate: d(3), maxCents: 1100 });
    const ok = await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: big, quantity: 1 }] }, 600, { exceptionId: ex });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await usageOf(student, d(3))).toBe(1600);
    expect(await doc(`studentPolicies/${student}/exceptions/${ex}`)).toMatchObject({ status: "used", usedFor: orderId });
  });

  it("horário encerrado no dia: troca só com a exceção operacional explícita; pedido de data passada não é trocado", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 500, stock: 30 });
    const { orderId } = await placeOrder([{ productId: a }], { date: BASE });
    const late = () => school.localInstant(BASE, "15:00");
    const swap: Swap = { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] };
    expect((await quoteAs(cantina, "cantina", orderId, swap, late)).body).toMatchObject({ cutoffPassed: true, differenceCents: 0 });
    expect((await exchangeAs(cantina, "cantina", orderId, swap, 0, {}, late)).body).toMatchObject({ error: "after_cutoff", details: { overridable: true } });
    const key = randomUUID();
    expect((await exchangeAs(cantina, "cantina", orderId, swap, 0, { key, overrideCutoff: true }, late)).status).toBe(200);
    expect(await doc(`auditLog/${cantina.uid}__orders.exchange__${key}`)).toMatchObject({ after: { cutoffOverride: true } });
    const tomorrow = () => school.localInstant(d(1), "09:00");
    expect((await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 2, quantity: 1 }], add: [{ productId: a, quantity: 1 }] }, 0, { overrideCutoff: true }, tomorrow)).body.error).toBe("past_date");
  });

  it("não troca por ele mesmo, linha inexistente, pedido cancelado; responsável não troca", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 500, stock: 30 });
    const { orderId } = await placeOrder([{ productId: a, quantity: 2 }]);
    expect((await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: a, quantity: 1 }] }, 0)).body.error).toBe("same_product");
    expect((await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 9, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, 0)).body.error).toBe("line_not_found");
    expect((await call(exchangeRoute, guardianA, "POST", `/api/operations/orders/${orderId}/exchange`, { key: randomUUID(), reason: "Quero trocar o lanche", expectedDifferenceCents: 0, ...swapBody({ remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }) }, orderId)).status).toBe(403);
    expect((await cancelAs(guardianA, "guardian", orderId)).status).toBe(200);
    expect((await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, 0)).body.error).toBe("already_cancelled");
  });
});

describe("troca: replay, resposta perdida, autorização revogada e falha intermediária (A35)", () => {
  it("mesma chave devolve a resposta sem cobrar de novo; payload diferente conflita; outra chave sobre o mesmo restante recusa", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 700, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: a }]);
    const key = randomUUID();
    const send = (diff: number, k = key) => call(exchangeRoute, cantina, "POST", `/api/operations/orders/${orderId}/exchange`, { key: k, reason: "Aluno pediu outro produto", expectedDifferenceCents: diff, ...swapBody({ remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }) }, orderId);
    const first = await send(200);
    const lost = await send(200);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(lost.body).toMatchObject({ replayed: true, exchangeId: first.body.exchangeId, differenceCents: 200 });
    expect((await send(0)).body.error).toBe("idempotency_conflict");
    expect((await send(200, randomUUID())).body.error).toBe("nothing_remaining"); // clique duplo com chave nova
    expect((await entriesOf(student, "order_exchange")).length).toBe(1);
    await expectLedger(student);
  });

  it("autorização revogada: operador desativado não troca nem repete a troca com a mesma chave", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 300, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: a, quantity: 2 }]);
    const staff = await createTestUser("arevx", "cantina");
    const key = randomUUID();
    const body = (k: string) => ({ key: k, reason: "Aluno pediu outro produto", expectedDifferenceCents: -200, ...swapBody({ remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }) });
    expect((await call(exchangeRoute, staff, "POST", `/api/operations/orders/${orderId}/exchange`, body(key), orderId)).status).toBe(200);
    await db().doc(`users/${staff.uid}`).update({ status: "disabled" });
    expect((await call(exchangeRoute, staff, "POST", `/api/operations/orders/${orderId}/exchange`, body(key), orderId)).status).toBe(403);
    expect((await call(exchangeRoute, staff, "POST", `/api/operations/orders/${orderId}/exchange`, body(randomUUID()), orderId)).status).toBe(403);
    expect((await entriesOf(student, "order_exchange")).length).toBe(1);
  });

  it("falha no ÚLTIMO passo depois de planejar carteira/estoque/uso: nada persiste; o retry cobra uma vez", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const b = await newProduct({ price: 800, stock: 30 });
    const { student, orderId } = await placeOrder([{ productId: a }]);
    const key = randomUUID();
    const auditId = `${cantina.uid}__orders.exchange__${key}`;
    await db().doc(`auditLog/${auditId}`).set({ action: "bloqueio-de-teste" });
    const before = await state(student, [a, b], [d(3)]);
    const swap: Swap = { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] };
    expect((await exchangeAs(cantina, "cantina", orderId, swap, 300, { key })).status).toBe(500);
    expect(await state(student, [a, b], [d(3)])).toEqual(before);
    expect(await orderOf(orderId)).toMatchObject({ totalCents: 500, version: 1 });
    await db().doc(`auditLog/${auditId}`).delete();
    expect((await exchangeAs(cantina, "cantina", orderId, swap, 300, { key })).status).toBe(200);
    expect((await entriesOf(student, "order_exchange")).map((x) => x.amountCents)).toEqual([-300]);
    await expectOrderMoney(orderId);
  });

  it("falha intermediária no ESTOQUE do produto novo (último item reservado por outro pedido): tudo desfeito, inclusive a cobrança", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const scarce = await newProduct({ price: 700, stock: 1 });
    await placeOrder([{ productId: scarce }]); // outro pedido reserva a única unidade
    const { student, orderId } = await placeOrder([{ productId: a }]);
    const before = await state(student, [a, scarce], [d(3)]);
    const r = await exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: scarce, quantity: 1 }] }, 200);
    expect(r.body.error).toBe("insufficient_stock");
    expect(await state(student, [a, scarce], [d(3)])).toEqual(before);
  });
});

describe("troca: corridas com entrega, cancelamento e outra troca (A35)", () => {
  it("TROCA × ENTREGA da última unidade (6 pedidos): a unidade é entregue OU trocada, nunca as duas; dinheiro conserva", async () => {
    const b = await newProduct({ price: 700, stock: 40 });
    const products = await Promise.all(Array.from({ length: 6 }, () => newProduct({ price: 500, stock: 10 })));
    const orders = await Promise.all(products.map((product) => placeOrder([{ productId: product }], { date: BASE })));
    await Promise.all(orders.flatMap((o) => [deliver(cantina, o.orderId, o.student, [{ lineNo: 1, quantity: 1 }]), exchangeAs(admin, "admin", o.orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, 200)]));
    for (const [i, o] of orders.entries()) {
      const items = await itemsOf(o.orderId);
      const first = items[0]!;
      expect((first.deliveredQty ?? 0) + (first.exchangedQty ?? 0)).toBe(1);
      const exchangedOut = (first.exchangedQty ?? 0) === 1;
      expect((await entriesOf(o.student, "order_exchange")).length).toBe(exchangedOut ? 1 : 0);
      expect(await usageOf(o.student, BASE)).toBe(exchangedOut ? 700 : 500);
      await expectOrderMoney(o.orderId);
      await expectLedger(o.student);
      await expectStock(products[i]!);
    }
    await expectStock(b);
  });

  it("TROCA × CANCELAMENTO do restante: nunca reembolsa e credita a troca sobre a mesma unidade", async () => {
    const a = await newProduct({ price: 500, stock: 40 });
    const b = await newProduct({ price: 300, stock: 40 });
    for (let round = 0; round < 4; round++) {
      const { student, orderId } = await placeOrder([{ productId: a }]);
      await Promise.all([cancelAs(guardianA, "guardian", orderId, { lines: [{ lineNo: 1, quantity: 1 }] }), exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, -200)]);
      const first = (await itemsOf(orderId))[0]!;
      expect((first.canceledQty ?? 0) + (first.exchangedQty ?? 0)).toBe(1);
      await expectOrderMoney(orderId);
      await expectLedger(student);
      const order = await orderOf(orderId);
      expect(await usageOf(student, d(3))).toBe(order.status === "cancelled" ? 0 : 300);
    }
    await expectStock(a);
    await expectStock(b);
  });

  it("DUAS TROCAS simultâneas da mesma unidade (chaves diferentes, ×4): só uma vence; uma cobrança só", async () => {
    const a = await newProduct({ price: 500, stock: 40 });
    const b = await newProduct({ price: 600, stock: 40 });
    const c = await newProduct({ price: 900, stock: 40 });
    const { student, orderId } = await placeOrder([{ productId: a }]);
    const results = await Promise.all([
      exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, 100),
      exchangeAs(admin, "admin", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: c, quantity: 1 }] }, 400),
      exchangeAs(cantina, "cantina", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: b, quantity: 1 }] }, 100),
      exchangeAs(admin, "admin", orderId, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: c, quantity: 1 }] }, 400),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(["nothing_remaining", "quantity_exceeds_remaining"]).toContain(r.body.error);
    expect((await entriesOf(student, "order_exchange")).length).toBe(1);
    expect((await itemsOf(orderId)).length).toBe(2);
    await expectOrderMoney(orderId);
    await expectLedger(student);
    for (const p of [a, b, c]) await expectStock(p);
  });
});

describe("opções da equipe", () => {
  it("datas de destino no turno atual do aluno e produtos do cardápio da data/turno do pedido, sem custo", async () => {
    const a = await newProduct({ price: 500, stock: 30 });
    const { orderId } = await placeOrder([{ productId: a }]);
    const r = await call(optionsRoute, cantina, "GET", `/api/operations/orders/${orderId}/amend-options`, undefined, orderId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ orderId, consumptionDate: d(3), studentShiftId: ST, canReschedule: true, canExchange: true });
    expect((r.body.destinations as { date: string }[]).map((x) => x.date)).toEqual(Array.from({ length: 8 }, (_, i) => d(i)));
    expect((r.body.products as { id: string }[]).some((p) => p.id === a)).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/cost|Cost|micros/);
  });
});
