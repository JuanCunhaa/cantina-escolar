// Smoke DIRIGIDO de estoque, entradas e custo médio (F10) na homologação (emulador ou aplicação publicada). Só produtos
// FICTÍCIOS próprios (criados pela API do catálogo e desativados no fim) e movimentos próprios; nada existente é alterado
// nem apagado, e não há dinheiro (custo de estoque é contábil, sem carteira). Reservas, baixa por entrega e venda de balcão
// são contratos chamados dentro da transação do pedido (F11/F13/F15): não há rota HTTP para eles, então a prova de
// reserva × saída, FEFO e concorrência é do emulador (tests/integration/inventory-api.test.ts). Aqui: comandos, custos,
// papéis, Security Rules publicadas e reconciliação no Firestore real.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { createTempProduct, prepareCatalog, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { bearer, fsRequest } from "./helpers";

const tag = Math.random().toString(36).slice(2, 7);
let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let family: TestUser;
let physicalId = "";
let plannedId = "";
let shiftId = "";

test.describe.configure({ mode: "serial" });

const post = (request: APIRequestContext, user: TestUser | null, url: string, data: Record<string, unknown>, key: string = randomUUID()) =>
  request.post(url, { headers: user ? bearer(user.idToken) : {}, data: { key, ...data } });
