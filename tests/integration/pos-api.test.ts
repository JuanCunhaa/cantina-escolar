// PDV de balcão e venda direta (F15) contra Auth/Firestore Emulator: venda com saldo (débito + livro + pedido entregue + baixa de
// estoque/custo + uso da política numa transação), venda direta sem aluno (lançamento separado, sem carteira), guard da F09,
// permissões separadas de site e balcão, replay/clique duplo/resposta perdida, autorização revogada, falha intermediária e
// disputas reais (saldo, limite, último estoque, PDV × checkout antecipado × entrega). Saldo vem SÓ de fixture do emulador.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
type Result = { status: number; body: Json };

let placeAdvanceOrders: typeof import("@/modules/orders/commands").placeAdvanceOrders;
let placeCounterSale: typeof import("@/modules/pos/commands").placeCounterSale;
let cancelOrder: typeof import("@/modules/orders/cancellation").cancelOrder;
let commandErrorResponse: typeof import("@/modules/access/command-route").commandErrorResponse;
let receiptsRoute: Handler;
let reconcileRoute: Handler;
let deliverRoute: Handler;
let salesRoute: Handler;
let directRoute: Handler;
let studentsRoute: Handler;
let catalogRoute: Handler;
let detailRoute: Handler;
let listRoute: Handler;
let entriesRoute: Handler;
let cancelRoute: Handler;
let deterministicId: typeof import("@/lib/firebase/command").deterministicId;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let checkLedger: typeof import("@/modules/wallet/model").checkLedger;
let parseWalletState: typeof import("@/modules/wallet/model").parseWalletState;
let school: typeof import("@/lib/dates/school-time");

let admin: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let studentUser: TestUser;

const tag = randomUUID().slice(0, 6);
const SM = `psf_${tag}_m`;
const ST = `psf_${tag}_t`;
const CLS_A = `pcl_${tag}_a`;
const CLS_B = `pcl_${tag}_b`;
const CAT = `pct_${tag}`;
const CAT_BLOCK = `pcb_${tag}`;
let BASE = "";
let NOW = new Date();
let seq = 0;
const prices = new Map<string, number>();
const noCtx = { params: Promise.resolve({ id: "" }) };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  ({ placeAdvanceOrders } = await import("@/modules/orders/commands"));
  ({ placeCounterSale } = await import("@/modules/pos/commands"));
  ({ cancelOrder } = await import("@/modules/orders/cancellation"));
  ({ commandErrorResponse } = await import("@/modules/access/command-route"));
  receiptsRoute = (await import("@/app/api/inventory/receipts/route")).POST as unknown as Handler;
  reconcileRoute = (await import("@/app/api/inventory/reconcile/route")).GET as unknown as Handler;
  deliverRoute = (await import("@/app/api/operations/orders/[id]/deliver/route")).POST as unknown as Handler;
  salesRoute = (await import("@/app/api/pos/sales/route")).POST as unknown as Handler;
  directRoute = (await import("@/app/api/pos/direct-sales/route")).POST as unknown as Handler;
  studentsRoute = (await import("@/app/api/pos/students/route")).GET as unknown as Handler;
  catalogRoute = (await import("@/app/api/pos/catalog/route")).GET as unknown as Handler;
  detailRoute = (await import("@/app/api/orders/[id]/route")).GET as unknown as Handler;
  listRoute = (await import("@/app/api/orders/route")).GET as unknown as Handler;
  entriesRoute = (await import("@/app/api/wallets/entries/route")).GET as unknown as Handler;
  cancelRoute = (await import("@/app/api/orders/[id]/cancel/route")).POST as unknown as Handler;
  ({ deterministicId } = await import("@/lib/firebase/command"));
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ checkLedger, parseWalletState } = await import("@/modules/wallet/model"));
  school = await import("@/lib/dates/school-time");
  BASE = school.localDateOf(new Date());
  NOW = school.localInstant(BASE, "09:00");
  [admin, guardianA, guardianB, cantina, secretaria, studentUser] = await Promise.all([
    createTestUser("padm", "admin"),
    createTestUser("presp-a", "guardian"),
    createTestUser("presp-b", "guardian"),
    createTestUser("pcant", "cantina"),
    createTestUser("psec", "secretaria"),
    createTestUser("paluno", "student"),
  ]);
  await globalDoc(`shifts/${SM}`, { name: `Manhã ${tag}`, nameSlug: "manha", status: "active" });
  await globalDoc(`shifts/${ST}`, { name: `Tarde ${tag}`, nameSlug: "tarde", status: "active" });
  await globalDoc(`classes/${CLS_A}`, { name: `Turma A ${tag}`, nameSlug: "turma-a", status: "active" });
  await globalDoc(`classes/${CLS_B}`, { name: `Turma B ${tag}`, nameSlug: "turma-b", status: "active" });
  await globalDoc(`categories/${CAT}`, { name: `Categoria ${tag}`, status: "active" });
  await globalDoc(`categories/${CAT_BLOCK}`, { name: `Bloqueada ${tag}`, status: "active" });
  await globalDoc(`calendarDays/${BASE}`, { kind: "extra" }); // hoje funciona (o teste pode rodar em fim de semana)
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
const actorOf = (user: TestUser, role: "guardian" | "cantina" = "guardian") => ({ uid: user.uid, role, permissions: [] as never[] });

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
async function viaCommand(run: () => Promise<object>): Promise<Result> {
  try {
    return { status: 200, body: (await run()) as Json };
  } catch (error) {
    const response = commandErrorResponse(error, "teste");
    return { status: response.status, body: (await response.json()) as Json };
  }
}

type Line = { productId: string; quantity?: number; price?: number };
const linesOf = (lines: Line[]) => lines.map((l) => ({ productId: l.productId, quantity: l.quantity ?? 1, expectedPriceCents: l.price ?? prices.get(l.productId)! }));
const saleBody = (studentId: string, lines: Line[], over: Record<string, unknown> = {}) => ({ key: randomUUID(), studentId, expectedShiftId: ST, lines: linesOf(lines), ...over });
const sell = (user: TestUser | null, body: unknown) => call(salesRoute, user, "POST", "/api/pos/sales", body);
const sellNow = (user: TestUser, body: unknown, clock: () => Date = () => NOW) => viaCommand(() => placeCounterSale(db(), actorOf(user, "cantina"), body, clock));
const directBody = (lines: Line[], over: Record<string, unknown> = {}) => ({ key: randomUUID(), shiftId: ST, lines: linesOf(lines), paymentMethod: "cash", receivedConfirmed: true, ...over });
const direct = (user: TestUser | null, body: unknown) => call(directRoute, user, "POST", "/api/pos/direct-sales", body);
const buy = (user: TestUser, studentId: string, lines: Line[], date = BASE, role: "guardian" | "student" = "guardian") =>
  viaCommand(() => placeAdvanceOrders(db(), { uid: user.uid, role, permissions: [] as never[] }, { key: randomUUID(), studentId, expectedShiftId: ST, days: [{ date, lines: linesOf(lines) }] }, () => NOW));
const deliver = (orderId: string, studentId: string, lines: { lineNo: number; quantity: number }[]) =>
  call(deliverRoute, cantina, "POST", `/api/operations/orders/${orderId}/deliver`, { key: randomUUID(), studentId, lines }, orderId);

