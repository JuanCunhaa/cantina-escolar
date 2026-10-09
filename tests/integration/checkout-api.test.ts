// Checkout antecipado (F11) contra Auth/Firestore Emulator: pedido pago por data, lote tudo-ou-nada, snapshots, revisão de
// preço, política (F09), reserva/cota (F10), carteira/livro (F08), idempotência (clique duplo, replay, resposta perdida),
// autorização atual, falha no último passo e disputas reais (saldo, limite, cota, último item). O saldo vem SÓ de fixture do
// emulador. O relógio é injetado no comando (09:00 de São Paulo de hoje: manhã já encerrada, tarde aberta).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
type Result = { status: number; body: Json };

let placeAdvanceOrders: typeof import("@/modules/orders/commands").placeAdvanceOrders;
let commandErrorResponse: typeof import("@/modules/access/command-route").commandErrorResponse;
let checkoutRoute: Handler;
let receiptsRoute: Handler;
let capacityRoute: Handler;
let inventoryReconcileRoute: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let checkLedger: typeof import("@/modules/wallet/model").checkLedger;
let parseWalletState: typeof import("@/modules/wallet/model").parseWalletState;
let school: typeof import("@/lib/dates/school-time");

let admin: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let outsider: TestUser;
let cantina: TestUser;
let studentLogin: TestUser;

const tag = randomUUID().slice(0, 6);
const SM = `shf_${tag}_m`; // manhã
const ST = `shf_${tag}_t`; // tarde
const CAT = `cat_${tag}`;
let BASE = "";
let NOW = new Date();
let seq = 0;
const d = (n: number) => school.addDays(BASE, n);
const prices = new Map<string, number>();

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  ({ placeAdvanceOrders } = await import("@/modules/orders/commands"));
  ({ commandErrorResponse } = await import("@/modules/access/command-route"));
  checkoutRoute = (await import("@/app/api/orders/checkout/route")).POST as Handler;
  receiptsRoute = (await import("@/app/api/inventory/receipts/route")).POST as Handler;
  capacityRoute = (await import("@/app/api/inventory/capacity/route")).POST as Handler;
  inventoryReconcileRoute = (await import("@/app/api/inventory/reconcile/route")).GET as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ checkLedger, parseWalletState } = await import("@/modules/wallet/model"));
  school = await import("@/lib/dates/school-time");
  BASE = school.localDateOf(new Date());
  NOW = school.localInstant(BASE, "09:00");
  [admin, guardianA, guardianB, outsider, cantina, studentLogin] = await Promise.all([
    createTestUser("oadm", "admin"),
    createTestUser("oresp-a", "guardian"),
    createTestUser("oresp-b", "guardian"),
    createTestUser("ofora", "guardian"),
    createTestUser("ocant", "cantina"),
    createTestUser("oalu", "student"),
  ]);
  await globalDoc(`shifts/${SM}`, { name: `Manhã ${tag}`, nameSlug: "manha", status: "active" });
  await globalDoc(`shifts/${ST}`, { name: `Tarde ${tag}`, nameSlug: "tarde", status: "active" });
  await globalDoc(`categories/${CAT}`, { name: `Categoria ${tag}`, status: "active" });
  for (let i = 0; i <= 9; i++) await globalDoc(`calendarDays/${d(i)}`, { kind: "extra" });
});

/** Documentos GLOBAIS criados aqui (turnos, categoria, calendário, produtos e cardápio): removidos no fim, pois outros arquivos compartilham o emulador. */
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
const actorOf = (user: TestUser, role = "guardian") => ({ uid: user.uid, role: role as "guardian", permissions: [] as never[] });

async function buy(user: TestUser, body: unknown, role = "guardian"): Promise<Result> {
  try {
    const result = await placeAdvanceOrders(db(), actorOf(user, role), body, () => NOW);
    return { status: 200, body: result as unknown as Json };
  } catch (error) {
    const response = commandErrorResponse(error, "teste");
    return { status: response.status, body: (await response.json()) as Json };
  }
}

type Line = { productId: string; quantity?: number; price?: number };
function cart(studentId: string, shiftId: string, days: Record<string, Line[]>, extra: Record<string, unknown> = {}) {
  return {
    key: randomUUID(),
    studentId,
    expectedShiftId: shiftId,
    days: Object.entries(days).map(([date, lines]) => ({
      date,
      lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity ?? 1, expectedPriceCents: l.price ?? prices.get(l.productId)! })),
    })),
    ...extra,
  };
}

async function newStudent(over: { shift?: string; guardians?: TestUser[]; revoked?: TestUser[]; login?: boolean; site?: boolean; status?: "active" | "inactive"; cents?: number; daily?: number | null; weekly?: number | null } = {}) {
  const id = `stu_${tag}_${++seq}`;
  await seedStudentAccess({
    studentId: id,
    name: `Aluno ${seq}`,
    guardianUids: (over.guardians ?? [guardianA]).map((g) => g.uid),
    revokedGuardianUids: (over.revoked ?? []).map((g) => g.uid),
    studentUid: over.login ? studentLogin.uid : undefined,
    studentStatus: over.status,
    allowSitePurchase: over.site ?? true,
  });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name: `Aluno ${seq}`, status: over.status ?? "active", userUid: over.login ? studentLogin.uid : null, shiftId: over.shift ?? SM, version: 3 });
  const limits = { ...(over.daily !== undefined ? { dailyLimitCents: over.daily } : {}), ...(over.weekly !== undefined ? { weeklyLimitCents: over.weekly } : {}) };
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: over.site ?? true, allowCounterPurchase: false, configVersion: 1, ...limits });
  if (over.cents) await fundDemoWallet(targetFromEnv(), id, over.cents);
  return id;
}

