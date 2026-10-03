import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, targetFromEnv, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context?: never) => Promise<Response>;
type Json = Record<string, unknown>;
type StockSession = import("@/modules/inventory/session").StockSession;

let receiptsRoute: Handler;
let lossesRoute: Handler;
let adjustmentsRoute: Handler;
let capacityRoute: Handler;
let overviewRoute: Handler;
let productRoute: Handler;
let reconcileRoute: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let openStockSession: typeof import("@/modules/inventory/session").openStockSession;
let COMMAND_TRANSACTION: typeof import("@/lib/firebase/transaction-options").COMMAND_TRANSACTION;
let localDateOf: typeof import("@/lib/dates/school-time").localDateOf;
let addDays: typeof import("@/lib/dates/school-time").addDays;
let DomainError: typeof import("@/lib/domain-error").DomainError;

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardian: TestUser;
let studentLogin: TestUser;

const tag = randomUUID().slice(0, 6);
let counter = 0;
let TODAY = "";
let TOMORROW = "";
const SHIFT = `shf_${tag}`;
void targetFromEnv;

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  receiptsRoute = (await import("@/app/api/inventory/receipts/route")).POST as Handler;
  lossesRoute = (await import("@/app/api/inventory/losses/route")).POST as Handler;
  adjustmentsRoute = (await import("@/app/api/inventory/adjustments/route")).POST as Handler;
  capacityRoute = (await import("@/app/api/inventory/capacity/route")).POST as Handler;
  overviewRoute = (await import("@/app/api/inventory/route")).GET as Handler;
  productRoute = (await import("@/app/api/inventory/product/route")).GET as Handler;
  reconcileRoute = (await import("@/app/api/inventory/reconcile/route")).GET as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ openStockSession } = await import("@/modules/inventory/session"));
  ({ COMMAND_TRANSACTION } = await import("@/lib/firebase/transaction-options"));
  ({ localDateOf, addDays } = await import("@/lib/dates/school-time"));
  ({ DomainError } = await import("@/lib/domain-error"));
  TODAY = localDateOf(new Date());
  TOMORROW = addDays(TODAY, 1);
  admin = await createTestUser("iadm", "admin");
  cantina = await createTestUser("icant", "cantina");
  secretaria = await createTestUser("isec", "secretaria");
  guardian = await createTestUser("iresp", "guardian");
  studentLogin = await createTestUser("ialu", "student");
  await adminDb().doc(`shifts/${SHIFT}`).set({ name: `Turno ${tag}`, status: "active" });
});

function req(method: string, url: string, token: string | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const post = (handler: Handler, url: string, user: TestUser | null, body: Json, key: string = randomUUID()) => handler(req("POST", url, user?.idToken ?? null, { key, ...body }));
const json = async (response: Response) => (await response.json()) as Json & { error?: string; details?: Json };

async function product(mode: "physical" | "planned"): Promise<string> {
  const id = `prd_${tag}_${++counter}`;
  await adminDb().doc(`products/${id}`).set({ name: `Produto ${mode} ${counter}`, availabilityMode: mode, status: "active", priceCents: 200 });
  return id;
}
async function receive(user: TestUser, productId: string, quantity: number, unitCost: string, extra: Json = {}, kind = "purchase") {
  const response = await post(receiptsRoute, "/api/inventory/receipts", user, { action: "create", productId, kind, quantity, unitCost, ...extra });
  return { status: response.status, body: await json(response) };
}
const detail = async (user: TestUser, productId: string) => {
  const response = await productRoute(req("GET", `/api/inventory/product?productId=${productId}`, user.idToken));
  expect(response.status).toBe(200);
  return (await response.json()) as {
    onHand: number;
    reservedUnits: number;
    valueMicros?: number;
    averageUnitMicros?: number;
    receipts?: Json[];
    lots: { id: string; remaining: number; validThrough: string }[];
    movements: { seq: number; type: string; quantity: number; totalCostMicros?: number; grossProfitCents?: number | null; unitCostMicros?: number }[];
    reservations: { id: string; remaining: number }[];
    capacities: { date: string; capacity: number | null; reserved: number; delivered: number; available: number; version: number }[];
  };
};
const reconcileOf = async (productId: string) => {
  const response = await reconcileRoute(req("GET", `/api/inventory/reconcile?productId=${productId}`, admin.idToken));
  expect(response.status).toBe(200);
  return (await response.json()) as { ok: boolean; products: { problems: string[]; onHand: number; valueMicros: number; movementCount: number }[] };
};
const expectReconciled = async (productId: string) => {
  const result = await reconcileOf(productId);
  expect(result.products[0]!.problems).toEqual([]);
  expect(result.ok).toBe(true);
  return result.products[0]!;
};

/** Executa o contrato de estoque como o checkout/entrega/PDV farão: sessão dentro da transação, planejar, depois commit. */
async function inTx<T>(work: (session: StockSession) => Promise<T>, options: { today?: string; commit?: boolean } = {}): Promise<T> {
  const db = adminDb();
  return db.runTransaction(async (tx) => {
    const session = openStockSession(db, tx, { today: options.today ?? TODAY, actor: { uid: "teste", role: "admin" } });
    const result = await work(session);
    if (options.commit !== false) session.commit();
    return result;
  }, COMMAND_TRANSACTION);
}
async function attempt<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string; details?: Json }> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, code: error.code, details: error.details };
    throw error;
  }
}
const reserve = (productId: string, quantity: number, reservationId: string, date = TOMORROW, extra: Json = {}) =>
  inTx((s) => s.reserve({ productId, quantity, consumptionDate: date, shiftId: SHIFT, reservationId, orderRef: `ord_${reservationId}`, ...extra }));
