import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addDays, localDateOf, weekStartOf } from "../../src/lib/dates/school-time";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

// Cancelamento e reembolso (F14) pela interface, no emulador: o responsável cancela parte e depois o resto pelo detalhe do
// pedido (confirmação SÓ pela resposta do servidor, resposta perdida, clique duplo, prazo encerrado), a cantina/administração
// cancela pela lista do dia (parcial, descarte explícito) e a administração resolve "não retirado" com reembolso. Os pedidos
// nascem do CHECKOUT REAL (F11, pela API) para amanhã; só o caso "não retirado" move a data do pedido para HOJE por FIXTURE do
// emulador. O saldo vem de fixture (não comprova nada no Firestore real).

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_cn_${tag}`;
const CAT = `cat_cn_${tag}`;
const CLS = `cls_cn_${tag}`;
const TODAY = localDateOf(new Date());
const TOMORROW = addDays(TODAY, 1);
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
  const id = `prd_cn_${tag}_${++counter}`;
  const data = { name: `${name} ${tag}`, nameSlug: `${name.toLowerCase()}-${tag}-${counter}`, description: "Produto de teste (fictício).", categoryId: CAT, priceCents, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [SHIFT], availabilityMode: "physical", status: "active", version: 1 };
  await track(`products/${id}`, data);
  await track(`defaultMenuRules/${id}`, { productId: id, shiftIds: [SHIFT], version: 1 });
  const response = await request.post("/api/inventory/receipts", { headers: { authorization: `Bearer ${admin.idToken}` }, data: { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: 100, unitCost: "1,00" } });
  expect(response.status(), await response.text()).toBe(200);
  return { id, name: data.name, priceCents };
}
/** Família nova (responsável + aluno com saldo de fixture): cada teste isola o próprio extrato. */
async function family(label: string) {
  const guardian = await createTestUser(`e2e-cn-g-${label}-${tag}`, "guardian");
  const id = `stu_cn_${tag}_${++counter}`;
  const name = `${label} ${tag}${counter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowSitePurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, status: "active", userUid: null, shiftId: SHIFT, classId: CLS, version: 1 });
  await fundDemoWallet(targetFromEnv(), id, 20000);
  return { guardian, id, name };
}
async function order(request: APIRequestContext, fam: { guardian: TestUser; id: string }, item: Product, quantity: number, today = false): Promise<string> {
  const response = await request.post("/api/orders/checkout", {
    headers: { authorization: `Bearer ${fam.guardian.idToken}` },
    data: { key: randomUUID(), studentId: fam.id, expectedShiftId: SHIFT, days: [{ date: TOMORROW, lines: [{ productId: item.id, quantity, expectedPriceCents: item.priceCents }] }] },
  });
  expect(response.status(), await response.text()).toBe(200);
  const orderId = ((await response.json()) as { orders: { orderId: string }[] }).orders[0]!.orderId;
  if (today) {
    // Fixture do EMULADOR: move o pedido para HOJE e o consumo comprometido (F09) junto, como se a compra tivesse sido feita para hoje.
    await writeDemoDoc(targetFromEnv(), `orders/${orderId}`, { consumptionDate: TODAY }, ["consumptionDate"]);
    const committed = quantity * item.priceCents;
    await writeDemoDoc(targetFromEnv(), `studentUsage/${fam.id}/days/${TODAY}`, { studentId: fam.id, date: TODAY, committedCents: committed, version: 1 });
    await writeDemoDoc(targetFromEnv(), `studentUsage/${fam.id}/weeks/${weekStartOf(TODAY)}`, { studentId: fam.id, weekStart: weekStartOf(TODAY), committedCents: committed, version: 1 });
  }
  return orderId;
}
const refundsOf = async (request: APIRequestContext, fam: { guardian: TestUser; id: string }) => {
  const r = await request.get(`/api/wallets/entries?studentId=${fam.id}&type=order_refund`, { headers: { authorization: `Bearer ${fam.guardian.idToken}` } });
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
  [admin, cantina] = await Promise.all([createTestUser(`e2e-cn-adm-${tag}`, "admin"), createTestUser(`e2e-cn-cant-${tag}`, "cantina")]);
  await track(`shifts/${SHIFT}`, { name: `Manhã Cancelamento ${tag}`, nameSlug: "manha", status: "active" });
  await track(`classes/${CLS}`, { name: `Turma Cancelamento ${tag}`, nameSlug: "turma-cn", status: "active" });
  await track(`categories/${CAT}`, { name: `Categoria Cancelamento ${tag}`, status: "active" });
  for (let i = 0; i <= 8; i++) await track(`calendarDays/${addDays(TODAY, i)}`, { kind: "extra" });
  await warmRoutes(request, {
    post: ["/api/orders/checkout", "/api/inventory/receipts", "/api/orders/aquecer/cancel", "/api/operations/orders/aquecer/not-picked-up", "/api/operations/orders/aquecer/resolve"],
    get: ["/operacao/pedidos", "/portal/pedidos", "/portal/pedidos/aquecer", "/portal/carteira/extrato", "/api/orders", "/api/orders/aquecer", "/api/operations/orders", "/api/operations/preparation", "/api/wallets", "/api/wallets/entries"],
  });
});
test.afterAll(removeCreated);