async function newProduct(over: { price?: number; mode?: "physical" | "planned"; stock?: number; capacity?: Record<string, number>; shifts?: string[] } = {}) {
  const id = `prd_${tag}_${++seq}`;
  const price = over.price ?? 500;
  const shifts = over.shifts ?? [SM, ST];
  await globalDoc(`products/${id}`, {
    name: `Produto ${seq}`,
    description: "",
    categoryId: CAT,
    priceCents: price,
    priceVersion: 1,
    channels: ["advance", "counter"],
    shiftIds: shifts,
    availabilityMode: over.mode ?? "physical",
    status: "active",
    version: 1,
  });
  await globalDoc(`defaultMenuRules/${id}`, { shiftIds: shifts, version: 1 });
  prices.set(id, price);
  const mode = over.mode ?? "physical";
  if (mode === "physical") {
    const response = await receiptsRoute(authed("POST", "/api/inventory/receipts", admin, { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: over.stock ?? 500, unitCost: "1,00" }));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  }
  for (const [date, capacity] of Object.entries(over.capacity ?? {})) {
    const [day, shiftId] = date.split("@");
    const response = await capacityRoute(authed("POST", "/api/inventory/capacity", admin, { key: randomUUID(), productId: id, date: day, shiftId: shiftId ?? SM, capacity }));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  }
  return id;
}
function authed(method: string, url: string, user: TestUser | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.idToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Estado observável de um aluno/produtos: serve para provar "nada mudou" e para conferir as consequências. */
async function state(studentId: string, productIds: string[] = [], dates: string[] = []) {
  const wallet = await doc(`wallets/${studentId}`);
  const orders = (await db().collection("orders").where("studentId", "==", studentId).get()).size;
  const entries = (await db().collection(`wallets/${studentId}/entries`).get()).size;
  const usageDays: Record<string, number> = {};
  const usageWeeks: Record<string, number> = {};
  for (const date of dates) {
    usageDays[date] = Number((await doc(`studentUsage/${studentId}/days/${date}`))?.committedCents ?? 0);
    const week = school.weekStartOf(date);
    usageWeeks[week] = Number((await doc(`studentUsage/${studentId}/weeks/${week}`))?.committedCents ?? 0);
  }
  const reserved: Record<string, number> = {};
  const onHand: Record<string, number> = {};
  const reservations: Record<string, number> = {};
  for (const id of productIds) {
    const balance = await doc(`stockBalances/${id}`);
    reserved[id] = Object.values((balance?.reservedByDate ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
    onHand[id] = Number(balance?.onHand ?? 0);
    reservations[id] = (await db().collection(`stockBalances/${id}/reservations`).get()).size;
  }
  return { balanceCents: Number(wallet?.balanceCents ?? 0), version: Number(wallet?.version ?? 0), orders, entries, usageDays, usageWeeks, reserved, onHand, reservations };
}

async function expectLedger(studentId: string) {
  const wallet = parseWalletState(await doc(`wallets/${studentId}`));
  const rows = (await db().collection(`wallets/${studentId}/entries`).orderBy("seq").get()).docs.map((x) => x.data() as { seq: number; amountCents: number; balanceAfterCents: number });
  expect(checkLedger(wallet, rows)).toEqual([]);
}
async function expectStock(productId: string) {
  const response = await inventoryReconcileRoute(authed("GET", `/api/inventory/reconcile?productId=${productId}`, admin));
  const body = (await response.json()) as { ok: boolean; products: { problems: string[] }[] };
  expect(body.products[0]!.problems).toEqual([]);
}
const orderIds = (r: Result) => (r.body.orders as { orderId: string }[]).map((o) => o.orderId);

/* ---------------------------------------------------------------------------------------------- compra */

describe("compra de um dia: pedido pago, snapshot, carteira, livro, uso, reserva (A16/A17)", () => {
  it("cria o pedido pago com snapshot, debita a carteira com 1 lançamento, soma o uso e RESERVA sem baixar o físico", async () => {
    const student = await newStudent({ cents: 5000 });
    const a = await newProduct({ price: 600, stock: 50 });
    const b = await newProduct({ price: 250, stock: 50 });
    const date = d(1);
    const before = await state(student, [a, b], [date]);
    const body = cart(student, SM, { [date]: [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }] });
    const r = await buy(guardianA, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, studentId: student, shiftId: SM, totalCents: 1450, wallet: { studentId: student, balanceCents: 3550, version: before.version + 1 } });
    const [order] = r.body.orders as { orderId: string; walletEntryId: string }[];
    expect(orderIds(r)).toHaveLength(1);

    const saved = (await doc(`orders/${order!.orderId}`))!;
    expect(saved).toMatchObject({ studentId: student, consumptionDate: date, shiftId: SM, status: "paid", channel: "advance", totalCents: 1450, itemCount: 3, createdByUid: guardianA.uid, studentVersion: 3, version: 1 });
    const items = new Map((saved.items as { productId: string }[]).map((i) => [i.productId, i]));
    expect(items.size).toBe(2);
    expect(items.get(a)).toMatchObject({ name: expect.stringContaining("Produto"), unit: "un", quantity: 2, unitPriceCents: 600, priceVersion: 1, discountCents: 0, subtotalCents: 1200, source: "default" });
    expect(items.get(b)).toMatchObject({ unit: "un", quantity: 1, unitPriceCents: 250, priceVersion: 1, discountCents: 0, subtotalCents: 250, source: "default" });
    // Limites de horário em UTC (manhã: compra 07:00 e cancelamento 08:00, horário de Brasília = UTC−3).
    const policy = saved.policy as { purchaseCutoffAt: { toDate(): Date }; cancelCutoffAt: { toDate(): Date }; purchaseCutoff: string; cancelCutoff: string; timezone: string };
    expect(policy).toMatchObject({ purchaseCutoff: "07:00", cancelCutoff: "08:00", timezone: "America/Sao_Paulo" });
    expect(policy.purchaseCutoffAt.toDate().toISOString()).toBe(`${date}T10:00:00.000Z`);
    expect(policy.cancelCutoffAt.toDate().toISOString()).toBe(`${date}T11:00:00.000Z`);

    // Livro: UM lançamento de débito ligado ao pedido; saldo projetado = livro.
    const entry = (await doc(`wallets/${student}/entries/${order!.walletEntryId}`))!;
    expect(entry).toMatchObject({ type: "advance_purchase", amountCents: -1450, balanceAfterCents: 3550, seq: before.version + 1, referenceType: "order", referenceId: order!.orderId });
    await expectLedger(student);

    const after = await state(student, [a, b], [date]);
    expect(after.usageDays[date]).toBe(1450);
    expect(after.usageWeeks[school.weekStartOf(date)]).toBe(1450);
    expect(after.reserved).toEqual({ [a]: 2, [b]: 1 });
    expect(after.reservations).toEqual({ [a]: 1, [b]: 1 });
    expect(after.onHand).toEqual(before.onHand); // reserva NÃO é saída física
    expect((await db().collection(`stockCosts/${a}/movements`).get()).docs.map((x) => x.get("type"))).toEqual(["receipt"]);
    expect(await doc(`auditLog/${guardianA.uid}__orders.checkout__${body.key}`)).toMatchObject({ action: "orders.checkout", target: { type: "orderBatch", id: r.body.batchId }, after: { totalCents: 1450, balanceCents: 3550 } });
    await expectStock(a);
    await expectStock(b);
  });

  it("mudar o preço do produto depois da compra não altera o pedido (A16)", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 800 });
    const r = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] }));
    expect(r.status).toBe(200);
    await db().doc(`products/${p}`).update({ priceCents: 900, priceVersion: 2 });
    const [order] = orderIds(r);
    expect((await doc(`orders/${order}`))!.items).toEqual([expect.objectContaining({ unitPriceCents: 800, subtotalCents: 800, priceVersion: 1 })]);
    expect((await doc(`orders/${order}`))!.totalCents).toBe(800);
  });
});