const sell = (productId: string, quantity: number, extra: { reservationId?: string; date?: string; revenueCents?: number; today?: string } = {}) =>
  inTx((s) => s.exit({ productId, quantity, consumptionDate: extra.date ?? TODAY, reservationId: extra.reservationId, referenceType: "test", referenceId: randomUUID(), revenueCents: extra.revenueCents }), { today: extra.today });
const setCapacity = (productId: string, date: string, capacity: number) => post(capacityRoute, "/api/inventory/capacity", admin, { productId, date, shiftId: SHIFT, capacity });
const bal = async (productId: string) => (await adminDb().doc(`stockBalances/${productId}`).get()).data()!;

describe("A20 — custo médio, margem e custo histórico", () => {
  it("100 a R$ 1,00 + 100 a R$ 1,10 viram DUAS entradas; média R$ 1,05; vender 10 a R$ 2 → receita 20, CMV 10,50, lucro bruto 9,50", async () => {
    const p = await product("physical");
    expect((await receive(admin, p, 100, "1,00")).status).toBe(200);
    expect((await receive(admin, p, 100, "1,10")).status).toBe(200);
    const before = await detail(admin, p);
    expect(before.receipts).toHaveLength(2);
    expect(before).toMatchObject({ onHand: 200, valueMicros: 21_000_000_000, averageUnitMicros: 105_000_000 });
    const exit = await sell(p, 10, { revenueCents: 2000 });
    expect(exit.totalCostMicros).toBe(1_050_000_000);
    const after = await detail(admin, p);
    expect(after.onHand).toBe(190);
    expect(after.valueMicros).toBe(21_000_000_000 - 1_050_000_000);
    const sale = after.movements.find((m) => m.type === "sale_exit")!;
    expect(sale).toMatchObject({ quantity: -10, totalCostMicros: -1_050_000_000, grossProfitCents: 950 });
    await expectReconciled(p);
  });

  it("A21 — custo médio com saída entre compras e resíduo; mudar custo/preço depois NÃO altera a saída histórica", async () => {
    const p = await product("physical");
    await receive(admin, p, 3, "1,0000");
    await receive(admin, p, 2, "1,0001");
    // 1×1,0000 + 4×… valor 300 020 000 / 3? aqui 5 unidades: 100 000 000 + ... (3 a 1,00 + 2 a 1,0001) = 500 020 000
    const first = await sell(p, 2);
    expect(first.totalCostMicros).toBe(200_008_000); // 500 020 000 × 2 / 5
    await receive(admin, p, 10, "2,0000"); // nova compra depois da saída
    const history = await adminDb().doc(`stockCosts/${p}/movements/m${String(first.seq).padStart(9, "0")}`).get();
    expect(history.get("totalCostMicros")).toBe(-200_008_000);
    await adminDb().doc(`products/${p}`).update({ priceCents: 999 }); // preço de venda mudou: saída histórica intacta
    const again = await adminDb().doc(`stockCosts/${p}/movements/m${String(first.seq).padStart(9, "0")}`).get();
    expect(again.get("totalCostMicros")).toBe(-200_008_000);
    // esvaziar: a última unidade leva o resíduo e o valor volta a zero
    const rest = (await detail(admin, p)).onHand;
    await sell(p, rest);
    const state = await expectReconciled(p);
    expect(state).toMatchObject({ onHand: 0, valueMicros: 0 });
  });

  it("cantina e demais papéis não veem custo; administração vê", async () => {
    const p = await product("physical");
    await receive(admin, p, 10, "3,00");
    await sell(p, 1, { revenueCents: 500 });
    const adminView = await detail(admin, p);
    expect(adminView.valueMicros).toBeDefined();
    expect(adminView.receipts).toHaveLength(1);
    const cantinaView = (await detail(cantina, p)) as Json;
    expect(cantinaView.valueMicros).toBeUndefined();
    expect(cantinaView.averageUnitMicros).toBeUndefined();
    expect(cantinaView.receipts).toBeUndefined();
    for (const m of cantinaView.movements as Json[]) {
      expect(m.totalCostMicros).toBeUndefined();
      expect(m.unitCostMicros).toBeUndefined();
      expect(m.grossProfitCents).toBeUndefined();
    }
    const overview = (await (await overviewRoute(req("GET", "/api/inventory", cantina.idToken))).json()) as { canSeeCosts: boolean; items: Json[] };
    expect(overview.canSeeCosts).toBe(false);
    for (const item of overview.items) expect(item.valueMicros).toBeUndefined();
    const adminOverview = (await (await overviewRoute(req("GET", "/api/inventory", admin.idToken))).json()) as { canSeeCosts: boolean; items: { productId: string; valueMicros?: number }[] };
    expect(adminOverview.items.find((i) => i.productId === p)?.valueMicros).toBeGreaterThan(0);
  });
});

