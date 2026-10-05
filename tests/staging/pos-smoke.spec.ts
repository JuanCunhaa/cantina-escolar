// Smoke DIRIGIDO do PDV de balcão e da venda direta (F15) na homologação (emulador ou aplicação publicada), SEM crédito
// artificial: o aluno fictício tem carteira R$ 0,00 e continua assim, então NÃO existe venda com saldo. Prova o que é possível
// sem dinheiro: autorização por papel nas rotas novas, leituras reais do Firestore (alunos ativos, aluno com saldo/restrições,
// cardápio do balcão com estoque), a ordem das recusas da venda com saldo (nada gravado depois de cada uma), a VENDA DIRETA
// (recebimento local registrado, sem carteira: usa produto fictício próprio, com entrada de estoque própria e custo só no livro
// de estoque), replay idempotente, Security Rules (directSales e pedidos de balcão fechados) e a tela.
// NÃO prova: venda com saldo (débito + livro + baixa + marcação de entregue), limites com consumo comprometido, concorrência e
// disputa pelo último estoque no Firestore real — isso só existe no emulador (tests/integration/pos-api.test.ts, e2e/pos.spec.ts).
// Não há provedor de pagamento: a venda direta é só o REGISTRO do recebimento feito no balcão.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { DEMO_SHIFTS } from "../../scripts/lib/demo-seed.ts";
import { localDateOf } from "../../src/lib/dates/school-time";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { createTempProduct, fixtureIds, prepareCatalog, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const TODAY = localDateOf(new Date());
let fam: Family;
let cantina: TestUser;
let secretaria: TestUser;
let morning = "";
let productId = "";
let productName = "";
let openedDay = false;

type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: user ? bearer(user.idToken) : {}, data });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
const get = (request: APIRequestContext, user: TestUser | null, url: string) => call(request, user, "GET", url);
const post = (request: APIRequestContext, user: TestUser | null, url: string, data: Record<string, unknown>, key = randomUUID()) => call(request, user, "POST", url, { key, ...data });
const noCost = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/cost|Cost|micros|actorUid|createdByUid/i);
const stockOf = async (request: APIRequestContext, user: TestUser) => ((await get(request, user, `/api/inventory/product?productId=${productId}`)).body as { onHand: number }).onHand;