describe("lote de datas: tudo-ou-nada, pedidos separados por data (A10/A17)", () => {
  it("várias datas geram um pedido, um débito e um uso por data; semanas diferentes usam o próprio documento", async () => {
    const student = await newStudent({ cents: 10000 });
    const p = await newProduct({ price: 700, stock: 200 });
    const dates = [d(1), d(2), d(3)];
    const before = await state(student, [p], dates);
    const r = await buy(guardianA, cart(student, SM, Object.fromEntries(dates.map((date) => [date, [{ productId: p, quantity: 1 }]]))));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totalCents).toBe(2100);
    const orders = r.body.orders as { orderId: string; consumptionDate: string; totalCents: number; walletSeq: number }[];
    expect(orders.map((o) => o.consumptionDate)).toEqual(dates);
    expect(new Set(orders.map((o) => o.orderId)).size).toBe(3);
    expect(orders.map((o) => o.walletSeq)).toEqual([before.version + 1, before.version + 2, before.version + 3]);
    const after = await state(student, [p], dates);
    expect(after).toMatchObject({ balanceCents: 7900, version: before.version + 3, orders: 3, entries: before.entries + 3 });
    for (const date of dates) expect(after.usageDays[date]).toBe(700);
    expect(after.reserved[p]).toBe(3);
    await expectLedger(student);
    await expectStock(p);
  });

  it("uma data recusada (dia fechado) desfaz o lote inteiro: nada cobrado, reservado, comprometido ou gravado", async () => {
    const student = await newStudent({ cents: 10000 });
    const p = await newProduct({ stock: 100 });
    const dates = [d(1), d(2), d(3)];
    await writeDemoDoc(targetFromEnv(), `calendarDays/${d(3)}`, { kind: "closed" });
    try {
      const before = await state(student, [p], dates);
      const r = await buy(guardianA, cart(student, SM, Object.fromEntries(dates.map((date) => [date, [{ productId: p }]]))));
      expect(r).toMatchObject({ status: 409, body: { error: "non_operating_day", details: { date: d(3) } } });
      expect(await state(student, [p], dates)).toEqual(before);
    } finally {
      await writeDemoDoc(targetFromEnv(), `calendarDays/${d(3)}`, { kind: "extra" });
    }
  });

  it("cota esgotada só na última data desfaz as reservas das datas anteriores e a cobrança", async () => {
    const student = await newStudent({ cents: 10000 });
    const planned = await newProduct({ mode: "planned", price: 400, capacity: { [`${d(1)}@${SM}`]: 5, [`${d(2)}@${SM}`]: 5, [`${d(3)}@${SM}`]: 1 } });
    const dates = [d(1), d(2), d(3)];
    const before = await state(student, [planned], dates);
    const r = await buy(guardianA, cart(student, SM, Object.fromEntries(dates.map((date) => [date, [{ productId: planned, quantity: 2 }]]))));
    expect(r).toMatchObject({ status: 409, body: { error: "capacity_exceeded", details: { date: d(3), limit: 1, available: 1 } } });
    expect(await state(student, [planned], dates)).toEqual(before);
    for (const date of dates) expect((await doc(`dailyCapacity/${planned}_${date}_${SM}`))?.reserved).toBe(0);
    // Corrigido o carrinho (1 unidade na última data), o mesmo lote passa.
    const ok = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: planned, quantity: 2 }], [d(2)]: [{ productId: planned, quantity: 2 }], [d(3)]: [{ productId: planned, quantity: 1 }] }));
    expect(ok.status).toBe(200);
    expect((await doc(`dailyCapacity/${planned}_${d(3)}_${SM}`))?.reserved).toBe(1);
  });

  it("tamanho máximo suportado: 8 datas × 5 produtos (40 linhas) em uma confirmação; acima disso é recusado antes de qualquer leitura", async () => {
    const student = await newStudent({ shift: ST, cents: 500000 });
    const products = await Promise.all([1, 2, 3, 4, 5].map(() => newProduct({ price: 100, stock: 400 })));
    const days = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [d(i), products.map((productId) => ({ productId, quantity: 2 }))]));
    const r = await buy(guardianA, cart(student, ST, days));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totalCents).toBe(8 * 5 * 2 * 100);
    expect(orderIds(r)).toHaveLength(8);
    await expectLedger(student);
    for (const productId of products) await expectStock(productId);
    const s = await state(student, products);
    expect(s.reserved[products[0]!]).toBe(16);

    const before = await state(student);
    const tooMany = { ...cart(student, ST, days), days: [...cart(student, ST, days).days, { date: d(8), lines: [{ productId: products[0]!, quantity: 1, expectedPriceCents: 100 }] }] };
    expect((await buy(guardianA, tooMany)).status).toBe(400); // 9 datas
    const manyLines = cart(student, ST, { [d(0)]: Array.from({ length: 11 }, (_, i) => ({ productId: `p${i}`, price: 100 })) });
    expect((await buy(guardianA, manyLines)).status).toBe(400); // 11 linhas na data
    expect((await buy(guardianA, cart(student, ST, { [d(0)]: [{ productId: products[0]!, quantity: 21 }] }))).status).toBe(400);
    expect((await buy(guardianA, cart(student, ST, { [d(0)]: [{ productId: products[0]!, quantity: 0 }] }))).status).toBe(400);
    expect(await state(student)).toEqual(before);
  });
});

