// Smoke DIRIGIDO de Pedidos do dia / O que preparar / entrega / não retirada (F13) na homologação (emulador ou aplicação
// publicada), SEM crédito artificial e SEM pedido gravado à mão: os alunos fictícios têm carteira R$ 0,00 e nenhum pedido, então
// NÃO existe pedido para entregar. Prova o que é possível sem compra: autorização por papel nas rotas novas, validação e recusas
// dos comandos (404 de pedido inexistente, resoluções indisponíveis), respostas vazias das consultas e, como a consulta ao
// Firestore real EXIGE índice composto mesmo sem documentos, que os índices novos (dia/turno, previsão, pendências vencidas,
// não retirados) estão publicados e prontos; Rules (entregas fechadas ao cliente) e as telas vazias.
// NÃO prova: entrega/estoque/custo, parcial, concorrência, replay, não retirada nem resolução com dados no Firestore real — isso
// só existe no emulador (tests/integration/fulfillment-api.test.ts, e2e/fulfillment.spec.ts). Corrida entrega × cancelamento: tests/integration/cancellation-api.test.ts (F14).
import { expect, test, type APIRequestContext } from "@playwright/test";
import { DEMO_SHIFTS } from "../../scripts/lib/demo-seed.ts";
import { localDateOf } from "../../src/lib/dates/school-time";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { fixtureIds } from "../helpers/catalog-fixtures.ts";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const TODAY = localDateOf(new Date());
let fam: Family;
let cantina: TestUser;
let secretaria: TestUser;
let morning = "";