test.beforeAll(async ({ request }) => {
  await prepareCatalog();
  fam = await createFamily(request, `hml-pos-${tag}`);
  cantina = await createTestUser(`hml-pos-cant-${tag}`, "cantina");
  secretaria = await createTestUser(`hml-pos-sec-${tag}`, "secretaria");
  morning = (await fixtureIds()).shift(DEMO_SHIFTS[0].name);
  // O balcão só vende em dia de funcionamento: se hoje não for (ex.: fim de semana), abre uma exceção só durante o smoke.
  const window = await get(request, fam.guardian, `/api/school/calendar?shiftId=${morning}`);
  const today = ((window.body.days as { date: string; operating: boolean }[] | undefined) ?? []).find((d) => d.date === TODAY);
  if (today && !today.operating) {
    const set = await post(request, fam.admin, "/api/school/calendar", { action: "set", date: TODAY, kind: "extra", reason: "Smoke do PDV (fictício)" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    openedDay = true;
  }
  productName = `PDV fictício ${tag}`;
  productId = await createTempProduct(request, fam.admin.idToken, productName, { priceCents: 300, shiftIds: [morning] });
  const menu = await post(request, fam.admin, "/api/menu", { action: "setDefault", productId, shiftIds: [morning], expectedVersion: 0 });
  expect(menu.status, JSON.stringify(menu.body)).toBe(200);
  const entry = await post(request, fam.admin, "/api/inventory/receipts", { action: "create", productId, kind: "purchase", quantity: 20, unitCost: "1,00" });
  expect(entry.status, JSON.stringify(entry.body)).toBe(200);
});

test.afterAll(async ({ request }) => {
  if (productId) await retireTempProduct(request, fam.admin.idToken, productId).catch(() => undefined);
  if (openedDay) await post(request, fam.admin, "/api/school/calendar", { action: "clear", date: TODAY }).catch(() => undefined);
});

test("autorização por papel: só cantina e administração operam o PDV; família, secretaria e anônimo negados", async ({ request }) => {
  const reads = ["/api/pos/students", `/api/pos/students?id=${fam.studentId}`, `/api/pos/catalog?shiftId=${morning}`];
  for (const url of reads) {
    expect((await get(request, null, url)).status, url).toBe(401);
    expect((await get(request, fam.guardian, url)).status, url).toBe(403);
    expect((await get(request, secretaria, url)).status, url).toBe(403);
    expect((await get(request, cantina, url)).status, url).toBe(200);
    expect((await get(request, fam.admin, url)).status, url).toBe(200);
  }
  const sale = { studentId: fam.studentId, expectedShiftId: morning, lines: [{ productId, quantity: 1, expectedPriceCents: 300 }] };
  const directSale = { shiftId: morning, lines: [{ productId, quantity: 1, expectedPriceCents: 300 }], paymentMethod: "cash", receivedConfirmed: true };
  for (const [user, status] of [[null, 401], [fam.guardian, 403], [secretaria, 403]] as const) {
    expect((await post(request, user, "/api/pos/sales", sale)).status).toBe(status);
    expect((await post(request, user, "/api/pos/direct-sales", directSale)).status).toBe(status);
  }
});

test("leituras reais: alunos ativos com turma/turno, aluno com saldo e restrições, cardápio do balcão com estoque e sem custo", async ({ request }) => {
  const roster = await get(request, cantina, "/api/pos/students");
  expect(roster.status).toBe(200);
  const rows = roster.body.students as { id: string; name: string; className: string | null; shiftName: string | null }[];
  expect(rows.find((r) => r.id === fam.studentId)).toMatchObject({ name: fam.studentName, shiftName: DEMO_SHIFTS[0].name });
  expect((rows.find((r) => r.id === fam.studentId)?.className ?? "").length).toBeGreaterThan(0);
  expect((roster.body.shifts as { id: string }[]).some((s) => s.id === morning)).toBe(true);
  expect(roster.body.today).toBe(TODAY);

  const detail = await get(request, cantina, `/api/pos/students?id=${fam.studentId}`);
  expect(detail.body).toMatchObject({ wallet: { balanceCents: 0, version: 0 }, counterAllowed: false, restrictions: { dailyLimitCents: null, dayCommittedCents: 0 }, exceptions: [], today: TODAY });
  expect(JSON.stringify(detail.body)).not.toMatch(/guardian|email|phone/i);
  expect((await get(request, cantina, `/api/pos/students?id=stu_inexistente_${tag}`)).status).toBe(404);

  const catalog = await get(request, cantina, `/api/pos/catalog?shiftId=${morning}`);
  expect(catalog.body).toMatchObject({ service: "open", today: TODAY, shiftId: morning });
  expect((catalog.body.products as { id: string }[]).find((p) => p.id === productId)).toMatchObject({ name: productName, priceCents: 300, availableUnits: 20, mode: "physical" });
  noCost(catalog.body);
  expect((await get(request, cantina, "/api/pos/catalog")).status).toBe(400);
});

test("venda com saldo: ordem das recusas e NADA gravado depois de cada uma (carteira R$ 0,00, sem pedido, estoque intacto)", async ({ request }) => {
  const line = (price = 300) => [{ productId, quantity: 2, expectedPriceCents: price }];
  const sale = (over: Record<string, unknown> = {}) => post(request, cantina, "/api/pos/sales", { studentId: fam.studentId, expectedShiftId: morning, lines: line(), ...over });
  expect((await sale({ totalCents: 1 })).status).toBe(400);
  expect((await sale({ lines: [] })).status).toBe(400);
  expect((await post(request, cantina, "/api/pos/sales", { studentId: `stu_inexistente_${tag}`, expectedShiftId: morning, lines: line() })).body.error).toBe("student_not_found");
  // Balcão não liberado pelo responsável (padrão): negado.
  expect((await sale()).status).toBe(403);
  // O responsável libera o balcão (fluxo real da política) e o resto da cadeia de recusas aparece.
  const policy = await post(request, fam.guardian, "/api/policies", { studentId: fam.studentId, allowCounterPurchase: true, reason: "Smoke do PDV (fictício)" });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  expect((await get(request, cantina, `/api/pos/students?id=${fam.studentId}`)).body).toMatchObject({ counterAllowed: true });
  expect((await sale({ expectedShiftId: "turno_errado" })).body.error).toBe("shift_changed");
  expect((await sale({ lines: [{ productId: `inexistente_${tag}`, quantity: 1, expectedPriceCents: 300 }] })).body).toMatchObject({ error: "item_unavailable", details: { reason: "product_not_found" } });
  const changed = await sale({ lines: line(250) });
  expect(changed.body).toMatchObject({ error: "price_changed", details: { changes: [{ productId, expectedPriceCents: 250, currentPriceCents: 300 }], cart: { totalCents: 600 } } });
  const broke = await sale();
  expect([broke.status, broke.body.error, broke.body.details]).toEqual([409, "insufficient_balance", { balanceCents: 0, requiredCents: 600 }]);

  expect(await stockOf(request, fam.admin)).toBe(20);
  expect((await get(request, cantina, `/api/pos/students?id=${fam.studentId}`)).body).toMatchObject({ wallet: { balanceCents: 0, version: 0 } });
  const orders = await get(request, fam.guardian, `/api/orders?studentId=${fam.studentId}`);
  expect([orders.status, orders.body.orders]).toEqual([200, []]);
});

test("venda direta: recebimento confirmado, replay idempotente, estoque baixa uma vez e nenhuma carteira é tocada", async ({ request }) => {
  const body = { shiftId: morning, lines: [{ productId, quantity: 2, expectedPriceCents: 300 }], paymentMethod: "pix", receivedConfirmed: true, feeCents: 10, buyerKind: "teacher", buyerNote: "Professor fictício" };
  // Entrada inválida/sem confirmação do recebimento: nada registrado.
  expect((await post(request, cantina, "/api/pos/direct-sales", { ...body, receivedConfirmed: false })).status).toBe(400);
  expect((await post(request, cantina, "/api/pos/direct-sales", { ...body, studentId: fam.studentId })).status).toBe(400);
  expect((await post(request, cantina, "/api/pos/direct-sales", { ...body, feeCents: 601 })).body.error).toBe("invalid_fee");
  expect((await post(request, cantina, "/api/pos/direct-sales", { ...body, lines: [{ productId, quantity: 1, expectedPriceCents: 1 }] })).body.error).toBe("price_changed");
  expect(await stockOf(request, fam.admin)).toBe(20);

  const key = randomUUID();
  const first = await post(request, cantina, "/api/pos/direct-sales", body, key);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body).toMatchObject({ replayed: false, totalCents: 600, itemCount: 2, paymentMethod: "pix", fee: { status: "informed", cents: 10 }, netCents: 590, consumptionDate: TODAY });
  noCost(first.body);
  const again = await post(request, cantina, "/api/pos/direct-sales", body, key);
  expect(again.body).toEqual({ ...first.body, replayed: true });
  expect((await post(request, cantina, "/api/pos/direct-sales", { ...body, lines: [{ productId, quantity: 3, expectedPriceCents: 300 }] }, key)).status).toBe(409); // chave com outro conteúdo
  expect(await stockOf(request, fam.admin)).toBe(18);
  // A cantina vê quantidades, nunca custo; a administração vê a saída com custo médio histórico no livro de estoque.
  const adminView = (await get(request, fam.admin, `/api/inventory/product?productId=${productId}`)).body as { movements: { type: string; quantity: number; totalCostMicros?: number }[] };
  expect(adminView.movements.find((m) => m.type === "sale_exit")).toMatchObject({ quantity: -2 });
  const cantinaView = (await get(request, cantina, `/api/inventory/product?productId=${productId}`)).body;
  expect(cantinaView.canSeeCosts).toBe(false);
  expect(JSON.stringify(cantinaView)).not.toMatch(/micros|unitCost/i);
  const reconcile = await get(request, fam.admin, `/api/inventory/reconcile?productId=${productId}`);
  expect(reconcile.body).toMatchObject({ ok: true, products: [{ problems: [], onHand: 18 }] });
  // A carteira do aluno e os pedidos da família seguem intocados.
  expect((await get(request, cantina, `/api/pos/students?id=${fam.studentId}`)).body).toMatchObject({ wallet: { balanceCents: 0, version: 0 } });
  expect((await get(request, fam.guardian, `/api/orders?studentId=${fam.studentId}`)).body.orders).toEqual([]);
});

test("Rules publicadas: vendas diretas e pedidos de balcão seguem fechados ao cliente (família, cantina, administração, anônimo)", async () => {
  for (const [label, token] of [["responsável", fam.guardian.idToken], ["cantina", cantina.idToken], ["administração", fam.admin.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", "directSales/dsl_inexistente")).status, `${label}: venda direta`).toBe(403);
    expect((await fsRequest(token, "PATCH", "directSales/dsl_inexistente", { totalCents: { integerValue: "1" } })).status, `${label}: escrita`).toBe(403);
    expect((await fsRequest(token, "GET", "orders/cnt_inexistente")).status, `${label}: pedido de balcão`).toBe(403);
    expect((await fsRequest(token, "GET", `wallets/${fam.studentId}`)).status === 200 && label === "cantina").toBe(false); // a cantina não lê saldo pelo cliente
  }
});

test("tela publicada: PDV para a cantina (busca em destaque, venda direta); família não alcança a operação", async ({ page }) => {
  await page.goto("/operacao/pdv");
  await page.getByLabel("Email").fill(cantina.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "PDV de balcão" })).toBeVisible({ timeout: 30000 });
  await page.getByTestId("pos-student-search").fill(fam.studentName.toLowerCase());
  await expect(page.getByTestId("pos-student-option")).toHaveCount(1, { timeout: 30000 });
  await page.getByTestId("pos-student-option").click();
  await expect(page.getByTestId("pos-student-name")).toHaveText(fam.studentName);
  await expect(page.getByTestId("pos-balance")).toHaveText(/0,00/);
  await page.getByTestId("pos-product-search").fill(productName);
  await expect(page.getByTestId("pos-product").filter({ hasText: productName })).toBeVisible({ timeout: 30000 });
  await page.getByTestId("pos-product").filter({ hasText: productName }).getByTestId("pos-add-1").click();
  await expect(page.getByTestId("pos-over-balance")).toContainText("faltam"); // saldo R$ 0,00: a tela não deixa revisar
  await expect(page.getByTestId("pos-review")).toBeDisabled();
  await page.getByTestId("pos-tab-direct").click();
  await expect(page.getByTestId("pos-method-cash")).toBeVisible();
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await page.getByLabel("Email").fill(fam.guardian.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Área indisponível para o seu perfil" })).toBeVisible({ timeout: 30000 });
});