/* ------------------------------------------------------------------------------------------ preço do servidor */

describe("preço do servidor e revisão do carrinho (A16)", () => {
  it("preço alterado entre a visualização e a confirmação: nada é cobrado; devolve o carrinho com os preços atuais; nova confirmação passa", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 800, stock: 50 });
    const q = await newProduct({ price: 300, stock: 50 });
    const stale = cart(student, SM, { [d(1)]: [{ productId: p, quantity: 2 }, { productId: q }] });
    await db().doc(`products/${p}`).update({ priceCents: 900, priceVersion: 2 });
    const before = await state(student, [p, q], [d(1)]);
    const r = await buy(guardianA, stale);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("price_changed");
    expect(r.body.details!.changes).toEqual([expect.objectContaining({ date: d(1), productId: p, expectedPriceCents: 800, currentPriceCents: 900 })]);
    expect(r.body.details!.cart).toMatchObject({ totalCents: 2100, days: [{ date: d(1), totalCents: 2100 }] });
    expect(await state(student, [p, q], [d(1)])).toEqual(before);
    // A tela mostra o novo total e o responsável confirma de novo, agora com os preços revistos.
    const confirmed = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p, quantity: 2, price: 900 }, { productId: q }] }));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.totalCents).toBe(2100);
  });

  it("valor informado pelo cliente nunca é o cobrado: preço menor é só 'preço visto' e gera revisão; total/saldo no corpo são recusados", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 800 });
    const before = await state(student, [p], [d(1)]);
    const cheaper = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p, price: 1 }] }));
    expect(cheaper).toMatchObject({ status: 409, body: { error: "price_changed", details: { cart: { totalCents: 800 } } } });
    for (const extra of [{ totalCents: 1 }, { priceCents: 1 }, { balanceCents: 99999 }]) {
      expect((await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] }, extra))).status).toBe(400);
    }
    expect(await state(student, [p], [d(1)])).toEqual(before);
  });

  it("produto fora do cardápio, desativado, de outro turno ou inexistente não é vendido mesmo com o ID enviado à mão", async () => {
    const student = await newStudent({ cents: 5000 });
    const hidden = await newProduct({ shifts: [ST] }); // não vendido na manhã
    const inactive = await newProduct();
    await db().doc(`products/${inactive}`).update({ status: "inactive" });
    const counterOnly = await newProduct();
    await db().doc(`products/${counterOnly}`).update({ channels: ["counter"] });
    const before = await state(student, [hidden], [d(1)]);
    for (const [productId, reason] of [
      [hidden, "shift_not_allowed"],
      [inactive, "product_inactive"],
      [counterOnly, "channel_not_allowed"],
      ["prd_inexistente", "product_not_found"],
    ] as const) {
      const r = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId, price: 100 }] }));
      expect(r, productId).toMatchObject({ status: 409, body: { error: "item_unavailable", details: { productId, reason } } });
    }
    expect(await state(student, [hidden], [d(1)])).toEqual(before);
  });
});

/* ---------------------------------------------------------------------------------------- calendário e horário */

describe("calendário, janela e horário do servidor (A12/A14)", () => {
  it("manhã fecha às 07:00 e tarde às 14:00 (agora >= limite); hoje já encerrado não impede amanhã", async () => {
    const morning = await newStudent({ shift: SM, cents: 5000 });
    const afternoon = await newStudent({ shift: ST, cents: 5000 });
    const p = await newProduct({ stock: 100 });
    expect(await buy(guardianA, cart(morning, SM, { [d(0)]: [{ productId: p }] }))).toMatchObject({ status: 409, body: { error: "after_cutoff", details: { date: d(0) } } });
    expect((await buy(guardianA, cart(morning, SM, { [d(1)]: [{ productId: p }] }))).status).toBe(200);
    expect((await buy(guardianA, cart(afternoon, ST, { [d(0)]: [{ productId: p }] }))).status).toBe(200); // tarde de hoje ainda aberta às 09:00
    // Fronteira exata: carrinho aberto antes do horário não garante compra depois dele.
    const edge = async (iso: string, shiftId: string, studentId: string) => {
      const saved = NOW;
      NOW = new Date(iso);
      try {
        return await buy(guardianA, cart(studentId, shiftId, { [d(0)]: [{ productId: p }] }));
      } finally {
        NOW = saved;
      }
    };
    const t0 = school.localInstant(BASE, "14:00").getTime();
    expect((await edge(new Date(t0 - 1).toISOString(), ST, afternoon)).status).toBe(200);
    expect((await edge(new Date(t0).toISOString(), ST, afternoon)).body.error).toBe("after_cutoff");
    const m0 = school.localInstant(BASE, "07:00").getTime();
    expect((await edge(new Date(m0 - 1).toISOString(), SM, morning)).status).toBe(200);
    expect((await edge(new Date(m0).toISOString(), SM, morning)).body.error).toBe("after_cutoff");
  });

  it("hoje+7 passa; hoje+8, data passada e dia sem funcionamento são recusados; turno trocado exige revisão", async () => {
    const student = await newStudent({ shift: ST, cents: 5000 });
    const p = await newProduct({ stock: 100 });
    await writeDemoDoc(targetFromEnv(), `calendarDays/${d(9)}`, { kind: "extra" });
    await writeDemoDoc(targetFromEnv(), `calendarDays/${d(5)}`, { kind: "closed" });
    try {
      expect((await buy(guardianA, cart(student, ST, { [d(7)]: [{ productId: p }] }))).status).toBe(200);
      expect((await buy(guardianA, cart(student, ST, { [d(8)]: [{ productId: p }] }))).body.error).toBe("beyond_window");
      expect((await buy(guardianA, cart(student, ST, { [d(9)]: [{ productId: p }] }))).body.error).toBe("beyond_window");
      expect((await buy(guardianA, cart(student, ST, { [d(-1)]: [{ productId: p }] }))).body.error).toBe("past_date");
      expect((await buy(guardianA, cart(student, ST, { [d(5)]: [{ productId: p }] }))).body.error).toBe("non_operating_day");
      const changed = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] })); // a tela exibiu o turno da manhã
      expect(changed).toMatchObject({ status: 409, body: { error: "shift_changed", details: { shiftId: ST } } });
    } finally {
      await writeDemoDoc(targetFromEnv(), `calendarDays/${d(5)}`, { kind: "extra" });
    }
  });
});