describe("autorização e validação das entradas", () => {
  it("só a administração registra entrada/ajuste/cota; cantina registra perda; família, aluno, secretaria e anônimo são negados", async () => {
    const p = await product("physical");
    await receive(admin, p, 5, "1,00");
    const entry = { action: "create", productId: p, kind: "purchase", quantity: 1, unitCost: "1,00" };
    for (const user of [cantina, guardian, studentLogin, secretaria]) {
      expect((await post(receiptsRoute, "/api/inventory/receipts", user, entry)).status).toBe(403);
      expect((await post(adjustmentsRoute, "/api/inventory/adjustments", user, { action: "threshold", productId: p, minStock: 1 })).status).toBe(403);
      expect((await post(capacityRoute, "/api/inventory/capacity", user, { productId: p, date: TODAY, shiftId: SHIFT, capacity: 3 })).status).toBe(403);
    }
    for (const user of [guardian, studentLogin, secretaria]) {
      expect((await post(lossesRoute, "/api/inventory/losses", user, { productId: p, quantity: 1, reason: "breakage", note: "caiu no chão" })).status).toBe(403);
      expect((await productRoute(req("GET", `/api/inventory/product?productId=${p}`, user.idToken))).status).toBe(403);
      expect((await overviewRoute(req("GET", "/api/inventory", user.idToken))).status).toBe(403);
    }
    expect((await post(receiptsRoute, "/api/inventory/receipts", null, entry)).status).toBe(401);
    expect((await reconcileRoute(req("GET", "/api/inventory/reconcile", cantina.idToken))).status).toBe(403);
    expect((await post(lossesRoute, "/api/inventory/losses", cantina, { productId: p, quantity: 1, reason: "breakage", note: "caiu no chão" })).status).toBe(200);
    expect((await detail(cantina, p)).onHand).toBe(4);
  });

  it("custo zero/inválido, quantidade inválida, planejado sem data e produto inexistente são recusados sem escrever nada", async () => {
    const p = await product("physical");
    const planned = await product("planned");
    expect((await receive(admin, p, 5, "0")).status).toBe(422);
    expect((await receive(admin, p, 5, "1,12345")).body.error).toBe("invalid_cost");
    expect((await receive(admin, p, 0, "1,00")).status).toBe(400);
    expect((await receive(admin, p, 5, "1,00", { expiresOn: addDays(TODAY, -1) })).body.error).toBe("invalid_expiry");
    expect((await receive(admin, planned, 5, "1,00", {}, "production")).body.error).toBe("available_on_required");
    expect((await receive(admin, planned, 5, "1,00", { availableOn: addDays(TODAY, -1) }, "production")).body.error).toBe("date_out_of_window");
    expect((await receive(admin, `prd_${tag}_inexistente`, 5, "1,00")).status).toBe(404);
    expect((await adminDb().collection(`stockCosts/${p}/movements`).get()).size).toBe(0);
  });

  it("replay devolve a resposta original sem nova entrada; mesma chave com payload diferente é conflito", async () => {
    const p = await product("physical");
    const key = randomUUID();
    const body = { action: "create", productId: p, kind: "purchase", quantity: 7, unitCost: "2,00" };
    const first = await json(await post(receiptsRoute, "/api/inventory/receipts", admin, body, key));
    const second = await json(await post(receiptsRoute, "/api/inventory/receipts", admin, body, key));
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, receiptId: first.receiptId });
    expect((await detail(admin, p)).onHand).toBe(7);
    const conflict = await post(receiptsRoute, "/api/inventory/receipts", admin, { ...body, quantity: 8 }, key);
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error).toBe("idempotency_conflict");
    expect((await detail(admin, p)).onHand).toBe(7);
    await expectReconciled(p);
  });
});