type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: user ? bearer(user.idToken) : {}, data });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
const get = (request: APIRequestContext, user: TestUser | null, url: string) => call(request, user, "GET", url);

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-fu-${tag}`);
  cantina = await createTestUser(`hml-fu-cant-${tag}`, "cantina");
  secretaria = await createTestUser(`hml-fu-sec-${tag}`, "secretaria");
  morning = (await fixtureIds()).shift(DEMO_SHIFTS[0].name);
});

test("autorização por papel: só cantina e administração operam; família, secretaria e anônimo negados", async ({ request }) => {
  const reads = ["/api/operations/orders", "/api/operations/preparation"];
  for (const url of reads) {
    expect((await get(request, null, url)).status, url).toBe(401);
    expect((await get(request, fam.guardian, url)).status, url).toBe(403);
    expect((await get(request, secretaria, url)).status, url).toBe(403);
    expect((await get(request, cantina, url)).status, url).toBe(200);
    expect((await get(request, fam.admin, url)).status, url).toBe(200);
  }
  const body = { key: newKey("hml-fu"), studentId: fam.studentId, lines: [{ lineNo: 1, quantity: 1 }] };
  for (const [user, status] of [[null, 401], [fam.guardian, 403], [secretaria, 403]] as const) {
    expect((await call(request, user, "POST", "/api/operations/orders/ord_x/deliver", body)).status).toBe(status);
    expect((await call(request, user, "POST", "/api/operations/orders/ord_x/prepare", { key: newKey("hml-fu"), to: "ready" })).status).toBe(status);
    expect((await call(request, user, "POST", "/api/operations/orders/ord_x/not-picked-up", { key: newKey("hml-fu"), reason: "motivo válido" })).status).toBe(status);
  }
  // resolução é só da administração: a cantina é negada antes de qualquer leitura
  const resolve = { key: newKey("hml-fu"), resolution: "close_charged", reason: "Política da escola: cobrança mantida" };
  expect((await call(request, cantina, "POST", "/api/operations/orders/ord_x/resolve", resolve)).status).toBe(403);
});

test("consultas vazias e índices publicados: dia/turno, filtros, previsão e pendências respondem 200 sem FAILED_PRECONDITION", async ({ request }) => {
  const combos = [`date=${TODAY}`, `date=${TODAY}&shiftId=${morning}`, `date=${TODAY}&status=open`, `date=${TODAY}&status=not_picked_up&q=ana`, `date=${TODAY}&classId=cls_x&shiftId=${morning}`];
  for (const q of combos) {
    const page = await get(request, cantina, `/api/operations/orders?${q}`);
    expect([page.status, page.body.orders, page.body.truncated], q).toEqual([200, [], false]);
    expect(page.body.canDeliver).toBe(true);
  }
  for (const q of ["", `date=${TODAY}`, `date=${TODAY}&shiftId=${morning}`]) {
    const panel = await get(request, cantina, `/api/operations/preparation?${q}`);
    expect([panel.status, panel.body.rows, panel.body.forecast, panel.body.attention], q).toEqual([200, [], [], []]);
    expect(panel.body.forecastFrom).toBe(TODAY);
  }
  const attention = await get(request, cantina, "/api/operations/preparation?scope=attention");
  expect([attention.status, attention.body.rows, attention.body.forecast, attention.body.attention]).toEqual([200, [], [], []]);
  expect((await get(request, cantina, "/api/operations/preparation?scope=tudo")).status).toBe(400);
});

test("validação e recusas dos comandos: entrada inválida 400; pedido inexistente 404; reagendamento indisponível (F16)", async ({ request }) => {
  expect((await get(request, cantina, "/api/operations/orders?date=2026-02-30")).status).toBe(400);
  expect((await get(request, cantina, "/api/operations/orders?outro=1")).status).toBe(400);
  const key = () => newKey("hml-fu");
  expect((await call(request, cantina, "POST", "/api/operations/orders/ord_x/deliver", { key: key(), studentId: fam.studentId, lines: [] })).status).toBe(400);
  expect((await call(request, cantina, "POST", "/api/operations/orders/ord_x/deliver", { key: key(), studentId: fam.studentId, lines: [{ lineNo: 1, quantity: 21 }] })).status).toBe(400);
  expect((await call(request, cantina, "POST", "/api/operations/orders/ord_x/not-picked-up", { key: key(), reason: "ok" })).status).toBe(400); // motivo obrigatório
  expect((await call(request, cantina, "POST", "/api/operations/orders/ord_x/prepare", { key: key(), to: "delivered" })).status).toBe(400);
  for (const [user, route, body] of [
    [cantina, "deliver", { key: key(), studentId: fam.studentId, lines: [{ lineNo: 1, quantity: 1 }] }],
    [cantina, "prepare", { key: key(), to: "ready" }],
    [cantina, "not-picked-up", { key: key(), reason: "Família avisou que não virá" }],
    [fam.admin, "resolve", { key: key(), resolution: "close_charged", reason: "Política da escola: cobrança mantida" }],
  ] as const) {
    const r = await call(request, user, "POST", `/api/operations/orders/ord_inexistente/${route}`, body);
    expect([r.status, r.body.error], route).toEqual([404, "order_not_found"]);
  }
  // cancel_refund passou a existir na F14 (pedido inexistente → 404); só o reagendamento segue indisponível (F16).
  const refund = await call(request, fam.admin, "POST", "/api/operations/orders/ord_inexistente/resolve", { key: key(), resolution: "cancel_refund", reason: "Decisão da direção" });
  expect([refund.status, refund.body.error]).toEqual([404, "order_not_found"]);
  const reschedule = await call(request, fam.admin, "POST", "/api/operations/orders/ord_inexistente/resolve", { key: key(), resolution: "reschedule", reason: "Decisão da direção" });
  expect([reschedule.status, reschedule.body.error, reschedule.body.details?.availableIn]).toEqual([409, "resolution_unavailable", "F16"]);
});

test("Rules publicadas: pedidos e entregas seguem fechados ao cliente (família, cantina, administração, anônimo)", async () => {
  for (const [label, token] of [["responsável", fam.guardian.idToken], ["cantina", cantina.idToken], ["administração", fam.admin.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", "orders/ord_inexistente")).status, `${label}: pedido`).toBe(403);
    expect((await fsRequest(token, "GET", "orders/ord_inexistente/deliveries/dlv_x")).status, `${label}: entrega`).toBe(403);
    expect((await fsRequest(token, "PATCH", "orders/ord_inexistente", { status: { stringValue: "delivered" } })).status, `${label}: escrita`).toBe(403);
  }
});

test("telas publicadas: Pedidos do dia e O que preparar vazios (sem parecer erro) para a cantina; família não alcança a operação", async ({ page }) => {
  await page.goto("/operacao/pedidos");
  await page.getByLabel("Email").fill(cantina.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("day-orders")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Nenhum pedido para estes filtros.")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("day-error")).toHaveCount(0);
  await expect(page.getByTestId("attention")).toHaveCount(0);
  await page.goto("/operacao/preparacao");
  await expect(page.getByTestId("attention-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Nenhum pedido para esta data e turno.")).toBeVisible();
  await expect(page.getByTestId("prep-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await page.getByLabel("Email").fill(fam.guardian.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Área indisponível para o seu perfil" })).toBeVisible({ timeout: 30000 });
});