async function newStudent(over: { userUid?: string; name?: string; classId?: string; shift?: string; cents?: number; counter?: boolean; site?: boolean; daily?: number; weekly?: number; blocked?: string[]; blockedCats?: string[]; status?: "active" | "inactive" } = {}) {
  const id = `pst_${tag}_${++seq}`;
  const name = over.name ?? `Aluno ${seq}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardianA.uid], allowSitePurchase: over.site ?? true, allowCounterPurchase: over.counter ?? true, studentStatus: over.status ?? "active", ...(over.userUid ? { studentUid: over.userUid } : {}) });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, enrollment: `M${tag}${seq}`, status: over.status ?? "active", userUid: over.userUid ?? null, shiftId: over.shift ?? ST, classId: over.classId ?? CLS_A, version: 3 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, {
    allowSitePurchase: over.site ?? true,
    allowCounterPurchase: over.counter ?? true,
    configVersion: 1,
    ...(over.daily !== undefined ? { dailyLimitCents: over.daily } : {}),
    ...(over.weekly !== undefined ? { weeklyLimitCents: over.weekly } : {}),
    ...(over.blocked ? { blockedProductIds: over.blocked } : {}),
    ...(over.blockedCats ? { blockedCategoryIds: over.blockedCats } : {}),
  });
  if ((over.cents ?? 50000) > 0) await fundDemoWallet(targetFromEnv(), id, over.cents ?? 50000);
  return id;
}

async function newProduct(over: { price?: number; mode?: "physical" | "planned"; stock?: number; channels?: string[]; category?: string } = {}) {
  const id = `ppr_${tag}_${++seq}`;
  const price = over.price ?? 100;
  await globalDoc(`products/${id}`, {
    name: `Produto ${seq}`,
    description: "",
    categoryId: over.category ?? CAT,
    priceCents: price,
    priceVersion: 1,
    channels: over.channels ?? ["advance", "counter"],
    shiftIds: [SM, ST],
    availabilityMode: over.mode ?? "physical",
    status: "active",
    version: 1,
  });
  await globalDoc(`defaultMenuRules/${id}`, { shiftIds: [SM, ST], version: 1 });
  prices.set(id, price);
  if ((over.mode ?? "physical") === "physical" && (over.stock ?? 500) > 0) {
    const r = await call(receiptsRoute, admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: over.stock ?? 500, unitCost: "1,00" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return id;
}
async function receivePlanned(productId: string, quantity: number) {
  const r = await call(receiptsRoute, admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId, kind: "production", quantity, unitCost: "1,00", availableOn: BASE });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Estado observável da venda: carteira/livro, estoque/custo, uso da política, pedidos e vendas diretas. */
async function snapshot(studentId: string | null, productIds: string[]) {
  const wallet = studentId ? await doc(`wallets/${studentId}`) : undefined;
  const stock: Record<string, { onHand: number; reserved: number; movements: number; valueMicros: number }> = {};
  for (const id of productIds) {
    const balance = await doc(`stockBalances/${id}`);
    stock[id] = {
      onHand: Number(balance?.onHand ?? 0),
      reserved: Object.values((balance?.reservedByDate ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0),
      movements: (await db().collection(`stockCosts/${id}/movements`).get()).size,
      valueMicros: Number((await doc(`stockCosts/${id}`))?.valueMicros ?? 0),
    };
  }
  return {
    balanceCents: Number(wallet?.balanceCents ?? 0),
    version: Number(wallet?.version ?? 0),
    entries: studentId ? (await db().collection(`wallets/${studentId}/entries`).get()).size : 0,
    orders: studentId ? (await db().collection("orders").where("studentId", "==", studentId).get()).size : 0,
    dayUsage: studentId ? Number((await doc(`studentUsage/${studentId}/days/${BASE}`))?.committedCents ?? 0) : 0,
    weekUsage: studentId ? Number((await doc(`studentUsage/${studentId}/weeks/${school.weekStartOf(BASE)}`))?.committedCents ?? 0) : 0,
    stock,
  };
}
async function expectLedger(studentId: string) {
  const wallet = parseWalletState(await doc(`wallets/${studentId}`));
  const rows = (await db().collection(`wallets/${studentId}/entries`).orderBy("seq").get()).docs.map((x) => x.data() as { seq: number; amountCents: number; balanceAfterCents: number });
  expect(checkLedger(wallet, rows)).toEqual([]);
}
async function expectStock(productId: string) {
  const r = await call(reconcileRoute, admin, "GET", `/api/inventory/reconcile?productId=${productId}`);
  expect((r.body.products as { problems: string[] }[])[0]!.problems).toEqual([]);
  expect(Number((await doc(`stockBalances/${productId}`))?.onHand ?? 0)).toBeGreaterThanOrEqual(0);
}
const exits = async (productId: string) => (await db().collection(`stockCosts/${productId}/movements`).where("type", "==", "sale_exit").get()).docs.map((x) => x.data());
const noCostLeak = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/cost|Cost|micros|reservationId|movementId|actorUid|createdByUid/i);

/* ------------------------------------------------------------------------------------ venda com saldo (A25) */

describe("venda de balcão com saldo: 10 balas pelo preço do servidor (A25)", () => {
  it("debita UMA vez, registra UM lançamento e UMA baixa, marca entregue e conserva o dinheiro", async () => {
    const bala = await newProduct({ price: 100, stock: 50 });
    const student = await newStudent({ cents: 5000 });
    const before = await snapshot(student, [bala]);
    const body = saleBody(student, [{ productId: bala, quantity: 10 }]);
    const r = await sell(cantina, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, status: "delivered", totalCents: 1000, itemCount: 10, wallet: { balanceCents: 4000, version: before.version + 1 }, consumptionDate: BASE });
    noCostLeak(r.body);

    const orderId = String(r.body.orderId);
    const order = (await doc(`orders/${orderId}`))!;
    expect(order).toMatchObject({ channel: "counter", status: "delivered", studentId: student, consumptionDate: BASE, shiftId: ST, totalCents: 1000, deliveredQty: 10, deliveryCount: 1, version: 1, createdByUid: cantina.uid, walletEntryId: `${orderId}_pay` });
    expect(order.deliveredAt).toBeTruthy();
    expect(order.items).toEqual([expect.objectContaining({ productId: bala, quantity: 10, unitPriceCents: 100, priceVersion: 1, subtotalCents: 1000, deliveredQty: 10 })]);
    expect((order.items as { reservationId?: string }[])[0]!.reservationId).toBeUndefined();

    const after = await snapshot(student, [bala]);
    expect(after).toMatchObject({ balanceCents: 4000, version: before.version + 1, entries: before.entries + 1, orders: 1, dayUsage: 1000, weekUsage: 1000 });
    expect(await doc(`wallets/${student}/entries/${orderId}_pay`)).toMatchObject({ type: "counter_purchase", amountCents: -1000, balanceAfterCents: 4000, orderId, seq: before.version + 1, referenceType: "order" });
    // UMA baixa de estoque, com custo médio histórico (R$ 1,00 × 10) só no livro de estoque.
    expect(after.stock[bala]).toMatchObject({ onHand: 40, reserved: 0, movements: before.stock[bala]!.movements + 1 });
    const [exit] = await exits(bala);
    expect(exit).toMatchObject({ type: "sale_exit", quantity: -10, referenceType: "order", referenceId: orderId, consumptionDate: BASE, revenueCents: 1000 });
    expect(Math.abs(Number(exit!.totalCostMicros))).toBe(10 * Math.abs(Number(exit!.unitCostMicros)));
    expect(await db().collection(`orders/${orderId}/deliveries`).get().then((s) => s.size)).toBe(1);
    expect(await doc(`auditLog/${cantina.uid}__pos.sale__${body.key}`)).toMatchObject({ action: "pos.counter_sale", target: { type: "order", id: orderId }, before: { balanceCents: 5000 }, after: { balanceCents: 4000, totalCents: 1000 } });
    await expectLedger(student);
    await expectStock(bala);
  });

  it("o preço cobrado é o do servidor: valores do cliente são recusados e preço desatualizado exige nova revisão", async () => {
    const p = await newProduct({ price: 250, stock: 20 });
    const student = await newStudent();
    const before = await snapshot(student, [p]);
    for (const extra of [{ totalCents: 1 }, { priceCents: 1 }, { balanceCents: 999999 }, { walletStudentId: "x" }]) {
      const r = await sell(cantina, saleBody(student, [{ productId: p }], extra));
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    const lineWithPrice = { productId: p, quantity: 1, expectedPriceCents: 250, priceCents: 1 };
    expect((await sell(cantina, { ...saleBody(student, []), lines: [lineWithPrice] })).status).toBe(400);
    // O operador viu R$ 2,00, mas o preço atual é R$ 2,50.
    const r = await sell(cantina, saleBody(student, [{ productId: p, quantity: 2, price: 200 }]));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "price_changed", details: { changes: [{ productId: p, expectedPriceCents: 200, currentPriceCents: 250 }], cart: { totalCents: 500 } } });
    expect(await snapshot(student, [p])).toEqual(before);
    // Mudar o preço DEPOIS da venda não altera o pedido gravado (snapshot histórico).
    const ok = await sell(cantina, saleBody(student, [{ productId: p }]));
    expect(ok.status).toBe(200);
    await db().doc(`products/${p}`).update({ priceCents: 999, priceVersion: 2 });
    expect(((await doc(`orders/${String(ok.body.orderId)}`))!.items as { unitPriceCents: number; priceVersion: number }[])[0]).toMatchObject({ unitPriceCents: 250, priceVersion: 1 });
  });

  it("homônimos: a venda debita só a carteira do aluno escolhido (turma/turno distinguem) e o outro fica intacto (A01)", async () => {
    const p = await newProduct({ price: 300, stock: 20 });
    const a = await newStudent({ name: `Maria Homônima ${tag}`, classId: CLS_A, shift: ST, cents: 1000 });
    const b = await newStudent({ name: `Maria Homônima ${tag}`, classId: CLS_B, shift: SM, cents: 1000 });
    const roster = await call(studentsRoute, cantina, "GET", "/api/pos/students");
    expect(roster.status).toBe(200);
    const rows = (roster.body.students as { id: string; name: string; className: string | null; shiftName: string | null }[]).filter((s) => s.name === `Maria Homônima ${tag}`);
    expect(rows.map((s) => [s.id, s.className, s.shiftName]).sort()).toEqual([[a, `Turma A ${tag}`, `Tarde ${tag}`], [b, `Turma B ${tag}`, `Manhã ${tag}`]].sort());
    const beforeB = await snapshot(b, []);
    const r = await sell(cantina, saleBody(a, [{ productId: p }]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await snapshot(b, [])).toEqual(beforeB);
    expect((await snapshot(a, [p])).balanceCents).toBe(700);
    // Turno trocado entre a seleção e a confirmação: recusa para rever.
    const stale = await sell(cantina, saleBody(b, [{ productId: p }])); // b é do turno da manhã, a tela mostrou a tarde
    expect(stale.body).toMatchObject({ error: "shift_changed", details: { shiftId: SM } });
    expect((await snapshot(b, [])).balanceCents).toBe(1000);
  });

  it("várias linhas: um débito somado, uma baixa por produto, itens numerados em ordem estável", async () => {
    const x = await newProduct({ price: 150, stock: 30 });
    const y = await newProduct({ price: 275, stock: 30 });
    const student = await newStudent({ cents: 10000 });
    const r = await sell(cantina, saleBody(student, [{ productId: y, quantity: 2 }, { productId: x, quantity: 3 }]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ totalCents: 2 * 275 + 3 * 150, itemCount: 5 });
    const snap = await snapshot(student, [x, y]);
    expect(snap).toMatchObject({ entries: 2, balanceCents: 10000 - 1000, dayUsage: 1000 });
    expect(snap.stock[x]).toMatchObject({ onHand: 27 });
    expect(snap.stock[y]).toMatchObject({ onHand: 28 });
    await expectLedger(student);
  });
});

/* ---------------------------------------------------------------------------- permissões separadas (A08) */

describe("permissões: site e balcão são independentes e atuais (A08)", () => {
  it("só a cantina/administração operam o PDV; responsável, aluno, secretaria e anônimo são negados sem efeito", async () => {
    const p = await newProduct({ stock: 20 });
    const student = await newStudent();
    const before = await snapshot(student, [p]);
    for (const user of [guardianA, guardianB, studentUser, secretaria]) {
      expect((await sell(user, saleBody(student, [{ productId: p }]))).status).toBe(403);
      expect((await direct(user, directBody([{ productId: p }]))).status).toBe(403);
      expect((await call(studentsRoute, user, "GET", "/api/pos/students")).status).toBe(403);
      expect((await call(catalogRoute, user, "GET", `/api/pos/catalog?shiftId=${ST}`)).status).toBe(403);
    }
    expect((await sell(null, saleBody(student, [{ productId: p }]))).status).toBe(401);
    expect((await direct(null, directBody([{ productId: p }]))).status).toBe(401);
    expect(await snapshot(student, [p])).toEqual(before);
    expect((await sell(admin, saleBody(student, [{ productId: p }]))).status).toBe(200); // a administração também opera
  });

  it("balcão revogado: negado (403), nada gravado; checkout do site do MESMO aluno segue permitido", async () => {
    const p = await newProduct({ stock: 20 });
    const student = await newStudent({ counter: false, site: true });
    const before = await snapshot(student, [p]);
    const r = await sell(cantina, saleBody(student, [{ productId: p }]));
    expect(r.status).toBe(403);
    expect(await snapshot(student, [p])).toEqual(before);
    expect((await buy(guardianA, student, [{ productId: p }])).status).toBe(200);
  });

  it("site revogado (aluno com login) não afeta o balcão: o PDV vende e o checkout do aluno é negado; o responsável segue comprando", async () => {
    const p = await newProduct({ stock: 20 });
    const student = await newStudent({ counter: true, site: false, userUid: studentUser.uid });
    expect((await buy(studentUser, student, [{ productId: p }], BASE, "student")).status).toBe(403);
    expect((await sell(cantina, saleBody(student, [{ productId: p }]))).status).toBe(200);
    expect((await buy(guardianA, student, [{ productId: p }])).status).toBe(200);
  });

  it("o inverso: balcão revogado e site liberado para o aluno com login — checkout do aluno passa, PDV é negado", async () => {
    const p = await newProduct({ stock: 20 });
    const other = await createTestUser("paluno2", "student");
    const student = await newStudent({ counter: false, site: true, userUid: other.uid });
    expect((await buy(other, student, [{ productId: p }], BASE, "student")).status).toBe(200);
    expect((await sell(cantina, saleBody(student, [{ productId: p }]))).status).toBe(403);
  });

  it("revogação ENTRE duas vendas vale na hora; o pedido já entregue permanece e o saldo não se move", async () => {
    const p = await newProduct({ price: 100, stock: 20 });
    const student = await newStudent({ cents: 3000 });
    const first = await sell(cantina, saleBody(student, [{ productId: p }]));
    expect(first.status).toBe(200);
    await db().doc(`studentPolicies/${student}`).update({ allowCounterPurchase: false });
    const mid = await snapshot(student, [p]);
    expect((await sell(cantina, saleBody(student, [{ productId: p }]))).status).toBe(403);
    expect(await snapshot(student, [p])).toEqual(mid);
    expect(await doc(`orders/${String(first.body.orderId)}`)).toMatchObject({ status: "delivered" });
    // Reativar volta a vender.
    await db().doc(`studentPolicies/${student}`).update({ allowCounterPurchase: true });
    expect((await sell(cantina, saleBody(student, [{ productId: p }]))).status).toBe(200);
  });

  it("operador rebaixado/desativado depois do login é negado pelo perfil ATUAL; aluno inativo e inexistente não compram", async () => {
    const p = await newProduct({ stock: 20 });
    const student = await newStudent();
    const temp = await createTestUser("ptemp", "cantina");
    expect((await sell(temp, saleBody(student, [{ productId: p }]))).status).toBe(200);
    await db().doc(`users/${temp.uid}`).update({ status: "disabled" });
    const before = await snapshot(student, [p]);
    expect((await sell(temp, saleBody(student, [{ productId: p }]))).status).toBe(403);
    expect((await direct(temp, directBody([{ productId: p }]))).status).toBe(403);
    await db().doc(`users/${temp.uid}`).update({ status: "active", role: "secretaria" });
    expect((await sell(temp, saleBody(student, [{ productId: p }]))).status).toBe(403);
    expect(await snapshot(student, [p])).toEqual(before);

    const inactive = await newStudent({ status: "inactive" });
    expect((await sell(cantina, saleBody(inactive, [{ productId: p }]))).body).toMatchObject({ error: "student_inactive" });
    expect((await sell(cantina, saleBody(`pst_${tag}_inexistente`, [{ productId: p }]))).body).toMatchObject({ error: "student_not_found" });
  });
});

/* ------------------------------------------------------- bloqueios, limites e exceções (A09, A11 — F09) */

describe("política do responsável no balcão (F09)", () => {
  it("produto e categoria bloqueados: o funcionário NÃO supera (policy_denied) e nada é gravado (A09)", async () => {
    const free = await newProduct({ stock: 20 });
    const blocked = await newProduct({ stock: 20 });
    const inBlockedCat = await newProduct({ stock: 20, category: CAT_BLOCK });
    const student = await newStudent({ blocked: [blocked], blockedCats: [CAT_BLOCK] });
    const before = await snapshot(student, [free, blocked, inBlockedCat]);
    const a = await sell(cantina, saleBody(student, [{ productId: free }, { productId: blocked }]));
    expect(a.body).toMatchObject({ error: "policy_denied", details: { violations: [{ kind: "product_blocked", productId: blocked }] } });
    const b = await sell(cantina, saleBody(student, [{ productId: inBlockedCat }]));
    expect(b.body).toMatchObject({ error: "policy_denied", details: { violations: [{ kind: "category_blocked", categoryId: CAT_BLOCK }] } });
    expect((await sell(admin, saleBody(student, [{ productId: blocked }]))).status).toBe(409); // nem a administração, sem exceção
    expect(await snapshot(student, [free, blocked, inBlockedCat])).toEqual(before);
    expect((await sell(cantina, saleBody(student, [{ productId: free }]))).status).toBe(200); // o resto continua vendendo
  });

  it("exceção de uso único registrada libera UMA venda, fica 'used' com o pedido e não vale de novo; valor acima do teto não passa", async () => {
    const blocked = await newProduct({ price: 200, stock: 20 });
    const student = await newStudent({ blocked: [blocked] });
    const ex = `pex_${tag}_${++seq}`;
    await writeDemoDoc(targetFromEnv(), `studentPolicies/${student}/exceptions/${ex}`, { studentId: student, kind: "admin", status: "active", consumptionDate: BASE, maxCents: 300 });
    const detail = await call(studentsRoute, cantina, "GET", `/api/pos/students?id=${student}`);
    expect(detail.body.exceptions).toEqual([{ id: ex, kind: "admin", maxCents: 300 }]);
    expect((await sell(cantina, saleBody(student, [{ productId: blocked, quantity: 2 }], { exceptionId: ex }))).body).toMatchObject({ error: "policy_denied" }); // R$ 4,00 > R$ 3,00
    const ok = await sell(cantina, saleBody(student, [{ productId: blocked }], { exceptionId: ex }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.override).toEqual({ via: "exception", exceptionId: ex, kind: "admin" });
    expect(await doc(`studentPolicies/${student}/exceptions/${ex}`)).toMatchObject({ status: "used", usedBy: cantina.uid, usedFor: ok.body.orderId });
    expect((await sell(cantina, saleBody(student, [{ productId: blocked }], { exceptionId: ex }))).body).toMatchObject({ error: "policy_denied" });
    // A exceção de OUTRO aluno não vale aqui.
    const other = await newStudent({ blocked: [blocked] });
    expect((await sell(cantina, saleBody(other, [{ productId: blocked }], { exceptionId: ex }))).status).toBe(409);
  });

  it("R$ 8 agendados para hoje com teto diário de R$ 10 deixam R$ 2: R$ 3 recusados, exatos R$ 2 passam; reembolso libera (A11)", async () => {
    const p = await newProduct({ price: 100, stock: 100 });
    const student = await newStudent({ daily: 1000, weekly: 5000, cents: 10000 });
    const adv = await buy(guardianA, student, [{ productId: p, quantity: 8 }]);
    expect(adv.status, JSON.stringify(adv.body)).toBe(200);
    expect((await snapshot(student, [p])).dayUsage).toBe(800);
    const detail = await call(studentsRoute, cantina, "GET", `/api/pos/students?id=${student}`);
    expect(detail.body).toMatchObject({ restrictions: { dailyLimitCents: 1000, dayCommittedCents: 800, remainingTodayCents: 200 } });

    const before = await snapshot(student, [p]);
    const denied = await sell(cantina, saleBody(student, [{ productId: p, quantity: 3 }]));
    expect(denied.body).toMatchObject({ error: "policy_denied", details: { violations: [{ kind: "daily_limit_exceeded", date: BASE, limitCents: 1000, committedCents: 800, requestedCents: 300 }] } });
    expect(await snapshot(student, [p])).toEqual(before);
    expect((await sell(cantina, saleBody(student, [{ productId: p, quantity: 2 }]))).status).toBe(200);
    expect((await snapshot(student, [p])).dayUsage).toBe(1000);
    expect((await sell(cantina, saleBody(student, [{ productId: p }]))).body).toMatchObject({ error: "policy_denied" });

    // Cancelar o pedido antecipado (reembolso) devolve o teto e a venda de R$ 3 passa.
    const orderId = (adv.body.orders as { orderId: string }[])[0]!.orderId;
    const cancel = await viaCommand(() => cancelOrder(db(), actorOf(guardianA), { key: randomUUID(), reason: "Mudança de planos da família", orderId }, () => NOW));
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect((await snapshot(student, [p])).dayUsage).toBe(200);
    expect((await sell(cantina, saleBody(student, [{ productId: p, quantity: 3 }]))).status).toBe(200);
    await expectLedger(student);
  });

  it("limite semanal considera a semana de hoje e vale para o balcão", async () => {
    const p = await newProduct({ price: 100, stock: 100 });
    const student = await newStudent({ weekly: 500, cents: 10000 });
    expect((await sell(cantina, saleBody(student, [{ productId: p, quantity: 5 }]))).status).toBe(200);
    const r = await sell(cantina, saleBody(student, [{ productId: p }]));
    expect(r.body).toMatchObject({ error: "policy_denied", details: { violations: [{ kind: "weekly_limit_exceeded", limitCents: 500, committedCents: 500, requestedCents: 100 }] } });
    expect((await snapshot(student, [p])).weekUsage).toBe(500);
  });
});

/* ------------------------------------------------------------------------------- saldo, calendário, cardápio */

describe("saldo, calendário e cardápio", () => {
  it("saldo insuficiente recusa tudo; saldo exato zera sem ficar negativo", async () => {
    const p = await newProduct({ price: 400, stock: 20 });
    const student = await newStudent({ cents: 700 });
    const before = await snapshot(student, [p]);
    const r = await sell(cantina, saleBody(student, [{ productId: p, quantity: 2 }]));
    expect(r.body).toMatchObject({ error: "insufficient_balance", details: { balanceCents: 700, requiredCents: 800 } });
    expect(await snapshot(student, [p])).toEqual(before);
    const ok = await sell(cantina, saleBody(student, [{ productId: p }]));
    expect(ok.body).toMatchObject({ wallet: { balanceCents: 300 } });
    expect((await sell(cantina, saleBody(student, [{ productId: p }]))).body.error).toBe("insufficient_balance");
    const zero = await newStudent({ cents: 400 });
    expect((await sell(cantina, saleBody(zero, [{ productId: p }]))).body).toMatchObject({ wallet: { balanceCents: 0 } });
    await expectLedger(zero);
  });

  it("aluno sem carteira (nunca recebeu saldo) é recusado por saldo, sem criar carteira", async () => {
    const p = await newProduct({ stock: 5 });
    const student = await newStudent({ cents: 0 });
    expect((await sell(cantina, saleBody(student, [{ productId: p }]))).body).toMatchObject({ error: "insufficient_balance", details: { balanceCents: 0 } });
    expect(await doc(`wallets/${student}`)).toBeUndefined();
  });

  it("o horário de fechamento da compra ANTECIPADA não bloqueia o balcão; dia fechado e turno arquivado bloqueiam", async () => {
    const p = await newProduct({ stock: 20 });
    const student = await newStudent({ cents: 5000 }); // turno da tarde: compra antecipada fecha às 14:00
    const afterCutoff = () => school.localInstant(BASE, "15:30");
    const site = await viaCommand(() => placeAdvanceOrders(db(), actorOf(guardianA), { key: randomUUID(), studentId: student, expectedShiftId: ST, days: [{ date: BASE, lines: linesOf([{ productId: p }]) }] }, afterCutoff));
    expect(site.body.error).toBe("after_cutoff");
    expect((await sellNow(cantina, saleBody(student, [{ productId: p }]), afterCutoff)).status).toBe(200);

    await db().doc(`calendarDays/${BASE}`).update({ kind: "closed" });
    try {
      expect((await sell(cantina, saleBody(student, [{ productId: p }]))).body).toMatchObject({ error: "non_operating_day" });
      expect((await direct(cantina, directBody([{ productId: p }]))).body).toMatchObject({ error: "non_operating_day" });
      expect((await call(catalogRoute, cantina, "GET", `/api/pos/catalog?shiftId=${ST}`)).body).toMatchObject({ service: "closed", products: [] });
    } finally {
      await db().doc(`calendarDays/${BASE}`).update({ kind: "extra" });
    }
    const archived = `psf_${tag}_arq`;
    await globalDoc(`shifts/${archived}`, { name: "Arquivado", nameSlug: "arquivado", status: "archived" });
    expect((await direct(cantina, directBody([{ productId: p }], { shiftId: archived }))).body).toMatchObject({ error: "shift_unavailable" });
  });

  it("produto fora do cardápio de hoje, só do site, suspenso ou desconhecido não é vendido mesmo com o ID enviado à mão", async () => {
    const siteOnly = await newProduct({ channels: ["advance"], stock: 20 });
    const hidden = await newProduct({ stock: 20 });
    const student = await newStudent();
    await db().doc(`menuOverrides/${BASE}__${ST}`).set({ date: BASE, shiftId: ST, suspended: false, serviceReason: "", items: { [hidden]: { include: "hidden", limit: null, reason: "teste" } }, version: 1 });
    try {
      const a = await sell(cantina, saleBody(student, [{ productId: siteOnly, price: 100 }]));
      expect(a.body).toMatchObject({ error: "item_unavailable", details: { productId: siteOnly, reason: "channel_not_allowed" } });
      const b = await sell(cantina, saleBody(student, [{ productId: hidden }]));
      expect(b.body).toMatchObject({ error: "item_unavailable", details: { reason: "not_on_menu" } });
      expect((await sell(cantina, saleBody(student, [{ productId: "nao-existe", price: 100 }]))).body).toMatchObject({ error: "item_unavailable", details: { reason: "product_not_found" } });
      await db().doc(`menuOverrides/${BASE}__${ST}`).update({ suspended: true });
      const cat = await call(catalogRoute, cantina, "GET", `/api/pos/catalog?shiftId=${ST}`);
      expect(cat.body).toMatchObject({ service: "suspended", products: [] });
      expect((await sell(cantina, saleBody(student, [{ productId: hidden }]))).body).toMatchObject({ error: "item_unavailable", details: { reason: "service_suspended" } });
    } finally {
      await db().doc(`menuOverrides/${BASE}__${ST}`).delete();
    }
  });
});

/* -------------------------------------------------------------------------------------------- estoque */

describe("estoque: balcão não vende reserva de outro pedido (A18, A19)", () => {
  it("reservas de pedidos antecipados ficam intocadas; a entrega do pedido reservado continua possível depois", async () => {
    const p = await newProduct({ price: 100, stock: 5 });
    const buyer = await newStudent();
    const adv = await buy(guardianA, buyer, [{ productId: p, quantity: 3 }]);
    expect(adv.status, JSON.stringify(adv.body)).toBe(200);
    const orderId = (adv.body.orders as { orderId: string }[])[0]!.orderId;
    const student = await newStudent();
    const before = await snapshot(student, [p]);
    const denied = await sell(cantina, saleBody(student, [{ productId: p, quantity: 3 }]));
    expect(denied.body).toMatchObject({ error: "insufficient_stock", details: { available: 2, requested: 3 } });
    expect(await snapshot(student, [p])).toEqual(before);
    expect((await sell(cantina, saleBody(student, [{ productId: p, quantity: 2 }]))).status).toBe(200);
    expect((await direct(cantina, directBody([{ productId: p }]))).body).toMatchObject({ error: "insufficient_stock" });
    const delivered = await deliver(orderId, buyer, [{ lineNo: 1, quantity: 3 }]);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(await snapshot(null, [p])).toMatchObject({ stock: { [p]: { onHand: 0, reserved: 0 } } });
    await expectStock(p);
  });

  it("produto planejado sem entrada física: entry_required diz o que registrar; com a entrada, vende", async () => {
    const hot = await newProduct({ mode: "planned", price: 700 });
    const student = await newStudent();
    const r = await sell(cantina, saleBody(student, [{ productId: hot, quantity: 2 }]));
    expect(r.body).toMatchObject({ error: "entry_required", details: { productId: hot, missingUnits: 2 } });
    await receivePlanned(hot, 3);
    const cat = await call(catalogRoute, cantina, "GET", `/api/pos/catalog?shiftId=${ST}`);
    expect((cat.body.products as { id: string; availableUnits: number; mode: string }[]).find((x) => x.id === hot)).toMatchObject({ availableUnits: 3, mode: "planned" });
    expect((await sell(cantina, saleBody(student, [{ productId: hot, quantity: 2 }]))).status).toBe(200);
  });

  it("falha intermediária: 2ª linha sem estoque desfaz a 1ª (carteira, uso, estoque, pedido) e o retry com a mesma chave funciona", async () => {
    const ok = await newProduct({ price: 100, stock: 10 });
    const empty = await newProduct({ price: 100, stock: 1 });
    const student = await newStudent({ cents: 5000 });
    const before = await snapshot(student, [ok, empty]);
    const key = randomUUID();
    const body = saleBody(student, [{ productId: ok, quantity: 2 }, { productId: empty, quantity: 5 }], { key });
    expect((await sell(cantina, body)).body.error).toBe("insufficient_stock");
    expect(await snapshot(student, [ok, empty])).toEqual(before);
    expect(await doc(`idempotencyRecords/${cantina.uid}__pos.sale__${key}`)).toBeUndefined();
    // Mesma chave com o MESMO payload só passa depois que o estoque existe (a recusa não "queimou" a chave).
    await call(receiptsRoute, admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId: empty, kind: "purchase", quantity: 10, unitCost: "1,00" });
    const retry = await sell(cantina, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(false);
    expect((await exits(ok)).length).toBe(1);
  });

  it("falha no ÚLTIMO passo (auditoria): nada persiste; o retry baixa e cobra uma só vez", async () => {
    const p = await newProduct({ price: 100, stock: 10 });
    const student = await newStudent({ cents: 2000 });
    const key = randomUUID();
    const auditId = `${cantina.uid}__pos.sale__${key}`;
    await db().doc(`auditLog/${auditId}`).set({ action: "bloqueio-de-teste" });
    const before = await snapshot(student, [p]);
    const failed = await sell(cantina, saleBody(student, [{ productId: p, quantity: 3 }], { key }));
    expect(failed.status).toBe(500);
    expect(await snapshot(student, [p])).toEqual(before);
    expect(await doc(`orders/${deterministicId("cnt", cantina.uid, key)}`)).toBeUndefined();
    expect(await doc(`idempotencyRecords/${cantina.uid}__pos.sale__${key}`)).toBeUndefined();
    await db().doc(`auditLog/${auditId}`).delete();
    const retry = await sell(cantina, saleBody(student, [{ productId: p, quantity: 3 }], { key }));
    expect(retry.status).toBe(200);
    expect(await snapshot(student, [p])).toMatchObject({ balanceCents: 1700, entries: before.entries + 1, stock: { [p]: { onHand: 7 } } });
    await expectLedger(student);
  });
});

/* ---------------------------------------------------------------------- clique duplo, replay, resposta perdida */

describe("idempotência: clique duplo, replay e resposta perdida", () => {
  it("6 cliques simultâneos com a MESMA chave: UMA venda, UM débito, UMA baixa; todos recebem a mesma venda", async () => {
    const p = await newProduct({ price: 100, stock: 50 });
    const student = await newStudent({ cents: 5000 });
    const before = await snapshot(student, [p]);
    const body = saleBody(student, [{ productId: p, quantity: 4 }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => sell(cantina, body)));
    expect(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body.error))).toBe(true);
    expect(new Set(results.map((r) => r.body.orderId)).size).toBe(1);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    const after = await snapshot(student, [p]);
    expect(after).toMatchObject({ balanceCents: before.balanceCents - 400, entries: before.entries + 1, orders: 1, dayUsage: 400, stock: { [p]: { onHand: 46 } } });
    expect((await exits(p)).length).toBe(1);
    await expectLedger(student);
  });

  it("resposta perdida: repetir com a mesma chave devolve a venda original (replayed) sem novo efeito; chave nova é outra venda", async () => {
    const p = await newProduct({ price: 100, stock: 50 });
    const student = await newStudent({ cents: 5000 });
    const body = saleBody(student, [{ productId: p, quantity: 2 }]);
    const first = await sell(cantina, body);
    const mid = await snapshot(student, [p]);
    const again = await sell(cantina, body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(await snapshot(student, [p])).toEqual(mid);
    // Depois da revogação do balcão a repetição ainda informa o fato já ocorrido (nenhum efeito novo).
    await db().doc(`studentPolicies/${student}`).update({ allowCounterPurchase: false });
    const late = await sell(cantina, body);
    expect(late.body).toEqual({ ...first.body, replayed: true });
    expect(await snapshot(student, [p])).toEqual(mid);
    // Outro operador não reaproveita a chave: a chave é por usuário.
    expect((await sell(admin, body)).status).toBe(403);
    await db().doc(`studentPolicies/${student}`).update({ allowCounterPurchase: true });
    expect((await sell(cantina, saleBody(student, [{ productId: p }]))).body.replayed).toBe(false);
  });

  it("mesma chave com payload diferente é conflito e não grava nada", async () => {
    const p = await newProduct({ stock: 50 });
    const student = await newStudent();
    const body = saleBody(student, [{ productId: p, quantity: 1 }]);
    expect((await sell(cantina, body)).status).toBe(200);
    const mid = await snapshot(student, [p]);
    const other = await sell(cantina, { ...body, lines: linesOf([{ productId: p, quantity: 2 }]) });
    expect(other).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
    expect(await snapshot(student, [p])).toEqual(mid);
  });
});

/* --------------------------------------------------------------------------------------------- disputas */

describe("disputas reais (A18)", () => {
  it("saldo para UMA venda e 6 vendas simultâneas (chaves diferentes): exatamente uma passa e o saldo nunca fica negativo", async () => {
    const p = await newProduct({ price: 400, stock: 50 });
    const student = await newStudent({ cents: 500 });
    const results = await Promise.all(Array.from({ length: 6 }, () => sell(cantina, saleBody(student, [{ productId: p }]))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.error === "insufficient_balance")).toBe(true);
    expect(await snapshot(student, [p])).toMatchObject({ balanceCents: 100, entries: 2, orders: 1, dayUsage: 400, stock: { [p]: { onHand: 49 } } });
    await expectLedger(student);
  });

  it("limite diário de R$ 10 e 4 vendas de R$ 4 simultâneas: no máximo 2 passam; uso == soma das vendas", async () => {
    const p = await newProduct({ price: 400, stock: 50 });
    const student = await newStudent({ daily: 1000, cents: 10000 });
    const results = await Promise.all(Array.from({ length: 4 }, () => sell(cantina, saleBody(student, [{ productId: p }]))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.error === "policy_denied")).toBe(true);
    expect(await snapshot(student, [p])).toMatchObject({ dayUsage: 800, balanceCents: 9200, orders: 2 });
    await expectLedger(student);
  });

  it("último estoque entre dois alunos no PDV: um vende, o outro recebe insufficient_stock; carteira do perdedor intacta", async () => {
    const p = await newProduct({ price: 300, stock: 1 });
    const a = await newStudent({ cents: 1000 });
    const b = await newStudent({ cents: 1000 });
    const [ra, rb] = await Promise.all([sell(cantina, saleBody(a, [{ productId: p }])), sell(cantina, saleBody(b, [{ productId: p }]))]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.body.error).toBe("insufficient_stock");
    const [sa, sb] = await Promise.all([snapshot(a, []), snapshot(b, [])]);
    expect(sa.balanceCents + sb.balanceCents).toBe(2000 - 300);
    expect((await snapshot(null, [p])).stock[p]).toMatchObject({ onHand: 0 });
    expect((await exits(p)).length).toBe(1);
    await expectStock(p);
  });

  it("PDV × venda direta × checkout antecipado pelo último item: nunca vende o que não existe nem a reserva já paga", async () => {
    const p = await newProduct({ price: 100, stock: 2 });
    const students = await Promise.all([newStudent(), newStudent(), newStudent()]);
    const tasks: Promise<Result>[] = [
      sell(cantina, saleBody(students[0]!, [{ productId: p }])),
      sell(cantina, saleBody(students[1]!, [{ productId: p }])),
      direct(cantina, directBody([{ productId: p }])),
      buy(guardianA, students[2]!, [{ productId: p }]),
      buy(guardianA, students[2]!, [{ productId: p }]),
    ];
    const results = await Promise.all(tasks);
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBe(2); // 2 unidades: duas operações vencem, as outras recebem insufficient_stock
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.error === "insufficient_stock")).toBe(true);
    const state = await snapshot(null, [p]);
    // Vendido (saída) + reservado == 2: nada acima do físico.
    expect((await exits(p)).length + state.stock[p]!.reserved + 0).toBe(2);
    expect(state.stock[p]!.onHand + state.stock[p]!.reserved).toBeGreaterThanOrEqual(state.stock[p]!.reserved);
    expect(state.stock[p]!.onHand).toBeGreaterThanOrEqual(0);
    // Quem tem reserva ainda entrega depois (a reserva paga nunca foi vendida no balcão).
    const orders = await db().collection("orders").where("studentId", "==", students[2]!).get();
    for (const o of orders.docs) {
      const d = await deliver(o.id, students[2]!, [{ lineNo: 1, quantity: 1 }]);
      expect(d.status, JSON.stringify(d.body)).toBe(200);
    }
    await expectStock(p);
  });

  it("entrega do pedido reservado concorrente com o PDV pelo último item: a entrega sempre vence a reserva; o PDV só vende o livre", async () => {
    const p = await newProduct({ price: 100, stock: 3 });
    const buyer = await newStudent();
    const adv = await buy(guardianA, buyer, [{ productId: p, quantity: 2 }]);
    const orderId = (adv.body.orders as { orderId: string }[])[0]!.orderId;
    const a = await newStudent();
    const b = await newStudent();
    const [d, ra, rb] = await Promise.all([deliver(orderId, buyer, [{ lineNo: 1, quantity: 2 }]), sell(cantina, saleBody(a, [{ productId: p }])), sell(cantina, saleBody(b, [{ productId: p }]))]);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]); // só 1 unidade livre
    expect((await snapshot(null, [p])).stock[p]).toMatchObject({ onHand: 0, reserved: 0 });
    expect((await exits(p)).length).toBe(2);
    await expectStock(p);
  });
});

/* -------------------------------------------------------------------------------------------- venda direta */

describe("venda direta sem aluno: lançamento separado, sem carteira", () => {
  it("dinheiro: registra a venda, baixa estoque/custo e NÃO toca carteira, livro, uso nem pedidos; resposta sem custo", async () => {
    const p = await newProduct({ price: 350, stock: 20 });
    const bystander = await newStudent({ cents: 1000 });
    const walletsBefore = (await db().collection("wallets").get()).size;
    const ordersBefore = (await db().collection("orders").get()).size;
    const bystanderBefore = await snapshot(bystander, [p]);
    const body = directBody([{ productId: p, quantity: 3 }], { buyerKind: "teacher", buyerNote: "Prof. Joana" });
    const r = await direct(cantina, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, totalCents: 1050, itemCount: 3, paymentMethod: "cash", fee: { status: "none", cents: 0 }, netCents: 1050, consumptionDate: BASE });
    noCostLeak(r.body);
    const saleId = String(r.body.saleId);
    expect(await doc(`directSales/${saleId}`)).toMatchObject({
      channel: "counter_direct",
      status: "completed",
      totalCents: 1050,
      payment: { method: "cash", receivedCents: 1050, receivedConfirmed: true, fee: { status: "none" } },
      buyerKind: "teacher",
      buyerNote: "Prof. Joana",
      createdByUid: cantina.uid,
    });
    expect(await doc(`orders/${saleId}`)).toBeUndefined();
    expect((await db().collection("wallets").get()).size).toBe(walletsBefore);
    expect((await db().collection("orders").get()).size).toBe(ordersBefore);
    expect(await snapshot(bystander, [p])).toEqual({ ...bystanderBefore, stock: (await snapshot(bystander, [p])).stock });
    const [exit] = await exits(p);
    expect(exit).toMatchObject({ referenceType: "directSale", referenceId: saleId, quantity: -3, revenueCents: 1050 });
    expect(Math.abs(Number(exit!.totalCostMicros))).toBe(3 * Math.abs(Number(exit!.unitCostMicros)));
    expect((await snapshot(null, [p])).stock[p]).toMatchObject({ onHand: 17 });
    expect(await doc(`auditLog/${cantina.uid}__pos.direct_sale__${body.key}`)).toMatchObject({ action: "pos.direct_sale", target: { type: "directSale", id: saleId } });
    await expectStock(p);
  });

  it("só registra após o recebimento confirmado: sem confirmação, sem meio válido ou com campos de aluno/carteira é recusado (400), sem efeito", async () => {
    const p = await newProduct({ stock: 20 });
    const before = await snapshot(null, [p]);
    const base = directBody([{ productId: p }]);
    const { receivedConfirmed: _drop, ...noConfirm } = base;
    void _drop;
    for (const bad of [noConfirm, { ...base, receivedConfirmed: false }, { ...base, paymentMethod: "boleto" }, { ...base, paymentMethod: undefined }, { ...base, studentId: "x" }, { ...base, walletCents: 5 }, { ...base, buyerNote: "=HYPERLINK(1)" }, { ...base, feeCents: -1 }]) {
      expect((await direct(cantina, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await snapshot(null, [p])).toEqual(before);
    expect((await db().collection("directSales").where("createdByUid", "==", cantina.uid).where("totalCents", "==", 999999).get()).size).toBe(0);
  });

  it("meios e taxa: cartão com taxa informada registra o líquido; Pix/cartão sem valor ficam pendentes; taxa > venda e taxa em dinheiro são recusadas", async () => {
    const p = await newProduct({ price: 1000, stock: 30 });
    const card = await direct(cantina, directBody([{ productId: p }], { paymentMethod: "card_credit", feeCents: 35 }));
    expect(card.body).toMatchObject({ paymentMethod: "card_credit", fee: { status: "informed", cents: 35, source: "operator" }, netCents: 965 });
    const pix = await direct(cantina, directBody([{ productId: p }], { paymentMethod: "pix" }));
    expect(pix.body).toMatchObject({ fee: { status: "pending", cents: null }, netCents: null });
    const debit = await direct(cantina, directBody([{ productId: p }], { paymentMethod: "card_debit", feeCents: 0 }));
    expect(debit.body).toMatchObject({ fee: { status: "informed", cents: 0 }, netCents: 1000 });
    const before = await snapshot(null, [p]);
    expect((await direct(cantina, directBody([{ productId: p }], { paymentMethod: "pix", feeCents: 1001 }))).body.error).toBe("invalid_fee");
    expect((await direct(cantina, directBody([{ productId: p }], { paymentMethod: "cash", feeCents: 10 }))).body.error).toBe("invalid_fee");
    // Dinheiro: a regra do meio vem antes (mesmo com taxa acima do total) e taxa 0 é aceita.
    expect((await direct(cantina, directBody([{ productId: p }], { paymentMethod: "cash", feeCents: 5000 }))).body).toMatchObject({ error: "invalid_fee", details: { feeCents: 5000 } });
    expect(await snapshot(null, [p])).toEqual(before);
    // Taxa 0 em dinheiro é aceita (e baixa uma unidade).
    const before0 = await snapshot(null, [p]);
    expect((await direct(cantina, directBody([{ productId: p }], { paymentMethod: "cash", feeCents: 0 }))).body).toMatchObject({ fee: { status: "none", cents: 0 }, netCents: 1000 });
    expect((await snapshot(null, [p])).stock[p]!.onHand).toBe(before0.stock[p]!.onHand - 1);
  });

  it("preço do servidor: valor visto diferente exige nova revisão; clique duplo e replay não duplicam recebimento nem baixa", async () => {
    const p = await newProduct({ price: 500, stock: 30 });
    expect((await direct(cantina, directBody([{ productId: p, price: 450 }]))).body).toMatchObject({ error: "price_changed", details: { cart: { totalCents: 500 } } });
    const body = directBody([{ productId: p, quantity: 2 }], { paymentMethod: "pix", feeCents: 20 });
    const results = await Promise.all(Array.from({ length: 6 }, () => direct(cantina, body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.saleId)).size).toBe(1);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect((await exits(p)).length).toBe(1);
    expect((await snapshot(null, [p])).stock[p]).toMatchObject({ onHand: 28 });
    const other = await direct(cantina, { ...body, lines: linesOf([{ productId: p, quantity: 3 }]) });
    expect(other).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
  });

  it("falha intermediária (2ª linha sem estoque) desfaz a 1ª: nada vendido, nada registrado", async () => {
    const ok = await newProduct({ stock: 10 });
    const empty = await newProduct({ stock: 1 });
    const before = await snapshot(null, [ok, empty]);
    const r = await direct(cantina, directBody([{ productId: ok, quantity: 2 }, { productId: empty, quantity: 5 }]));
    expect(r.body.error).toBe("insufficient_stock");
    expect(await snapshot(null, [ok, empty])).toEqual(before);
  });
});

/* ------------------------------------------------------------------ leituras do PDV (aluno, catálogo) */

describe("leituras do PDV: aluno com saldo/restrições e catálogo do balcão", () => {
  it("detalhe do aluno: turma/turno, saldo, permissão e restrições; aluno inexistente = 404; sem custo nem dados do responsável", async () => {
    const blocked = await newProduct({ stock: 5 });
    const student = await newStudent({ cents: 1234, daily: 900, weekly: 3000, blocked: [blocked], counter: false });
    const r = await call(studentsRoute, cantina, "GET", `/api/pos/students?id=${student}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      student: { id: student, className: `Turma A ${tag}`, shiftName: `Tarde ${tag}`, status: "active" },
      wallet: { balanceCents: 1234 },
      counterAllowed: false,
      restrictions: { dailyLimitCents: 900, weeklyLimitCents: 3000, dayCommittedCents: 0, remainingTodayCents: 900, blockedProductIds: [blocked] },
      today: BASE,
    });
    expect(JSON.stringify(r.body)).not.toMatch(/guardian|email|phone|userUid/i);
    expect((await call(studentsRoute, cantina, "GET", `/api/pos/students?id=pst_${tag}_nada`)).status).toBe(404);
    // Aluno inativo/arquivado: nem saldo nem política saem pelo PDV (mesma regra da lista, só ativos).
    const archived = await newStudent({ status: "inactive", cents: 777 });
    expect(await call(studentsRoute, cantina, "GET", `/api/pos/students?id=${archived}`)).toMatchObject({ status: 404, body: { error: "student_not_found" } });
  });

  it("lista de alunos: só ativos, ordenados, com turma e turno; arquivados não aparecem", async () => {
    const active = await newStudent({ name: `Zélia Ativa ${tag}` });
    const inactive = await newStudent({ name: `Zélia Inativa ${tag}`, status: "inactive" });
    const r = await call(studentsRoute, cantina, "GET", "/api/pos/students");
    const rows = r.body.students as { id: string; name: string }[];
    expect(r.body.truncated).toBe(false);
    expect(rows.some((s) => s.id === active)).toBe(true);
    expect(rows.some((s) => s.id === inactive)).toBe(false);
    expect(rows.map((s) => s.name)).toEqual([...rows.map((s) => s.name)].sort((x, y) => x.localeCompare(y, "pt-BR")));
  });

  it("catálogo: só canal balcão do turno, com preço atual e unidades livres (reservas descontadas); nunca custo", async () => {
    const p = await newProduct({ price: 180, stock: 10 });
    const siteOnly = await newProduct({ channels: ["advance"], stock: 10 });
    const buyer = await newStudent();
    expect((await buy(guardianA, buyer, [{ productId: p, quantity: 4 }])).status).toBe(200);
    const r = await call(catalogRoute, cantina, "GET", `/api/pos/catalog?shiftId=${ST}`);
    expect(r.status).toBe(200);
    const products = r.body.products as { id: string; priceCents: number; availableUnits: number; categoryName: string }[];
    expect(products.find((x) => x.id === p)).toMatchObject({ priceCents: 180, availableUnits: 6, categoryName: `Categoria ${tag}` });
    expect(products.some((x) => x.id === siteOnly)).toBe(false);
    expect(r.body).toMatchObject({ service: "open", today: BASE, shiftId: ST });
    noCostLeak(r.body);
    expect((await call(catalogRoute, cantina, "GET", "/api/pos/catalog")).status).toBe(400);
  });
});