describe("A19 — reserva não é saída; saída física acontece uma vez", () => {
  it("reservar e liberar não mudam o físico nem o custo; cancelar não cria entrada; a entrega baixa uma única vez", async () => {
    const p = await product("physical");
    await receive(admin, p, 10, "1,50");
    const base = await detail(admin, p);
    await reserve(p, 4, "res_a");
    const reserved = await detail(admin, p);
    expect(reserved).toMatchObject({ onHand: 10, reservedUnits: 4, valueMicros: base.valueMicros });
    expect(reserved.movements).toHaveLength(base.movements.length); // reserva não é movimento contábil
    const released = await inTx((s) => s.release({ productId: p, reservationId: "res_a" }));
    expect(released).toMatchObject({ releasedQuantity: 4, remaining: 0 });
    const afterRelease = await detail(admin, p);
    expect(afterRelease).toMatchObject({ onHand: 10, reservedUnits: 0, valueMicros: base.valueMicros });
    expect(afterRelease.movements).toHaveLength(base.movements.length); // sem entrada fictícia

    await reserve(p, 4, "res_b", TODAY);
    const exit = await sell(p, 4, { reservationId: "res_b" });
    expect(exit.totalCostMicros).toBe(600_000_000);
    expect(await detail(admin, p)).toMatchObject({ onHand: 6, reservedUnits: 0 });
    // entregar de novo a mesma reserva é recusado: nada baixa duas vezes
    expect((await attempt(() => sell(p, 4, { reservationId: "res_b" }))).ok).toBe(false);
    expect(await detail(admin, p)).toMatchObject({ onHand: 6 });
    await expectReconciled(p);
  });

  it("produto planejado: reserva usa só a cota; a entrega exige a entrada física e informa exatamente o que registrar", async () => {
    const p = await product("planned");
    expect(await attempt(() => reserve(p, 1, "pl_0", TODAY))).toMatchObject({ ok: false, code: "capacity_not_set" });
    expect((await setCapacity(p, TODAY, 5)).status).toBe(200);
    await reserve(p, 2, "pl_1", TODAY);
    await reserve(p, 3, "pl_2", TODAY);
    expect(await attempt(() => reserve(p, 1, "pl_3", TODAY))).toMatchObject({ ok: false, code: "capacity_exceeded", details: { available: 0, limit: 5 } });
    expect(await detail(admin, p)).toMatchObject({ onHand: 0, reservedUnits: 5 }); // disponibilidade planejada ≠ produto produzido

    const missing = await attempt(() => sell(p, 2, { reservationId: "pl_1" }));
    expect(missing).toMatchObject({ ok: false, code: "entry_required", details: { missingUnits: 2, date: TODAY, productId: p } });
    expect((await detail(admin, p)).movements).toHaveLength(0);

    expect((await receive(admin, p, 3, "2,50", { availableOn: TODAY }, "production")).status).toBe(200);
    const delivered = await sell(p, 2, { reservationId: "pl_1" });
    expect(delivered.totalCostMicros).toBe(500_000_000);
    const afterFirst = await detail(admin, p);
    expect(afterFirst).toMatchObject({ onHand: 1 });
    expect(afterFirst.capacities.find((c) => c.date === TODAY)).toMatchObject({ reserved: 3, delivered: 2, capacity: 5, available: 0 }); // sem duplo desconto de cota
    expect(await attempt(() => sell(p, 3, { reservationId: "pl_2" }))).toMatchObject({ ok: false, code: "entry_required", details: { missingUnits: 2 } });
    await sell(p, 1, { reservationId: "pl_2" }); // entrega parcial
    expect(await attempt(() => sell(p, 1))).toMatchObject({ ok: false, code: "entry_required" }); // balcão não inventa unidade
    await inTx((s) => s.release({ productId: p, reservationId: "pl_2" })); // libera o restante sem criar entrada
    expect(await detail(admin, p)).toMatchObject({ onHand: 0, reservedUnits: 0 });
    expect((await detail(admin, p)).capacities.find((c) => c.date === TODAY)).toMatchObject({ reserved: 0, delivered: 3 });
    await expectReconciled(p);
  });

  it("balcão de planejado com mais de uma página de lotes e reservas na data não falha à toa (regressão da revisão)", async () => {
    const p = await product("planned");
    for (let i = 0; i < 12; i++) expect((await receive(admin, p, 1, "1,00", { availableOn: TODAY }, "production")).status).toBe(200); // 12 lotes de 1 unidade (> 1 página de 10)
    expect((await setCapacity(p, TODAY, 5)).status).toBe(200);
    await reserve(p, 1, "pag_res", TODAY);
    const exit = await sell(p, 10); // 12 físicas − 1 reservada = 11 livres
    expect(exit.allocations).toHaveLength(10);
    expect(await attempt(() => sell(p, 2))).toMatchObject({ ok: false, code: "entry_required" }); // sobra 1 livre + 1 reservada
    expect((await sell(p, 1)).quantity).toBe(1);
    expect((await sell(p, 1, { reservationId: "pag_res" })).quantity).toBe(1); // a reservada continua entregável
    await expectReconciled(p);
  }, 90000);

  it("sobra de planejado não vira estoque do dia seguinte sozinha: precisa de ação explícita (ampliar validade) ou perda", async () => {
    const p = await product("planned");
    await receive(admin, p, 4, "2,00", { availableOn: TODAY }, "production");
    expect(await attempt(() => sell(p, 1, { today: TOMORROW, date: TOMORROW }))).toMatchObject({ ok: false, code: "entry_required" });
    const lot = (await detail(admin, p)).lots[0]!;
    const extended = await post(adjustmentsRoute, "/api/inventory/adjustments", admin, { action: "extend", productId: p, lotId: lot.id, validThrough: TOMORROW, reason: "sobra vira balcão amanhã" });
    expect(extended.status).toBe(200);
    expect((await sell(p, 1, { today: TOMORROW, date: TOMORROW })).quantity).toBe(1);
    await expectReconciled(p);
  });
});