test.describe("Cancelamento pelo responsável (A13/A16/A22)", () => {
  test("parcial e depois o resto: valor estimado, confirmação pela resposta do servidor, quantidades, extrato e aba Cancelados", async ({ page, request }) => {
    const suco = await product(request, "Suco", 500);
    const fam = await family("Ana");
    const orderId = await order(request, fam, suco, 3);
    const before = await balanceOf(request, fam);

    await login(page, fam.guardian.email, `/portal/pedidos/${orderId}`);
    await expect(page.getByTestId("order-items")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("order-detail")).toContainText("Prazo de cancelamento até");
    await page.getByTestId("cancel-open").click();
    await expect(page.getByTestId("cancel-confirm")).toBeEnabled();
    await expect(page.getByTestId("cancel-estimate")).toContainText(/Cancelamento total do que resta.*15,00/);

    await page.getByTestId("cancel-qty").fill("1");
    await expect(page.getByTestId("cancel-estimate")).toContainText(/Cancelamento parcial.*5,00/);
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("cancel-message")).toContainText(/Cancelamento confirmado: R\$\s?5,00/, { timeout: 20000 });
    await expect(page.getByTestId("item-canceled").first()).toHaveText("1");
    await expect(page.getByTestId("item-remaining").first()).toHaveText("2");
    await expect(page.getByTestId("order-refunded")).toContainText("5,00");
    await expect(page.getByTestId("order-cancellations")).toContainText("cancelado pelo responsável");
    expect(await balanceOf(request, fam)).toBe(before + 500);

    // o resto: padrão = total; o painel some e a confirmação fica
    await page.getByTestId("cancel-open").click();
    await expect(page.getByTestId("cancel-estimate")).toContainText(/total do que resta.*10,00/);
    await page.getByTestId("cancel-confirm").click();
    await expect(page.getByTestId("cancel-message")).toContainText(/R\$\s?10,00/, { timeout: 20000 });
    await expect(page.getByTestId("order-status")).toContainText("Cancelado");
    await expect(page.getByTestId("cancel-open")).toHaveCount(0);
    await expect(page.getByTestId("order-refunded")).toContainText("15,00");
    expect(await balanceOf(request, fam)).toBe(before + 1500);
    expect(await refundsOf(request, fam)).toEqual(expect.arrayContaining([500, 1000]));

    // aba Cancelados e extrato
    await page.goto("/portal/pedidos");
    await page.getByTestId("orders-tab-cancelled").click();
    await expect(page.getByTestId("order-row").filter({ hasText: fam.name })).toContainText("devolvido à carteira", { timeout: 30000 });
    await page.goto("/portal/carteira/extrato");
    await expect(page.getByTestId("statement-row").filter({ hasText: "Reembolso de pedido" }).first()).toBeVisible({ timeout: 30000 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("clique duplo em confirmar e resposta perdida: um único reembolso, tela reconciliada pelo servidor", async ({ page, request }) => {
    const suco = await product(request, "Pão", 400);
    const fam = await family("Bia");
    const orderId = await order(request, fam, suco, 2);
    const before = await balanceOf(request, fam);

    // 1ª resposta é descartada depois de o servidor aplicar o comando (rede caiu na volta)
    let lost = false;
    await page.route("**/api/orders/*/cancel", async (route) => {
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await login(page, fam.guardian.email, `/portal/pedidos/${orderId}`);
    await expect(page.getByTestId("order-items")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("cancel-open").click();
    await page.getByTestId("cancel-confirm").dblclick();
    // a tela relê o pedido e mostra o que o servidor gravou (cancelado, devolvido uma vez)
    await expect(page.getByTestId("order-status")).toContainText("Cancelado", { timeout: 30000 });
    await expect(page.getByTestId("order-refunded")).toContainText("8,00");
    expect(lost).toBe(true);
    expect(await refundsOf(request, fam)).toEqual([800]);
    expect(await balanceOf(request, fam)).toBe(before + 800);
  });

  test("prazo encerrado: o detalhe explica e não oferece cancelar; o servidor recusa a família e a equipe ainda cancela", async ({ page, request }) => {
    const suco = await product(request, "Bolo", 700);
    const fam = await family("Caio");
    const orderId = await order(request, fam, suco, 1);
    // Fixture do EMULADOR: prazo salvo no pedido já vencido (o comando só lê o snapshot do pedido, não o calendário atual).
    await writeDemoDoc(targetFromEnv(), `orders/${orderId}`, { policy: { cancelCutoffAt: new Date(Date.now() - 60_000) } }, ["policy"]);
    const attempt = await request.post(`/api/orders/${orderId}/cancel`, { headers: { authorization: `Bearer ${fam.guardian.idToken}` }, data: { key: randomUUID(), reason: "Mudança de planos da família" } });
    expect([attempt.status(), ((await attempt.json()) as { error: string }).error]).toEqual([409, "cancel_deadline_passed"]);
    await login(page, fam.guardian.email, `/portal/pedidos/${orderId}`);
    await expect(page.getByTestId("order-items")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("cancel-open")).toHaveCount(0);
    await expect(page.getByTestId("cancel-unavailable")).toContainText("O prazo para cancelar este pedido terminou");
    expect(await refundsOf(request, fam)).toEqual([]);

    // depois do prazo a equipe cancela (excepcional, com motivo); a família vê o resultado no detalhe
    const staff = await request.post(`/api/orders/${orderId}/cancel`, { headers: { authorization: `Bearer ${cantina.idToken}` }, data: { key: randomUUID(), reason: "Produto indisponível" } });
    expect(staff.status(), await staff.text()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("order-status")).toContainText("Cancelado", { timeout: 30000 });
    await expect(page.getByTestId("order-cancellations")).toContainText("cancelado pela escola");
    await expect(page.getByTestId("order-detail")).not.toContainText("Produto indisponível"); // motivo da equipe é interno
    expect(await refundsOf(request, fam)).toEqual([700]);
  });
});

test.describe("Cancelamento operacional (cantina e administração)", () => {
  test("cantina cancela parte com motivo; administração cancela o resto descartando 1 unidade (perda explícita)", async ({ page, request }) => {
    const torta = await product(request, "Torta", 600);
    const fam = await family("Davi");
    await order(request, fam, torta, 3);
    const before = await balanceOf(request, fam);

    await login(page, cantina.email, `/operacao/pedidos?date=${TOMORROW}`);
    await expect(rowOf(page, fam.name)).toBeVisible({ timeout: 30000 });
    await rowOf(page, fam.name).getByTestId("cancel-toggle").click();
    const form = rowOf(page, fam.name).getByTestId("cancel-form");
    await expect(form.getByTestId("cancel-submit")).toBeDisabled(); // motivo obrigatório
    await form.getByLabel(new RegExp(`${torta.name} — cancelar`)).fill("1");
    await form.getByTestId("cancel-reason-input").fill("Produto indisponível hoje");
    await form.getByTestId("cancel-submit").click();
    await expect(rowOf(page, fam.name).getByTestId("order-command-message")).toContainText(/devolvido\(s\) à carteira/, { timeout: 20000 });
    await expect(rowOf(page, fam.name).getByTestId("day-canceled")).toContainText("canceladas 1");
    await expect(rowOf(page, fam.name)).toContainText("faltam 2");
    expect(await balanceOf(request, fam)).toBe(before + 600);

    await switchTo(page, admin.email, `/operacao/pedidos?date=${TOMORROW}`);
    await expect(rowOf(page, fam.name)).toBeVisible({ timeout: 30000 });
    await rowOf(page, fam.name).getByTestId("cancel-toggle").click();
    const adminForm = rowOf(page, fam.name).getByTestId("cancel-form");
    await adminForm.getByLabel(/Descartar como perda/).fill("1");
    await adminForm.getByTestId("cancel-reason-input").fill("Preparado e não aproveitável");
    await adminForm.getByTestId("cancel-submit").click();
    await expect(rowOf(page, fam.name).getByTestId("order-command-message")).toContainText("1 unidade(s) descartada(s) como perda", { timeout: 20000 });
    await expect(rowOf(page, fam.name).getByTestId("day-status")).toHaveText(/Cancelado/);
    expect(await balanceOf(request, fam)).toBe(before + 1800);
    expect(await refundsOf(request, fam)).toEqual(expect.arrayContaining([600, 1200]));
    // física: 100 − 1 descartada; as 2 outras unidades apenas voltaram à disponibilidade
    const stock = await request.get("/api/inventory", { headers: { authorization: `Bearer ${admin.idToken}` } });
    const items = ((await stock.json()) as { items: { productId: string; onHand: number; reservedUnits: number }[] }).items;
    expect(items.find((i) => i.productId === torta.id)).toMatchObject({ onHand: 99, reservedUnits: 0 });
    // celular: sem rolagem lateral
    await page.setViewportSize({ width: 375, height: 720 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("não retirado: a administração escolhe 'Cancelar e reembolsar a carteira' e o valor volta ao aluno", async ({ page, request }) => {
    const item = await product(request, "Quiche", 450);
    const fam = await family("Eva");
    await order(request, fam, item, 2, true);
    const before = await balanceOf(request, fam);

    await login(page, cantina.email, "/operacao/pedidos");
    await expect(rowOf(page, fam.name)).toBeVisible({ timeout: 30000 });
    await rowOf(page, fam.name).getByTestId("notpicked-toggle").click();
    await rowOf(page, fam.name).getByLabel("Motivo (obrigatório)").fill("Família avisou que não virá");
    await rowOf(page, fam.name).getByRole("button", { name: "Confirmar não retirado" }).click();
    await expect(rowOf(page, fam.name).getByTestId("day-status")).toHaveText(/Não retirado · aguardando resolução/);

    await switchTo(page, admin.email, "/operacao/pedidos");
    await expect(rowOf(page, fam.name)).toBeVisible({ timeout: 30000 });
    await rowOf(page, fam.name).getByTestId("resolve-toggle").click();
    const form = rowOf(page, fam.name).getByTestId("resolve-panel");
    await form.getByTestId("resolution-refund").check();
    await expect(form.getByTestId("resolve-submit")).toHaveText("Cancelar e reembolsar");
    await form.getByLabel(/Motivo \/ política aplicada/).fill("Política da escola: reembolso à carteira");
    await form.getByTestId("resolve-submit").click();
    await expect(rowOf(page, fam.name).getByTestId("order-command-message")).toContainText(/Cancelado e reembolsado: R\$\s?9,00/, { timeout: 20000 });
    await expect(rowOf(page, fam.name).getByTestId("day-status")).toHaveText(/Cancelado/);
    expect(await balanceOf(request, fam)).toBe(before + 900);

    // a família vê o resultado em linguagem simples, sem motivo interno
    await switchTo(page, fam.guardian.email, `/portal/pedidos`);
    await expect(async () => {
      await page.goto("/portal/pedidos");
      await page.getByTestId("orders-tab-cancelled").click();
      await expect(page.getByTestId("order-row").filter({ hasText: fam.name })).toBeVisible({ timeout: 8000 });
    }).toPass({ timeout: 45000 });
    await page.getByTestId("order-row").filter({ hasText: fam.name }).getByRole("link", { name: "Detalhes e recibo" }).click();
    await expect(page.getByTestId("order-non-pickup")).toContainText("cancelando e devolvendo", { timeout: 30000 });
    await expect(page.getByTestId("order-detail")).not.toContainText("Política da escola");
    await expect(page.getByTestId("order-detail")).not.toContainText(cantina.uid);
  });
});