/* ----------------------------------------------------------------------------------------------- política F09 */

describe("política do responsável aplicada no checkout (A10/A11)", () => {
  it("limite diário R$ 10 permite R$ 10 em cada data diferente do mesmo lote; R$ 8 agendados deixam R$ 2 (R$ 3 pede confirmação)", async () => {
    const student = await newStudent({ cents: 20000, daily: 1000 });
    const p = await newProduct({ price: 1000, stock: 100 });
    const ok = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }], [d(2)]: [{ productId: p }], [d(3)]: [{ productId: p }] }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.override).toBeNull();
    const eight = await newProduct({ price: 800, stock: 100 });
    const three = await newProduct({ price: 300, stock: 100 });
    const two = await newProduct({ price: 200, stock: 100 });
    const second = await newStudent({ cents: 20000, daily: 1000 });
    expect((await buy(guardianA, cart(second, SM, { [d(1)]: [{ productId: eight }] }))).status).toBe(200);
    const denied = await buy(guardianA, cart(second, SM, { [d(1)]: [{ productId: three }] }));
    expect(denied).toMatchObject({ status: 409, body: { error: "confirmation_required" } });
    expect(denied.body.details!.days).toEqual([expect.objectContaining({ key: d(1), committedCents: 800, requestedCents: 300, afterCents: 1100, limitCents: 1000, remainingBeforeCents: 200, exceeds: true })]);
    expect((await buy(guardianA, cart(second, SM, { [d(1)]: [{ productId: two }] }))).status).toBe(200); // exatamente R$ 2 cabem
    expect((await state(second, [], [d(1)])).usageDays[d(1)]).toBe(1000);
  });

  it("responsável supera o limite só com confirmação explícita; o consumo continua contado; aluno com login não supera", async () => {
    const student = await newStudent({ cents: 20000, daily: 500, login: true });
    const p = await newProduct({ price: 900, stock: 100 });
    const without = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] }));
    expect(without.body.error).toBe("confirmation_required");
    const forced = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] }, { confirmed: true }));
    expect(forced.status).toBe(200);
    expect(forced.body.override).toEqual({ via: "guardian_confirmation" });
    expect((await state(student, [], [d(1)])).usageDays[d(1)]).toBe(900);
    // O aluno (autonomia) não pode superar: política_negada; com 'confirmed' continua negado.
    const byStudent = await buy(studentLogin, cart(student, SM, { [d(2)]: [{ productId: p }] }, { confirmed: true }), "student");
    expect(byStudent).toMatchObject({ status: 409, body: { error: "policy_denied" } });
    const within = await newProduct({ price: 400, stock: 100 });
    expect((await buy(studentLogin, cart(student, SM, { [d(2)]: [{ productId: within }] }), "student")).status).toBe(200);
  });

  it("limite semanal por semana do consumo; bloqueio de produto e categoria pedem confirmação", async () => {
    const student = await newStudent({ cents: 50000, weekly: 1500 });
    const p = await newProduct({ price: 1000, stock: 100 });
    // d(1) e d(2) podem estar na mesma semana ou em semanas diferentes conforme o dia de hoje: calcula as semanas.
    const dates = [d(1), d(2), d(3), d(4), d(5), d(6), d(7)];
    const sameWeek = dates.find((x, i) => dates.slice(i + 1).some((y) => school.weekStartOf(y) === school.weekStartOf(x)))!;
    const mate = dates.find((y) => y > sameWeek && school.weekStartOf(y) === school.weekStartOf(sameWeek))!;
    const r = await buy(guardianA, cart(student, SM, { [sameWeek]: [{ productId: p }], [mate]: [{ productId: p }] }));
    expect(r.body.error).toBe("confirmation_required");
    expect(r.body.details!.weeks).toEqual([expect.objectContaining({ key: school.weekStartOf(sameWeek), requestedCents: 2000, limitCents: 1500, exceeds: true })]);
    const other = dates.find((y) => school.weekStartOf(y) !== school.weekStartOf(sameWeek));
    if (other) {
      const split = await buy(guardianA, cart(student, SM, { [sameWeek]: [{ productId: p }], [other]: [{ productId: p }] }));
      expect(split.status, "semanas diferentes consomem tetos próprios").toBe(200);
    }
    // Aluno SEM consumo comprometido: o bloqueio é isolado do teto semanal (com o mesmo aluno, numa segunda-feira d(1) cai na semana já
    // comprometida pelo `split` acima e a lista de violações ganha o limite semanal — o teste dependia do dia da semana).
    const blocked = await newStudent({ cents: 50000 });
    await db().doc(`studentPolicies/${blocked}`).update({ blockedProductIds: [p] });
    expect((await buy(guardianA, cart(blocked, SM, { [d(1)]: [{ productId: p }] }))).body).toMatchObject({ error: "confirmation_required", details: { violations: [{ kind: "product_blocked", productId: p }] } });
  });

  it("exceção de uso único de aluno: cobre só a data e o valor autorizados e é consumida na mesma transação", async () => {
    const student = await newStudent({ cents: 20000, daily: 300, login: true });
    const p = await newProduct({ price: 500, stock: 100 });
    const exceptionId = `exc_${tag}_1`;
    await writeDemoDoc(targetFromEnv(), `studentPolicies/${student}/exceptions/${exceptionId}`, { studentId: student, kind: "guardian", status: "active", consumptionDate: d(1), maxCents: 500 });
    const wrongDate = await buy(studentLogin, cart(student, SM, { [d(2)]: [{ productId: p }] }, { exceptionId }), "student");
    expect(wrongDate.body.error).toBe("policy_denied");
    const ok = await buy(studentLogin, cart(student, SM, { [d(1)]: [{ productId: p }] }, { exceptionId }), "student");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.override).toEqual({ via: "exception", exceptionId, kind: "guardian" });
    expect(await doc(`studentPolicies/${student}/exceptions/${exceptionId}`)).toMatchObject({ status: "used", usedBy: studentLogin.uid, usedFor: (ok.body.orders as { orderId: string }[])[0]!.orderId });
    const again = await buy(studentLogin, cart(student, SM, { [d(1)]: [{ productId: p }] }, { exceptionId }), "student");
    expect(again.body.error).toBe("policy_denied"); // já usada
  });
});