describe("lotes, validade e FEFO", () => {
  it("lote vencido não é usado; sai primeiro o que vence antes; reserva respeita a validade; perda do lote vencido exige ação explícita", async () => {
    const p = await product("physical");
    const lotA = await receive(admin, p, 5, "1,00", { expiresOn: TOMORROW, lotCode: "A1" });
    await receive(admin, p, 5, "1,20", { lotCode: "B1" });
    const overview = (await (await overviewRoute(req("GET", "/api/inventory", admin.idToken))).json()) as { items: { productId: string; expiringUnits: number; availableUnits: number }[] };
    expect(overview.items.find((i) => i.productId === p)).toMatchObject({ expiringUnits: 5, availableUnits: 10 });

    const far = addDays(TODAY, 5);
    expect(await attempt(() => reserve(p, 6, "val_1", far))).toMatchObject({ ok: false, code: "insufficient_stock", details: { available: 5 } }); // lote A vence antes do dia 5
    await reserve(p, 5, "val_2", far);
    expect(await attempt(() => sell(p, 6))).toMatchObject({ ok: false, code: "insufficient_stock" }); // as 5 reservadas não são vendidas no balcão
    const exit = await sell(p, 5);
    expect(exit.allocations).toEqual([{ lotId: lotA.body.lotId, quantity: 5 }]); // FEFO: o que vence antes sai primeiro
    expect((await detail(admin, p)).reservations.map((r) => r.id)).toEqual(["val_2"]);

    // com o relógio no dia seguinte ao vencimento, o lote B (sem validade) segue elegível; um lote vencido não é usado
    const q = await product("physical");
    const expiring = await receive(admin, q, 4, "1,00", { expiresOn: TODAY });
    expect(await attempt(() => sell(q, 1, { today: TOMORROW, date: TOMORROW }))).toMatchObject({ ok: false, code: "insufficient_stock", details: { expiredUnits: 4 } });
    const loss = await post(lossesRoute, "/api/inventory/losses", cantina, { productId: q, quantity: 4, reason: "expiry", note: "lote vencido", lotId: expiring.body.lotId });
    expect(loss.status).toBe(200);
    expect(await loss.json()).not.toHaveProperty("totalCostMicros"); // cantina não vê custo
    expect(await detail(admin, q)).toMatchObject({ onHand: 0, valueMicros: 0 });
    await expectReconciled(q);
    await expectReconciled(p);
  });
});