const get = (request: APIRequestContext, user: TestUser | null, url: string) => request.get(url, { headers: user ? bearer(user.idToken) : {} });
const localDate = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() + offsetDays * 86_400_000));
type Detail = { onHand: number; valueMicros?: number; averageUnitMicros?: number; receipts?: unknown[]; movements: { type: string; quantity: number; totalCostMicros?: number }[]; capacities: { date: string; capacity: number | null }[] };
const detail = async (request: APIRequestContext, user: TestUser, id: string) => {
  const response = await get(request, user, `/api/inventory/product?productId=${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Detail;
};

test.beforeAll(async ({ request }) => {
  await prepareCatalog();
  [admin, cantina, secretaria, family] = await Promise.all([
    createTestUser("hml-iadm", "admin"),
    createTestUser("hml-icant", "cantina"),
    createTestUser("hml-isec", "secretaria"),
    createTestUser("hml-ifam", "guardian"),
  ]);
  physicalId = await createTempProduct(request, admin.idToken, `Estoque físico ${tag}`);
  plannedId = await createTempProduct(request, admin.idToken, `Estoque planejado ${tag}`, { availabilityMode: "planned" });
  const listing = await fsRequest(family.idToken, "GET", "shifts?pageSize=1");
  shiftId = ((listing.body.documents as { name: string }[] | undefined) ?? [])[0]?.name.split("/").pop() ?? "";
  expect(shiftId, "ao menos um turno na homologação").toBeTruthy();
});

test.afterAll(async ({ request }) => {
  for (const id of [physicalId, plannedId]) if (id) await retireTempProduct(request, admin.idToken, id).catch(() => undefined);
});

test("API: duas compras viram duas entradas, média R$ 1,05, replay idempotente, custo inválido recusado e reconciliação fecha (A20/A21)", async ({ request }) => {
  const key = randomUUID();
  const body = { action: "create", productId: physicalId, kind: "purchase", quantity: 100, unitCost: "1,00" };
  const first = await post(request, admin, "/api/inventory/receipts", body, key);
  expect(first.status()).toBe(200);
  expect(await (await post(request, admin, "/api/inventory/receipts", body, key)).json()).toMatchObject({ replayed: true });
  expect((await post(request, admin, "/api/inventory/receipts", { ...body, quantity: 101 }, key)).status()).toBe(409);
  expect((await post(request, admin, "/api/inventory/receipts", { ...body, unitCost: "1,10" })).status()).toBe(200);
  for (const bad of ["0", "1,12345", "abc"]) expect((await post(request, admin, "/api/inventory/receipts", { ...body, unitCost: bad })).status(), bad).toBe(422);
  const view = await detail(request, admin, physicalId);
  expect(view).toMatchObject({ onHand: 200, valueMicros: 21_000_000_000, averageUnitMicros: 105_000_000 });
  expect(view.receipts).toHaveLength(2);
  const reconcile = await get(request, admin, `/api/inventory/reconcile?productId=${physicalId}`);
  expect(await reconcile.json()).toMatchObject({ ok: true, products: [{ problems: [], onHand: 200 }] });
});

test("API: perda pela cantina sem custo; estoque nunca negativo; contagem desatualizada recusada; papéis e anônimo negados (A19/A30)", async ({ request }) => {
  const loss = await post(request, cantina, "/api/inventory/losses", { productId: physicalId, quantity: 4, reason: "breakage", note: "quebra no smoke" });
  expect(loss.status()).toBe(200);
  const lossBody = (await loss.json()) as Record<string, unknown>;
  expect(lossBody).not.toHaveProperty("totalCostMicros");
  expect(lossBody.state).not.toHaveProperty("valueMicros");
  expect((await post(request, cantina, "/api/inventory/losses", { productId: physicalId, quantity: 500, reason: "discard", note: "além do físico" })).status()).toBe(409);
  const view = await detail(request, admin, physicalId);
  expect(view.onHand).toBe(196);
  const stale = await post(request, admin, "/api/inventory/adjustments", { action: "count", productId: physicalId, countedQuantity: 190, expectedSeq: 1, reason: "contagem desatualizada" });
  expect([stale.status(), (await stale.json()).error]).toEqual([409, "stale_count"]);
  const entry = { action: "create", productId: physicalId, kind: "purchase", quantity: 1, unitCost: "1,00" };
  for (const user of [cantina, secretaria, family]) {
    expect((await post(request, user, "/api/inventory/receipts", entry)).status()).toBe(403);
    expect((await post(request, user, "/api/inventory/capacity", { productId: plannedId, date: localDate(1), shiftId, capacity: 3 })).status()).toBe(403);
  }
  for (const user of [secretaria, family]) {
    expect((await post(request, user, "/api/inventory/losses", { productId: physicalId, quantity: 1, reason: "discard", note: "negado" })).status()).toBe(403);
    expect((await get(request, user, "/api/inventory")).status()).toBe(403);
  }
  expect((await post(request, null, "/api/inventory/receipts", entry)).status()).toBe(401);
  expect((await get(request, cantina, `/api/inventory/reconcile?productId=${physicalId}`)).status()).toBe(403);
  // A cantina vê quantidades, nunca custo.
  const cantinaView = (await (await get(request, cantina, `/api/inventory/product?productId=${physicalId}`)).json()) as Record<string, unknown>;
  expect(cantinaView).toMatchObject({ onHand: 196 });
  expect(cantinaView).not.toHaveProperty("valueMicros");
  expect(cantinaView).not.toHaveProperty("receipts");
});

test("API: produto planejado exige data de disponibilidade; cota por data/turno; entrada vira estoque físico", async ({ request }) => {
  const planned = { action: "create", productId: plannedId, kind: "production", quantity: 10, unitCost: "2,50" };
  expect([(await post(request, admin, "/api/inventory/receipts", planned)).status(), (await (await post(request, admin, "/api/inventory/receipts", planned)).json()).error]).toEqual([422, "available_on_required"]);
  expect((await post(request, admin, "/api/inventory/capacity", { productId: plannedId, date: localDate(1), shiftId, capacity: 25 })).status()).toBe(200);
  expect((await post(request, admin, "/api/inventory/capacity", { productId: plannedId, date: localDate(-1), shiftId, capacity: 25 })).status()).toBe(422);
  expect((await post(request, admin, "/api/inventory/receipts", { ...planned, availableOn: localDate(0) })).status()).toBe(200);
  const view = await detail(request, admin, plannedId);
  expect(view).toMatchObject({ onHand: 10, valueMicros: 2_500_000_000 });
  expect(view.capacities.find((c) => c.date === localDate(1))).toMatchObject({ capacity: 25 });
  expect(await (await get(request, admin, `/api/inventory/reconcile?productId=${plannedId}`)).json()).toMatchObject({ ok: true });
});

test("Rules publicadas: quantidades só para cantina e administração; custos e entradas fechados ao cliente; ninguém escreve (A30/A33)", async () => {
  for (const [label, user] of [["cantina", cantina], ["administração", admin]] as const) {
    expect((await fsRequest(user.idToken, "GET", `stockBalances/${physicalId}`)).status, `saldo: ${label}`).toBe(200);
    expect((await fsRequest(user.idToken, "GET", `stockBalances/${physicalId}/lots`)).status, `lotes: ${label}`).toBe(200);
    expect((await fsRequest(user.idToken, "PATCH", `stockBalances/${physicalId}`, { onHand: { integerValue: "9999" } })).status, `escrita: ${label}`).toBe(403);
  }
  for (const [label, user] of [["cantina", cantina], ["administração", admin], ["secretaria", secretaria]] as const) {
    expect((await fsRequest(user.idToken, "GET", `stockCosts/${physicalId}`)).status, `custos: ${label}`).toBe(403);
    expect((await fsRequest(user.idToken, "GET", `stockCosts/${physicalId}/movements`)).status, `livro com custo: ${label}`).toBe(403);
    expect((await fsRequest(user.idToken, "GET", "stockReceipts")).status, `entradas: ${label}`).toBe(403);
  }
  for (const [label, token] of [["família", family.idToken], ["secretaria", secretaria.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", `stockBalances/${physicalId}`)).status, `saldo: ${label}`).toBe(403);
    expect((await fsRequest(token, "GET", `dailyCapacity/${plannedId}_${localDate(1)}_${shiftId}`)).status, `cota: ${label}`).toBe(403);
  }
  expect((await fsRequest(cantina.idToken, "GET", `dailyCapacity/${plannedId}_${localDate(1)}_${shiftId}`)).status).toBe(200);
});