/* ------------------------------------------------------------------------------------------- carteira / saldo */

describe("saldo da carteira (A17/A18)", () => {
  it("carteira com pendência de reembolso/chargeback (F19) NÃO faz compra antecipada, mesmo com saldo; nada é gravado e a liberação reabre a compra", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 700, stock: 100 });
    await adminDb().doc(`wallets/${student}`).set({ pendingReversalCents: 1200 }, { merge: true });
    const before = await state(student, [p], [d(1)]);
    const r = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] }));
    expect(r).toMatchObject({ status: 409, body: { error: "wallet_blocked", details: { pendingCents: 1200 } } });
    expect(await state(student, [p], [d(1)])).toEqual(before);
    await adminDb().doc(`wallets/${student}`).set({ pendingReversalCents: 0 }, { merge: true });
    expect((await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] }))).status).toBe(200);
    await expectLedger(student);
  });

  it("saldo insuficiente recusa o lote inteiro sem gravar; saldo exato fecha em zero, nunca negativo", async () => {
    const student = await newStudent({ cents: 1500 });
    const p = await newProduct({ price: 700, stock: 100 });
    const before = await state(student, [p], [d(1), d(2), d(3)]);
    const r = await buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }], [d(2)]: [{ productId: p }], [d(3)]: [{ productId: p }] }));
    expect(r).toMatchObject({ status: 409, body: { error: "insufficient_balance", details: { balanceCents: 1500, requiredCents: 2100 } } });
    expect(await state(student, [p], [d(1), d(2), d(3)])).toEqual(before);
    const exact = await newStudent({ cents: 1400 });
    const ok = await buy(guardianA, cart(exact, SM, { [d(1)]: [{ productId: p }], [d(2)]: [{ productId: p }] }));
    expect(ok.status).toBe(200);
    expect((await state(exact)).balanceCents).toBe(0);
    await expectLedger(exact);
    const empty = await newStudent({}); // carteira sem documento = saldo 0
    expect((await buy(guardianA, cart(empty, SM, { [d(1)]: [{ productId: p }] }))).body.error).toBe("insufficient_balance");
    expect((await doc(`wallets/${empty}`))).toBeUndefined();
  });

  it("a compra de A debita só a carteira de A (carteiras individuais)", async () => {
    const a = await newStudent({ cents: 3000, guardians: [guardianA, guardianB] });
    const b = await newStudent({ cents: 3000, guardians: [guardianA, guardianB] });
    const p = await newProduct({ price: 1000, stock: 100 });
    expect((await buy(guardianB, cart(a, SM, { [d(1)]: [{ productId: p }] }))).status).toBe(200);
    expect(await state(a)).toMatchObject({ balanceCents: 2000 });
    expect(await state(b)).toMatchObject({ balanceCents: 3000, version: 1, orders: 0 });
  });
});

/* -------------------------------------------------------------------------------------------- idempotência */

describe("idempotência: clique duplo, replay, resposta perdida, payload diferente (A17)", () => {
  it("clique duplo (duas chamadas simultâneas com a mesma chave) cobra e reserva UMA vez; as duas respostas descrevem o mesmo pedido", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 800, stock: 100 });
    const body = cart(student, SM, { [d(1)]: [{ productId: p }] });
    const [x, y] = await Promise.all([buy(guardianA, body), buy(guardianA, body)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(orderIds(x)).toEqual(orderIds(y));
    expect([x.body.replayed, y.body.replayed].sort()).toEqual([false, true]);
    expect(await state(student, [p], [d(1)])).toMatchObject({ balanceCents: 4200, orders: 1, entries: 2, reserved: { [p]: 1 }, usageDays: { [d(1)]: 800 } });
    await expectLedger(student);
  });

  it("resposta perdida: o reenvio da mesma operação devolve o pedido original, mesmo depois de o preço mudar, sem novo débito", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 800, stock: 100 });
    const body = cart(student, SM, { [d(1)]: [{ productId: p }] });
    const first = await buy(guardianA, body); // a resposta "se perde" no cliente
    expect(first.status).toBe(200);
    await db().doc(`products/${p}`).update({ priceCents: 1200, priceVersion: 2 });
    const retry = await buy(guardianA, body);
    expect(retry).toMatchObject({ status: 200, body: { replayed: true, totalCents: 800, wallet: first.body.wallet } });
    expect(orderIds(retry)).toEqual(orderIds(first));
    expect(await state(student, [p], [d(1)])).toMatchObject({ balanceCents: 4200, orders: 1, reserved: { [p]: 1 } });
  });

  it("mesma chave com payload diferente é conflito e não cria nada; a rota devolve 409 idempotency_conflict", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 800, stock: 100 });
    const body = cart(student, SM, { [d(1)]: [{ productId: p }] });
    expect((await buy(guardianA, body)).status).toBe(200);
    const before = await state(student, [p], [d(1), d(2)]);
    const different = { ...cart(student, SM, { [d(1)]: [{ productId: p, quantity: 2 }] }), key: body.key };
    expect(await buy(guardianA, different)).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
    const otherDate = { ...cart(student, SM, { [d(2)]: [{ productId: p }] }), key: body.key };
    expect((await buy(guardianA, otherDate)).body.error).toBe("idempotency_conflict");
    expect(await state(student, [p], [d(1), d(2)])).toEqual(before);
    // A ordem das datas/linhas não muda o payload: o mesmo carrinho reordenado é o mesmo pedido.
    const second = await newProduct({ price: 100, stock: 100 });
    const two = cart(student, SM, { [d(2)]: [{ productId: p }, { productId: second }], [d(3)]: [{ productId: p }] });
    expect((await buy(guardianA, two)).status).toBe(200);
    const reordered = { ...two, days: [...two.days].reverse().map((x) => ({ ...x, lines: [...x.lines].reverse() })) };
    expect(await buy(guardianA, reordered)).toMatchObject({ status: 200, body: { replayed: true } });
  });

  it("o mesmo comando em outro ator com a mesma chave é uma operação independente (chave é por usuário)", async () => {
    const student = await newStudent({ cents: 5000, guardians: [guardianA, guardianB] });
    const p = await newProduct({ price: 500, stock: 100 });
    const body = cart(student, SM, { [d(1)]: [{ productId: p }] });
    expect((await buy(guardianA, body)).body.replayed).toBe(false);
    expect((await buy(guardianB, body)).body.replayed).toBe(false);
    expect((await state(student)).orders).toBe(2);
  });
});