describe("A18 — disputas: nada reserva nem baixa além da disponibilidade", () => {
  const writers = 8;

  it("último item: 8 vendas simultâneas de 1 unidade, só 1 passa; físico e valor terminam em zero", async () => {
    const p = await product("physical");
    await receive(admin, p, 1, "1,3333");
    const results = await Promise.all(Array.from({ length: writers }, () => attempt(() => sell(p, 1))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "insufficient_stock")).toBe(true);
    expect(await expectReconciled(p)).toMatchObject({ onHand: 0, valueMicros: 0, movementCount: 2 });
  }, 90000);

  it("8 reservas simultâneas sobre 5 unidades: exatamente 5 passam e o físico não muda", async () => {
    const p = await product("physical");
    await receive(admin, p, 5, "1,00");
    const results = await Promise.all(Array.from({ length: writers }, (_, i) => attempt(() => reserve(p, 1, `race_${i}`))));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "insufficient_stock")).toBe(true);
    expect(await detail(admin, p)).toMatchObject({ onHand: 5, reservedUnits: 5 });
    await expectReconciled(p);
  }, 90000);

  it("balcão × reserva: com 5 em estoque e 3 reservadas, 6 vendas simultâneas de balcão levam no máximo 2", async () => {
    const p = await product("physical");
    await receive(admin, p, 5, "1,00");
    await reserve(p, 3, "pdv_res", TODAY);
    const results = await Promise.all(Array.from({ length: 6 }, () => attempt(() => sell(p, 1))));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await detail(admin, p)).toMatchObject({ onHand: 3, reservedUnits: 3 });
    expect((await sell(p, 3, { reservationId: "pdv_res" })).quantity).toBe(3); // a reserva continua entregável
    expect(await expectReconciled(p)).toMatchObject({ onHand: 0, valueMicros: 0 });
  }, 90000);

  it("cota planejada: 8 reservas simultâneas com cota 4 → exatamente 4", async () => {
    const p = await product("planned");
    expect((await setCapacity(p, TOMORROW, 4)).status).toBe(200);
    const results = await Promise.all(Array.from({ length: writers }, (_, i) => attempt(() => reserve(p, 1, `quota_${i}`))));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "capacity_exceeded")).toBe(true);
    const cap = (await detail(admin, p)).capacities.find((c) => c.date === TOMORROW)!;
    expect(cap).toMatchObject({ reserved: 4, delivered: 0, available: 0 });
    await expectReconciled(p);
  }, 90000);

  it("entrega × cancelamento da MESMA reserva: só um vence e as unidades são conservadas", async () => {
    const p = await product("physical");
    await receive(admin, p, 6, "1,00");
    await reserve(p, 2, "dup_res", TODAY);
    const results = await Promise.all([attempt(() => sell(p, 2, { reservationId: "dup_res" })), attempt(() => inTx((s) => s.release({ productId: p, reservationId: "dup_res" })))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const state = await detail(admin, p);
    const delivered = results[0]!.ok;
    expect(state.onHand).toBe(delivered ? 4 : 6);
    expect(state.reservedUnits).toBe(0);
    await expectReconciled(p);
  }, 90000);

  it("falha forçada depois do commit na mesma transação não deixa reserva, saldo, cota nem movimento parciais", async () => {
    const p = await product("planned");
    await setCapacity(p, TOMORROW, 3);
    const before = await bal(p).catch(() => null);
    await expect(
      inTx(
        async (s) => {
          await s.reserve({ productId: p, quantity: 2, consumptionDate: TOMORROW, shiftId: SHIFT, reservationId: "atomic_1", orderRef: "ord_atomic" });
          s.commit();
          throw new Error("falha forçada no meio");
        },
        { commit: false },
      ),
    ).rejects.toThrow("falha forçada");
    expect((await adminDb().doc(`stockBalances/${p}/reservations/atomic_1`).get()).exists).toBe(false);
    expect(await bal(p).catch(() => null)).toEqual(before);
    expect((await detail(admin, p)).capacities.find((c) => c.date === TOMORROW)).toMatchObject({ reserved: 0 });
    // e depois do erro a cota continua inteira
    await reserve(p, 3, "atomic_2");
    await expectReconciled(p);
  }, 60000);
});