/* ------------------------------------------------------------------- Meus pedidos, extrato e recibo */

describe("integração com Meus pedidos, extrato e recibo (A26)", () => {
  it("a família vê a venda de balcão como concluída (filtro por canal), com recibo e extrato; sem dados internos", async () => {
    const p = await newProduct({ price: 120, stock: 20 });
    const student = await newStudent({ cents: 2000 });
    const adv = await buy(guardianA, student, [{ productId: p }]); // pedido antecipado do mesmo aluno
    const sale = await sell(cantina, saleBody(student, [{ productId: p, quantity: 3 }]));
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const orderId = String(sale.body.orderId);

    const done = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${student}&group=completed&channel=counter`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((done.body.orders as { orderId: string }[]).map((o) => o.orderId)).toEqual([orderId]);
    expect((done.body.orders as { channel: string; status: string; group: string; totalCents: number }[])[0]).toMatchObject({ channel: "counter", status: "delivered", group: "completed", totalCents: 360 });
    const pending = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${student}&group=pending`);
    expect((pending.body.orders as { orderId: string }[]).map((o) => o.orderId)).toEqual([(adv.body.orders as { orderId: string }[])[0]!.orderId]);
    const all = await call(listRoute, guardianA, "GET", `/api/orders?studentId=${student}&channel=advance`);
    expect((all.body.orders as { channel: string }[]).every((o) => o.channel === "advance")).toBe(true);

    const detail = await call(detailRoute, guardianA, "GET", `/api/orders/${orderId}`, undefined, orderId);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      channel: "counter",
      status: "delivered",
      totalCents: 360,
      cancelable: false,
      items: [{ quantity: 3, deliveredQty: 3, remainingQty: 0, unitPriceCents: 120, subtotalCents: 360 }],
      receipt: { amountCents: -360, balanceAfterCents: Number((sale.body.wallet as { balanceCents: number }).balanceCents), walletEntryId: `${orderId}_pay` },
      purchasedBy: "staff",
    });
    expect((detail.body.timeline as { kind: string }[]).map((t) => t.kind)).toEqual(expect.arrayContaining(["created", "delivery"]));
    noCostLeak(detail.body);

    const entries = await call(entriesRoute, guardianA, "GET", `/api/wallets/entries?studentId=${student}`);
    expect(entries.status, JSON.stringify(entries.body)).toBe(200);
    expect((entries.body.entries as { type: string; amountCents: number }[]).find((e) => e.type === "counter_purchase")).toMatchObject({ amountCents: -360 });

    // Outra família e outra conta não leem; o responsável não cancela venda já entregue no balcão.
    expect((await call(detailRoute, guardianB, "GET", `/api/orders/${orderId}`, undefined, orderId)).status).toBe(403);
    const cancel = await call(cancelRoute, guardianA, "POST", `/api/orders/${orderId}/cancel`, { key: randomUUID(), reason: "Mudança de planos da família" }, orderId);
    expect(cancel.status).toBe(409);
  });

  it("a administração e a cantina não leem o recibo da família por esta rota (somente a visão do PDV); a lista do dia da cantina segue só com antecipados", async () => {
    const p = await newProduct({ stock: 20 });
    const student = await newStudent();
    const sale = await sell(cantina, saleBody(student, [{ productId: p }]));
    const orderId = String(sale.body.orderId);
    expect((await call(detailRoute, cantina, "GET", `/api/orders/${orderId}`, undefined, orderId)).status).toBe(403);
    const dayRoute = (await import("@/app/api/operations/orders/route")).GET as unknown as Handler;
    const day = await call(dayRoute, cantina, "GET", `/api/operations/orders?date=${BASE}`);
    expect((day.body.orders as { orderId: string }[]).some((o) => o.orderId === orderId)).toBe(false);
    // O pedido de balcão não pode ser entregue/preparado de novo (já entregue, canal diferente).
    const again = await deliver(orderId, student, [{ lineNo: 1, quantity: 1 }]);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("channel_not_supported");
  });
});
