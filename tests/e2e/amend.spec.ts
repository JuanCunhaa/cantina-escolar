import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addDays, localDateOf } from "../../src/lib/dates/school-time";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

// Reagendamento e troca de produtos (F16) pela interface da equipe, no emulador: a cantina reagenda pela lista do dia (data nova,
// nenhuma cobrança, confirmação só pela resposta do servidor, clique duplo) e troca produto com PRÉVIA do servidor (diferença
// calculada lá, prévia obsoleta descartada ao mudar a escolha, resposta perdida repetida com a MESMA chave sem cobrar de novo).
// A família vê o reagendamento, a troca e o lançamento da diferença. Pedidos nascem do CHECKOUT REAL (F11) para amanhã; o saldo
// vem de fixture (não comprova nada no Firestore real). O destino é hoje+2 (horário de compra aberto em qualquer hora do dia:
// a exceção operacional de horário depende do relógio e é provada na integração com relógio injetado).

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_am_${tag}`;
const CAT = `cat_am_${tag}`;
const CLS = `cls_am_${tag}`;
const TODAY = localDateOf(new Date());
const TOMORROW = addDays(TODAY, 1);
const LATER = addDays(TODAY, 2);
let admin: TestUser;
let cantina: TestUser;
let counter = 0;
const created: string[] = [];
type Product = { id: string; name: string; priceCents: number };

async function track(path: string, data: Record<string, string | number | boolean | null | string[]>) {
  created.push(path);
  await writeDemoDoc(targetFromEnv(), path, data);
}
async function removeCreated() {
  const target = targetFromEnv();
  for (const path of created.splice(0)) {
    await fetch(`http://${target.firestoreHost}/v1/projects/${target.project}/databases/(default)/documents/${path}`, { method: "DELETE", headers: { authorization: "Bearer owner" } });
  }
}
async function login(page: Page, email: string, path: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}
async function switchTo(page: Page, email: string, path: string) {
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible({ timeout: 20000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("button", { name: "Sair", exact: true })).toBeVisible({ timeout: 30000 });
  await page.goto(path);
}
async function product(request: APIRequestContext, name: string, priceCents: number): Promise<Product> {
  const id = `prd_am_${tag}_${++counter}`;
  const data = { name: `${name} ${tag}`, nameSlug: `${name.toLowerCase()}-${tag}-${counter}`, description: "Produto de teste (fictício).", categoryId: CAT, priceCents, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [SHIFT], availabilityMode: "physical", status: "active", version: 1 };
  await track(`products/${id}`, data);
  await track(`defaultMenuRules/${id}`, { productId: id, shiftIds: [SHIFT], version: 1 });
  const response = await request.post("/api/inventory/receipts", { headers: { authorization: `Bearer ${admin.idToken}` }, data: { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: 100, unitCost: "1,00" } });
  expect(response.status(), await response.text()).toBe(200);
  return { id, name: data.name, priceCents };
}
async function family(label: string) {
  const guardian = await createTestUser(`e2e-am-g-${label}-${tag}`, "guardian");
  const id = `stu_am_${tag}_${++counter}`;
  const name = `${label} ${tag}${counter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowSitePurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, status: "active", userUid: null, shiftId: SHIFT, classId: CLS, version: 1 });
  await fundDemoWallet(targetFromEnv(), id, 20000);
  return { guardian, id, name };
}
async function order(request: APIRequestContext, fam: { guardian: TestUser; id: string }, item: Product, quantity: number): Promise<string> {
  const response = await request.post("/api/orders/checkout", {
    headers: { authorization: `Bearer ${fam.guardian.idToken}` },
    data: { key: randomUUID(), studentId: fam.id, expectedShiftId: SHIFT, days: [{ date: TOMORROW, lines: [{ productId: item.id, quantity, expectedPriceCents: item.priceCents }] }] },
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { orders: { orderId: string }[] }).orders[0]!.orderId;
}
const entriesOf = async (request: APIRequestContext, fam: { guardian: TestUser; id: string }, type: string) => {
  const r = await request.get(`/api/wallets/entries?studentId=${fam.id}&type=${type}`, { headers: { authorization: `Bearer ${fam.guardian.idToken}` } });
  return ((await r.json()) as { entries: { amountCents: number }[] }).entries.map((e) => e.amountCents);
};
const balanceOf = async (request: APIRequestContext, fam: { guardian: TestUser; id: string }) => {
  const r = await request.get(`/api/wallets?studentId=${fam.id}`, { headers: { authorization: `Bearer ${fam.guardian.idToken}` } });
  const body = (await r.json()) as { wallets?: { balanceCents: number }[]; balanceCents?: number };
  return body.wallets?.[0]?.balanceCents ?? body.balanceCents ?? NaN;
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rowOf = (page: Page, name: string) => page.getByTestId("day-order").filter({ hasText: name });

test.beforeAll(async ({ request }) => {
  [admin, cantina] = await Promise.all([createTestUser(`e2e-am-adm-${tag}`, "admin"), createTestUser(`e2e-am-cant-${tag}`, "cantina")]);
  await track(`shifts/${SHIFT}`, { name: `Manhã Troca ${tag}`, nameSlug: "manha", status: "active" });
  await track(`classes/${CLS}`, { name: `Turma Troca ${tag}`, nameSlug: "turma-am", status: "active" });
  await track(`categories/${CAT}`, { name: `Categoria Troca ${tag}`, status: "active" });
  for (let i = 0; i <= 8; i++) await track(`calendarDays/${addDays(TODAY, i)}`, { kind: "extra" });
  await warmRoutes(request, {
    post: ["/api/orders/checkout", "/api/inventory/receipts", "/api/operations/orders/aquecer/reschedule", "/api/operations/orders/aquecer/exchange", "/api/operations/orders/aquecer/exchange/quote"],
    get: ["/operacao/pedidos", "/portal/pedidos/aquecer", "/portal/carteira/extrato", "/api/orders/aquecer", "/api/operations/orders", "/api/operations/preparation", "/api/operations/orders/aquecer/amend-options", "/api/wallets", "/api/wallets/entries"],
  });
});
test.afterAll(removeCreated);

test.describe("Reagendar e trocar pela operação (A24/A35)", () => {
  test("cantina reagenda pela lista: nova data confirmada pelo servidor, clique duplo move uma vez, sem cobrança; a família vê", async ({ page, request }) => {
    const lanche = await product(request, "Lanche", 650);
    const fam = await family("Rui");
    const orderId = await order(request, fam, lanche, 2);
    const before = await balanceOf(request, fam);

    await login(page, cantina.email, `/operacao/pedidos?date=${TOMORROW}`);
    await expect(rowOf(page, fam.name)).toBeVisible({ timeout: 30000 });
    await rowOf(page, fam.name).getByTestId("reschedule-toggle").click();
    const form = rowOf(page, fam.name).getByTestId("reschedule-form");
    await expect(form.getByTestId("reschedule-date")).toBeVisible({ timeout: 20000 });
    await form.getByTestId("reschedule-date").selectOption(LATER);
    await expect(form.getByTestId("reschedule-submit")).toBeDisabled(); // motivo obrigatório
    await form.getByTestId("reschedule-reason").fill("Aluno comprou para a data errada");
    await form.getByTestId("reschedule-submit").dblclick();
    // O pedido sai da lista de amanhã; o aviso fica no topo, vindo da resposta do servidor.
    await expect(page.getByTestId("board-message")).toContainText("pedido reagendado", { timeout: 20000 });
    await expect(page.getByTestId("board-message")).toContainText("nada foi cobrado de novo");
    await expect(rowOf(page, fam.name)).toHaveCount(0, { timeout: 20000 });

    await page.getByLabel("Data").fill(LATER);
    await expect(rowOf(page, fam.name)).toBeVisible({ timeout: 20000 });
    expect(await balanceOf(request, fam)).toBe(before);
    const detail = await request.get(`/api/orders/${orderId}`, { headers: { authorization: `Bearer ${fam.guardian.idToken}` } });
    const body = (await detail.json()) as { consumptionDate: string; reschedules: unknown[] };
    expect([body.consumptionDate, body.reschedules.length]).toEqual([LATER, 1]); // clique duplo: um só reagendamento

    await page.setViewportSize({ width: 375, height: 800 });
    await rowOf(page, fam.name).getByTestId("reschedule-toggle").click();
    await expect(rowOf(page, fam.name).getByTestId("reschedule-form")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    await rowOf(page, fam.name).screenshot({ path: "test-results/f16-reagendar-375.png" });
    await page.setViewportSize({ width: 1280, height: 900 });

    await switchTo(page, fam.guardian.email, `/portal/pedidos/${orderId}`);
    await expect(page.getByTestId("order-reschedules")).toContainText("Pagamento e preços mantidos", { timeout: 30000 });
    await expect(page.getByTestId("order-timeline")).toContainText("Reagendado pela escola");
    await expect(page.getByTestId("order-detail")).not.toContainText("Aluno comprou para a data errada"); // motivo é interno
  });

  test("troca com prévia do servidor: escolha nova descarta a prévia antiga; resposta perdida repete a MESMA troca sem cobrar duas vezes", async ({ page, request }) => {
    const pao = await product(request, "Pão", 500);
    const suco = await product(request, "Suco", 700);
    const fam = await family("Lia");
    const orderId = await order(request, fam, pao, 2);
    const before = await balanceOf(request, fam);

    let lost = false;
    await page.route("**/api/operations/orders/*/exchange", async (route) => {
      if (!lost) {
        lost = true;
        await route.fetch(); // o servidor aplica a troca…
        await route.abort("failed"); // …e a resposta se perde na volta
      } else await route.continue();
    });
    await login(page, cantina.email, `/operacao/pedidos?date=${TOMORROW}`);
    await expect(rowOf(page, fam.name)).toBeVisible({ timeout: 30000 });
    await rowOf(page, fam.name).getByTestId("exchange-toggle").click();
    const form = rowOf(page, fam.name).getByTestId("exchange-form");
    await expect(form.getByRole("radio", { name: new RegExp(suco.name) })).toBeVisible({ timeout: 20000 });
    await form.getByRole("radio", { name: new RegExp(suco.name) }).check();
    await form.getByTestId("exchange-quote").click();
    await expect(form.getByTestId("exchange-difference")).toContainText(/cobrar R\$\s?2,00/, { timeout: 15000 });

    // Mudar a escolha invalida a prévia: confirmar fica bloqueado até uma nova prévia.
    await form.getByTestId("exchange-in-qty").fill("2");
    await expect(form.getByTestId("exchange-quote-result")).toHaveCount(0);
    await expect(form.getByTestId("exchange-submit")).toBeDisabled();
    await form.getByTestId("exchange-quote").click();
    await expect(form.getByTestId("exchange-difference")).toContainText(/cobrar R\$\s?9,00/, { timeout: 15000 }); // 2×7 − 5 pagos
    await form.getByTestId("exchange-reason").fill("Aluno pediu suco no lugar do pão");
    await rowOf(page, fam.name).screenshot({ path: "test-results/f16-troca-1280.png" });

    await form.getByTestId("exchange-reason").fill("Aluno pediu suco no lugar do pão");
    await form.getByTestId("exchange-submit").click();
    await expect(rowOf(page, fam.name).getByTestId("order-command-message")).toBeVisible({ timeout: 20000 }); // incerto (conexão)
    expect(lost).toBe(true);
    await rowOf(page, fam.name).getByTestId("exchange-submit").click(); // repetir: mesma chave → resposta original
    await expect(rowOf(page, fam.name).getByTestId("order-command-message")).toContainText(/Troca registrada .*R\$\s?9,00 cobrado/, { timeout: 20000 });
    await expect(rowOf(page, fam.name)).toContainText("trocadas 1");

    expect(await entriesOf(request, fam, "order_exchange")).toEqual([-900]);
    expect(await balanceOf(request, fam)).toBe(before - 900);

    await switchTo(page, fam.guardian.email, `/portal/pedidos/${orderId}`);
    await expect(page.getByTestId("order-exchanges")).toContainText(/Diferença cobrada: R\$\s?9,00/, { timeout: 30000 });
    await expect(page.getByTestId("order-total")).toContainText("19,00"); // pago 10 + diferença 9 = 1×5 restante + 2×7 (líquido)
    await page.goto("/portal/carteira/extrato");
    await expect(page.getByTestId("statement-row").filter({ hasText: "Troca de produto (diferença)" }).first()).toBeVisible({ timeout: 30000 });
  });

  test("família não alcança os comandos da equipe: sem ações na tela e 403 na API", async ({ page, request }) => {
    const item = await product(request, "Bolo", 400);
    const fam = await family("Teo");
    const orderId = await order(request, fam, item, 1);
    const headers = { authorization: `Bearer ${fam.guardian.idToken}` };
    expect((await request.post(`/api/operations/orders/${orderId}/reschedule`, { headers, data: { key: randomUUID(), reason: "Quero mudar a data", toDate: LATER, toShiftId: SHIFT, overrideCutoff: true } })).status()).toBe(403);
    expect((await request.get(`/api/operations/orders/${orderId}/amend-options`, { headers })).status()).toBe(403);
    await login(page, fam.guardian.email, `/portal/pedidos/${orderId}`);
    await expect(page.getByTestId("order-detail")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("reschedule-toggle")).toHaveCount(0);
    await expect(page.getByTestId("exchange-toggle")).toHaveCount(0);
  });
});