describe("perdas, inventário, ajustes e estorno", () => {
  it("perda que deixa pedidos reservados sem lastro é registrada e destaca os pedidos; a entrega fictícia é recusada", async () => {
    const p = await product("physical");
    await receive(admin, p, 5, "1,00");
    await reserve(p, 4, "loss_res", addDays(TODAY, 2));
    const loss = await json(await post(lossesRoute, "/api/inventory/losses", cantina, { productId: p, quantity: 3, reason: "breakage", note: "caixa caiu" }));
    expect(loss).toMatchObject({ shortfallUnits: 2, quantity: 3 });
    expect(loss.affectedReservations).toEqual([expect.objectContaining({ reservationId: "loss_res", orderRef: "ord_loss_res", remaining: 4 })]);
    expect((await detail(admin, p)).onHand).toBe(2);
    expect(await attempt(() => sell(p, 4, { reservationId: "loss_res", date: addDays(TODAY, 2), today: addDays(TODAY, 2) }))).toMatchObject({ ok: false, code: "insufficient_stock" });
    expect(await attempt(() => sell(p, 1))).toMatchObject({ ok: false, code: "insufficient_stock" }); // as 2 restantes continuam comprometidas
    await expectReconciled(p);
  });

  it("estoque físico nunca fica negativo: perda maior que o físico é recusada", async () => {
    const p = await product("physical");
    await receive(admin, p, 2, "1,00");
    const response = await post(lossesRoute, "/api/inventory/losses", admin, { productId: p, quantity: 3, reason: "discard", note: "descarte" });
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe("insufficient_stock");
    expect((await detail(admin, p)).onHand).toBe(2);
  });

  it("contagem física: diferença vira movimento auditado ao custo médio; contagem desatualizada é recusada; positivo sem custo e sem estoque exige custo", async () => {
    const p = await product("physical");
    await receive(admin, p, 10, "2,00");
    const seq = (await detail(admin, p)).movements[0]!.seq;
    const stale = await post(adjustmentsRoute, "/api/inventory/adjustments", admin, { action: "count", productId: p, countedQuantity: 8, expectedSeq: seq - 1, reason: "contagem do mês" });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toBe("stale_count");
    const counted = await json(await post(adjustmentsRoute, "/api/inventory/adjustments", admin, { action: "count", productId: p, countedQuantity: 8, expectedSeq: seq, reason: "contagem do mês" }));
    expect(counted).toMatchObject({ changed: true, delta: -2, totalCostMicros: 400_000_000 });
    const same = await json(await post(adjustmentsRoute, "/api/inventory/adjustments", admin, { action: "count", productId: p, countedQuantity: 8, expectedSeq: seq + 1, reason: "recontagem" }));
    expect(same).toMatchObject({ changed: false, delta: 0, movementId: null });
    const found = await json(await post(adjustmentsRoute, "/api/inventory/adjustments", admin, { action: "adjust", productId: p, delta: 2, reason: "achado no depósito" }));
    expect(found).toMatchObject({ delta: 2, totalCostMicros: 400_000_000 }); // valorizado ao custo médio
    const view = await detail(admin, p);
    expect(view.movements.map((m) => m.type)).toEqual(["adjustment", "count_adjustment", "receipt"]);
    expect(view).toMatchObject({ onHand: 10, valueMicros: 2_000_000_000 });

    const empty = await product("physical");
    const noCost = await post(adjustmentsRoute, "/api/inventory/adjustments", admin, { action: "adjust", productId: empty, delta: 3, reason: "estoque inicial" });
    expect(noCost.status).toBe(409);
    expect((await json(noCost)).error).toBe("cost_required");
    expect((await post(adjustmentsRoute, "/api/inventory/adjustments", admin, { action: "adjust", productId: empty, delta: 3, reason: "estoque inicial", unitCost: "0,50" })).status).toBe(200);
    await expectReconciled(p);
    await expectReconciled(empty);
  });

  it("estorno de entrada: vale enquanto intacta (valor exato volta); depois de consumo ou já estornada é recusado", async () => {
    const p = await product("physical");
    const a = await receive(admin, p, 10, "1,00");
    const b = await receive(admin, p, 5, "1,10");
    const reverse = (id: unknown) => post(receiptsRoute, "/api/inventory/receipts", admin, { action: "reverse", receiptId: id, reason: "entrada lançada no produto errado" });
    const ok = await reverse(b.body.receiptId);
    expect(ok.status).toBe(200);
    expect(await detail(admin, p)).toMatchObject({ onHand: 10, valueMicros: 1_000_000_000 });
    expect((await json(await reverse(b.body.receiptId))).error).toBe("receipt_reversed");
    await sell(p, 1);
    const consumed = await reverse(a.body.receiptId);
    expect(consumed.status).toBe(409);
    expect((await json(consumed)).error).toBe("receipt_consumed");
    expect((await detail(admin, p)).onHand).toBe(9);
    const types = (await detail(admin, p)).movements.map((m) => m.type);
    expect(types).toEqual(["sale_exit", "receipt_reversal", "receipt", "receipt"]); // histórico preservado, nada apagado
    await expectReconciled(p);
  });

  it("estorno que deixaria reservas sem lastro é recusado", async () => {
    const p = await product("physical");
    const a = await receive(admin, p, 5, "1,00");
    await reserve(p, 4, "rev_res", TOMORROW);
    const response = await post(receiptsRoute, "/api/inventory/receipts", admin, { action: "reverse", receiptId: a.body.receiptId, reason: "lançamento duplicado" });
    expect(response.status).toBe(409);
    expect((await json(response)).error).toBe("reserved_units");
    expect((await detail(admin, p)).onHand).toBe(5);
  });

  it("cota: reduzir abaixo do comprometido não cancela reservas; versão desatualizada é recusada", async () => {
    const p = await product("planned");
    await setCapacity(p, TOMORROW, 5);
    await reserve(p, 4, "cap_1");
    const cap = (await detail(admin, p)).capacities.find((c) => c.date === TOMORROW)!;
    const reduced = await json(await post(capacityRoute, "/api/inventory/capacity", admin, { productId: p, date: TOMORROW, shiftId: SHIFT, capacity: 2, expectedVersion: cap.version }));
    expect(reduced).toMatchObject({ capacity: 2, reserved: 4, changed: true });
    expect((await detail(admin, p)).reservations).toHaveLength(1);
    const stale = await post(capacityRoute, "/api/inventory/capacity", admin, { productId: p, date: TOMORROW, shiftId: SHIFT, capacity: 9, expectedVersion: cap.version });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toBe("stale_capacity");
    expect(await attempt(() => reserve(p, 1, "cap_2"))).toMatchObject({ ok: false, code: "capacity_exceeded" });
    expect((await post(capacityRoute, "/api/inventory/capacity", admin, { productId: p, date: addDays(TODAY, -1), shiftId: SHIFT, capacity: 1 })).status).toBe(422);
    expect((await post(capacityRoute, "/api/inventory/capacity", admin, { productId: p, date: TOMORROW, shiftId: "shf_inexistente", capacity: 1 })).status).toBe(422);
  });

  it("estoque mínimo gera alerta de estoque baixo", async () => {
    const p = await product("physical");
    await receive(admin, p, 6, "1,00");
    expect((await post(adjustmentsRoute, "/api/inventory/adjustments", admin, { action: "threshold", productId: p, minStock: 5 })).status).toBe(200);
    const low = async () => {
      const overview = (await (await overviewRoute(req("GET", "/api/inventory", cantina.idToken))).json()) as { items: { productId: string; lowStock: boolean }[] };
      return overview.items.find((i) => i.productId === p)!.lowStock;
    };
    expect(await low()).toBe(false);
    await reserve(p, 2, "min_res");
    expect(await low()).toBe(true); // disponível 4 ≤ mínimo 5
  });
});