/* ---------------------------------------------------------------------------------------------- autorização */

describe("autorização com perfil e vínculo atuais (A01/A02)", () => {
  it("sem vínculo, vínculo revogado, equipe, aluno sem permissão e aluno inativo são negados sem efeitos", async () => {
    const p = await newProduct({ stock: 100 });
    const linked = await newStudent({ cents: 5000 });
    const before = await state(linked, [p], [d(1)]);
    expect((await buy(outsider, cart(linked, SM, { [d(1)]: [{ productId: p }] }))).status).toBe(403);
    expect((await buy(cantina, cart(linked, SM, { [d(1)]: [{ productId: p }] }), "cantina")).status).toBe(403);
    expect((await buy(admin, cart(linked, SM, { [d(1)]: [{ productId: p }] }), "admin")).status).toBe(403);
    const revoked = await newStudent({ cents: 5000, guardians: [], revoked: [guardianA] });
    expect((await buy(guardianA, cart(revoked, SM, { [d(1)]: [{ productId: p }] }))).status).toBe(403);
    const noSite = await newStudent({ cents: 5000, login: true, site: false });
    expect((await buy(studentLogin, cart(noSite, SM, { [d(1)]: [{ productId: p }] }), "student")).status).toBe(403);
    const inactive = await newStudent({ cents: 5000, status: "inactive" });
    expect((await buy(guardianA, cart(inactive, SM, { [d(1)]: [{ productId: p }] }))).body.error).toBe("student_inactive");
    expect((await buy(guardianA, cart("stu_inexistente", SM, { [d(1)]: [{ productId: p }] }))).status).toBe(403);
    expect(await state(linked, [p], [d(1)])).toEqual(before);
    expect((await state(revoked)).orders + (await state(noSite)).orders + (await state(inactive)).orders).toBe(0);
  });

  it("vínculo revogado DEPOIS da compra: o replay da mesma chave é negado com o estado atual", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ stock: 100 });
    const body = cart(student, SM, { [d(1)]: [{ productId: p }] });
    expect((await buy(guardianA, body)).status).toBe(200);
    await db().doc(`guardianStudentLinks/${guardianA.uid}_${student}`).update({ status: "revoked" });
    expect((await buy(guardianA, body)).status).toBe(403);
    expect((await buy(guardianA, cart(student, SM, { [d(2)]: [{ productId: p }] }))).status).toBe(403);
    expect((await state(student)).orders).toBe(1);
  });

  it("perfil rebaixado entre a autenticação e o comando é negado (perfil lido na transação); permissão de compra revogada nega aluno", async () => {
    const student = await newStudent({ cents: 5000, login: true });
    const p = await newProduct({ stock: 100 });
    await db().doc(`studentPolicies/${student}`).update({ allowSitePurchase: false });
    expect((await buy(studentLogin, cart(student, SM, { [d(1)]: [{ productId: p }] }), "student")).status).toBe(403);
    await db().doc(`studentPolicies/${student}`).update({ allowSitePurchase: true });
    await db().doc(`users/${guardianB.uid}`).update({ status: "inactive" });
    try {
      const other = await newStudent({ cents: 5000, guardians: [guardianB] });
      expect((await buy(guardianB, cart(other, SM, { [d(1)]: [{ productId: p }] }))).status).toBe(403);
    } finally {
      await db().doc(`users/${guardianB.uid}`).update({ status: "active" });
    }
  });
});

describe("rota HTTP", () => {
  it("exige autenticação, valida o corpo e confirma pela resposta (relógio real)", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 450, stock: 100 });
    const tomorrow = school.addDays(school.localDateOf(new Date()), 1);
    await writeDemoDoc(targetFromEnv(), `calendarDays/${tomorrow}`, { kind: "extra" });
    const body = cart(student, SM, { [tomorrow]: [{ productId: p, quantity: 2 }] });
    expect((await checkoutRoute(authed("POST", "/api/orders/checkout", null, body))).status).toBe(401);
    expect((await checkoutRoute(authed("POST", "/api/orders/checkout", guardianA, { key: "curta" }))).status).toBe(400);
    const response = await checkoutRoute(authed("POST", "/api/orders/checkout", guardianA, body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalCents: 900, replayed: false, wallet: { balanceCents: 4100 } });
    expect((await checkoutRoute(authed("POST", "/api/orders/checkout", outsider, { ...body, key: randomUUID() }))).status).toBe(403);
  });
});

/* -------------------------------------------------------------------------------------- falha intermediária */