describe("reconciliação", () => {
  it("detecta divergência introduzida fora do contrato (lote alterado diretamente)", async () => {
    const p = await product("physical");
    await receive(admin, p, 5, "1,00");
    await expectReconciled(p);
    const lot = (await detail(admin, p)).lots[0]!;
    await adminDb().doc(`stockBalances/${p}/lots/${lot.id}`).update({ remaining: 4 });
    const result = await reconcileOf(p);
    expect(result.ok).toBe(false);
    expect(result.products[0]!.problems.length).toBeGreaterThan(0);
    const all = await reconcileRoute(req("GET", "/api/inventory/reconcile", admin.idToken));
    expect(all.status).toBe(200);
  });
});

describe("catálogo × estoque: o modo do produto não muda com estoque ou reservas", () => {
  it("trocar físico ↔ planejado é recusado com unidades em estoque ou reservas ativas e permitido sem elas", async () => {
    const school = (await import("@/app/api/school/route")).POST as Handler;
    const categories = (await import("@/app/api/catalog/categories/route")).POST as Handler;
    const products = (await import("@/app/api/catalog/products/route")).POST as Handler;
    const ok = async (handler: Handler, url: string, body: Json) => {
      const response = await post(handler, url, admin, body);
      expect(response.status).toBe(200);
      return (await response.json()) as Json & { id: string; version: number };
    };
    const shift = (await ok(school, "/api/school", { action: "create", kind: "shift", name: `Turno modo ${tag}` })).id;
    const category = (await ok(categories, "/api/catalog/categories", { action: "create", name: `Categoria modo ${tag}` })).id;
    const create = (name: string, availabilityMode: string) =>
      ok(products, "/api/catalog/products", { action: "create", name, description: "", categoryId: category, priceCents: 300, channels: ["advance"], shiftIds: [shift], availabilityMode });
    const switchMode = (id: string, version: number, availabilityMode: string) =>
      post(products, "/api/catalog/products", admin, { action: "update", id, expectedVersion: version, name: `Produto modo ${id}`, description: "", categoryId: category, channels: ["advance"], shiftIds: [shift], availabilityMode });

    // Com unidades em estoque: recusado e nada muda.
    const withStock = await create(`Com estoque ${tag}`, "physical");
    await receive(admin, withStock.id, 3, "1,00");
    const blocked = await switchMode(withStock.id, withStock.version, "planned");
    expect([blocked.status, (await json(blocked)).error]).toEqual([409, "mode_in_use"]);
    expect((await adminDb().doc(`products/${withStock.id}`).get()).get("availabilityMode")).toBe("physical");

    // Planejado sem unidades, mas com reserva ativa: recusado.
    const withReservation = await create(`Com reserva ${tag}`, "planned");
    expect((await post(capacityRoute, "/api/inventory/capacity", admin, { productId: withReservation.id, date: TOMORROW, shiftId: shift, capacity: 5 })).status).toBe(200);
    await inTx((s) => s.reserve({ productId: withReservation.id, quantity: 1, consumptionDate: TOMORROW, shiftId: shift, reservationId: "modo_res", orderRef: "ord_modo" }));
    const blockedReservation = await switchMode(withReservation.id, withReservation.version, "physical");
    expect([blockedReservation.status, (await json(blockedReservation)).error]).toEqual([409, "mode_in_use"]);

    // Sem estoque e sem reservas: permitido.
    const empty = await create(`Vazio ${tag}`, "physical");
    expect((await switchMode(empty.id, empty.version, "planned")).status).toBe(200);
    expect((await adminDb().doc(`products/${empty.id}`).get()).get("availabilityMode")).toBe("planned");
  });
});