describe("falha intermediária: tudo ou nada (A17)", () => {
  it("falha no ÚLTIMO passo (auditoria) depois de planejar estoque, uso, carteira e pedidos: nada é persistido; o retry cobra uma só vez", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 600, stock: 100 });
    const body = cart(student, SM, { [d(1)]: [{ productId: p, quantity: 2 }], [d(2)]: [{ productId: p }] });
    const auditId = `${guardianA.uid}__orders.checkout__${body.key}`;
    await db().doc(`auditLog/${auditId}`).set({ action: "bloqueio-de-teste" }); // o create() da auditoria falha com ALREADY_EXISTS
    const before = await state(student, [p], [d(1), d(2)]);
    const failed = await buy(guardianA, body);
    expect(failed.status).toBe(500);
    expect(await state(student, [p], [d(1), d(2)])).toEqual(before);
    expect((await db().collection("idempotencyRecords").doc(`${guardianA.uid}__orders.checkout__${body.key}`).get()).exists).toBe(false);
    await db().doc(`auditLog/${auditId}`).delete();
    const retry = await buy(guardianA, body);
    expect(retry).toMatchObject({ status: 200, body: { replayed: false, totalCents: 1800 } });
    expect(await state(student, [p], [d(1), d(2)])).toMatchObject({ balanceCents: 3200, orders: 2, reserved: { [p]: 3 } });
    await expectLedger(student);
    await expectStock(p);
    expect((await doc(`auditLog/${auditId}`))).toMatchObject({ action: "orders.checkout", target: { type: "orderBatch" } });
  });
});

/* ---------------------------------------------------------------------------------------------- concorrência */

describe("disputas reais simultâneas (A18/A35)", () => {
  it("saldo: 8 compras simultâneas de R$ 3 com R$ 10 → exatamente 3 passam; saldo R$ 1, livro e uso batem", async () => {
    const student = await newStudent({ cents: 1000 });
    const p = await newProduct({ price: 300, stock: 100 });
    const results = await Promise.all(Array.from({ length: 8 }, () => buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] }))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.error === "insufficient_balance")).toBe(true);
    expect(await state(student, [p], [d(1)])).toMatchObject({ balanceCents: 100, orders: 3, reserved: { [p]: 3 }, usageDays: { [d(1)]: 900 } });
    await expectLedger(student);
    await expectStock(p);
  });

  it("limite diário: 6 compras simultâneas de R$ 4 com teto R$ 10 → 2 passam (R$ 8); as demais pedem confirmação e nada é cobrado a mais", async () => {
    const student = await newStudent({ cents: 10000, daily: 1000 });
    const p = await newProduct({ price: 400, stock: 100 });
    const results = await Promise.all(Array.from({ length: 6 }, () => buy(guardianA, cart(student, SM, { [d(1)]: [{ productId: p }] }))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.error === "confirmation_required")).toBe(true);
    expect(await state(student, [p], [d(1)])).toMatchObject({ balanceCents: 9200, orders: 2, usageDays: { [d(1)]: 800 } });
    await expectLedger(student);
  });

  it("limite semanal compartilhado entre datas diferentes do mesmo aluno: 6 lotes de datas distintas respeitam o teto da semana", async () => {
    const student = await newStudent({ cents: 50000, weekly: 2000 });
    const p = await newProduct({ price: 500, stock: 200 });
    const dates = [d(1), d(2), d(3), d(4), d(5), d(6), d(7)];
    const week = dates.filter((x) => school.weekStartOf(x) === school.weekStartOf(dates.find((y) => dates.filter((z) => school.weekStartOf(z) === school.weekStartOf(y)).length >= 4) ?? dates[0]!));
    const results = await Promise.all(week.slice(0, 6).map((date) => buy(guardianA, cart(student, SM, { [date]: [{ productId: p, quantity: 2 }] }))));
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBeLessThanOrEqual(2); // R$ 10 por compra, teto R$ 20 por semana
    expect(ok).toBe(Math.min(2, week.slice(0, 6).length));
    const s = await state(student, [p], week);
    expect(s.usageWeeks[school.weekStartOf(week[0]!)]).toBe(ok * 1000);
    expect(s.balanceCents).toBe(50000 - ok * 1000);
  });

  it("cota: 8 alunos disputam 3 vagas planejadas → exatamente 3 reservas; as demais recebem capacity_exceeded sem cobrança", async () => {
    const planned = await newProduct({ mode: "planned", price: 300, capacity: { [`${d(1)}@${SM}`]: 3 } });
    const students = await Promise.all(Array.from({ length: 8 }, () => newStudent({ cents: 1000 })));
    const results = await Promise.all(students.map((s) => buy(guardianA, cart(s, SM, { [d(1)]: [{ productId: planned }] }))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.error === "capacity_exceeded")).toBe(true);
    expect(await doc(`dailyCapacity/${planned}_${d(1)}_${SM}`)).toMatchObject({ capacity: 3, reserved: 3 });
    const balances = await Promise.all(students.map(async (s) => (await state(s)).balanceCents));
    expect(balances.filter((b) => b === 700)).toHaveLength(3);
    expect(balances.filter((b) => b === 1000)).toHaveLength(5);
    await expectStock(planned);
  });

  it("último item: 6 alunos disputam 1 unidade de estoque físico → 1 reserva; o físico não é baixado e o estoque reconcilia", async () => {
    const p = await newProduct({ price: 300, stock: 1 });
    const students = await Promise.all(Array.from({ length: 6 }, () => newStudent({ cents: 1000 })));
    const results = await Promise.all(students.map((s) => buy(guardianA, cart(s, SM, { [d(1)]: [{ productId: p }] }))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.error === "insufficient_stock")).toBe(true);
    expect(await state("x", [p])).toMatchObject({ onHand: { [p]: 1 }, reserved: { [p]: 1 } });
    const balances = await Promise.all(students.map(async (s) => (await state(s)).balanceCents));
    expect(balances.filter((b) => b === 700)).toHaveLength(1);
    await expectStock(p);
  });

  it("mesma chave ×6 simultâneas: um único pedido e um único débito", async () => {
    const student = await newStudent({ cents: 5000 });
    const p = await newProduct({ price: 500, stock: 100 });
    const body = cart(student, SM, { [d(1)]: [{ productId: p }] });
    const results = await Promise.all(Array.from({ length: 6 }, () => buy(guardianA, body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect(await state(student, [p], [d(1)])).toMatchObject({ balanceCents: 4500, orders: 1, reserved: { [p]: 1 }, usageDays: { [d(1)]: 500 } });
  });
});
