import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addDays, localDateOf } from "../../src/lib/dates/school-time";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

// Pedidos do dia, preparo, entrega parcial/total, não retirado, resolução e painel "O que preparar" (F13) pela interface, no
// emulador. Os pedidos nascem do CHECKOUT REAL (F11, pela API) para amanhã (hoje já passou do horário limite) e, para exercer a
// entrega "no dia do consumo", a data do pedido é movida para HOJE por FIXTURE do emulador (isto não ocorre em ambiente real).
// A regra de dia (entrega só no dia do consumo) é provada na integração com pedidos de datas diferentes.

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_fu_${tag}`;
const CAT = `cat_fu_${tag}`;
const CLS = `cls_fu_${tag}`;
const TODAY = localDateOf(new Date());
const TOMORROW = addDays(TODAY, 1);
let admin: TestUser;
let cantina: TestUser;
let guardian: TestUser;
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
/** Troca de conta: espera o fim da saída (formulário de entrada visível) antes de entrar com a outra; só então navega. */
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
  const id = `prd_fu_${tag}_${++counter}`;
  const data = { name: `${name} ${tag}`, nameSlug: `${name.toLowerCase()}-${tag}-${counter}`, description: "Produto de teste (fictício).", categoryId: CAT, priceCents, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [SHIFT], availabilityMode: "physical", status: "active", version: 1 };
  await track(`products/${id}`, data);
  await track(`defaultMenuRules/${id}`, { productId: id, shiftIds: [SHIFT], version: 1 });
  const response = await request.post("/api/inventory/receipts", { headers: { authorization: `Bearer ${admin.idToken}` }, data: { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: 100, unitCost: "1,00" } });
  expect(response.status(), await response.text()).toBe(200);
  return { id, name: data.name, priceCents };
}
async function student(label: string) {
  const id = `stu_fu_${tag}_${++counter}`;
  const name = `${label} ${tag}${counter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowSitePurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, status: "active", userUid: null, shiftId: SHIFT, classId: CLS, version: 1 });
  await fundDemoWallet(targetFromEnv(), id, 20000);
  return { id, name };
}
/** Compra REAL pelo checkout para amanhã; `today` move a data do pedido para hoje (fixture do emulador). */
async function order(request: APIRequestContext, studentId: string, item: Product, quantity: number, today: boolean): Promise<string> {
  const response = await request.post("/api/orders/checkout", {
    headers: { authorization: `Bearer ${guardian.idToken}` },
    data: { key: randomUUID(), studentId, expectedShiftId: SHIFT, days: [{ date: TOMORROW, lines: [{ productId: item.id, quantity, expectedPriceCents: item.priceCents }] }] },
  });
  expect(response.status(), await response.text()).toBe(200);
  const orderId = ((await response.json()) as { orders: { orderId: string }[] }).orders[0]!.orderId;
  if (today) await writeDemoDoc(targetFromEnv(), `orders/${orderId}`, { consumptionDate: TODAY }, ["consumptionDate"]);
  return orderId;
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rowOf = (page: Page, name: string) => page.getByTestId("day-order").filter({ hasText: name });

test.beforeAll(async ({ request }) => {
  [admin, cantina, guardian] = await Promise.all([createTestUser(`e2e-fu-adm-${tag}`, "admin"), createTestUser(`e2e-fu-cant-${tag}`, "cantina"), createTestUser(`e2e-fu-g-${tag}`, "guardian")]);
  await track(`shifts/${SHIFT}`, { name: `Manhã Operação ${tag}`, nameSlug: "manha", status: "active" });
  await track(`classes/${CLS}`, { name: `Turma Operação ${tag}`, nameSlug: "turma-op", status: "active" });
  await track(`categories/${CAT}`, { name: `Categoria Operação ${tag}`, status: "active" });
  for (let i = 0; i <= 8; i++) await track(`calendarDays/${addDays(TODAY, i)}`, { kind: "extra" });
  await warmRoutes(request, {
    post: ["/api/orders/checkout", "/api/inventory/receipts", "/api/operations/orders/aquecer/deliver", "/api/operations/orders/aquecer/prepare", "/api/operations/orders/aquecer/not-picked-up", "/api/operations/orders/aquecer/resolve"],
    get: ["/operacao/pedidos", "/operacao/preparacao", "/portal/pedidos", "/portal/pedidos/aquecer", "/api/orders", "/api/operations/orders", "/api/operations/preparation", "/api/orders/aquecer", "/api/inventory"],
  });
});
test.afterAll(removeCreated);

test.describe("Pedidos do dia e entrega (A19/A22/A27)", () => {
  test("lista do dia, busca, entrega parcial, clique duplo em entregar tudo e situação do pedido", async ({ page, request }) => {
    const suco = await product(request, "Suco", 450);
    const ana = await student("Ana");
    const bia = await student("Bia");
    await order(request, ana.id, suco, 3, true);
    await order(request, bia.id, suco, 1, true);

    await login(page, cantina.email, "/operacao/pedidos");
    await expect(rowOf(page, ana.name)).toBeVisible({ timeout: 30000 });
    await expect(rowOf(page, bia.name)).toBeVisible();
    await expect(rowOf(page, ana.name)).toContainText(`3× ${suco.name}`);
    await expect(rowOf(page, ana.name)).toContainText(`Turma Operação ${tag}`);
    await expect(rowOf(page, ana.name).getByTestId("day-status")).toHaveText("Pago · aguardando entrega");

    // busca por aluno e filtro de situação
    await page.getByLabel("Buscar aluno").fill(bia.name.toLowerCase());
    await expect(page.getByTestId("day-order")).toHaveCount(1);
    await page.getByLabel("Buscar aluno").fill("");
    await expect(page.getByTestId("day-order").filter({ hasText: tag })).toHaveCount(2);
    await page.getByLabel("Situação").selectOption({ label: "Pronto" });
    await expect(page.getByTestId("day-order").filter({ hasText: tag })).toHaveCount(0);
    await page.getByLabel("Situação").selectOption({ label: "Todas" });

    // preparo: agendado → em preparo → pronto
    await rowOf(page, ana.name).getByTestId("prepare").click();
    await expect(rowOf(page, ana.name).getByTestId("day-status")).toHaveText("Em preparo");
    await rowOf(page, ana.name).getByTestId("ready").click();
    await expect(rowOf(page, ana.name).getByTestId("day-status")).toHaveText("Pronto para retirada");

    // entrega parcial: 1 de 3
    await rowOf(page, ana.name).getByTestId("deliver-partial-toggle").click();
    await rowOf(page, ana.name).getByLabel(new RegExp(`${suco.name} \\(faltam 3\\)`)).fill("1");
    await rowOf(page, ana.name).getByTestId("deliver-partial-submit").click();
    await expect(rowOf(page, ana.name).getByTestId("day-status")).toHaveText(/Entregue em parte/);
    await expect(rowOf(page, ana.name)).toContainText("entregues 1, faltam 2");
    await expect(rowOf(page, ana.name).getByTestId("order-command-message")).toContainText("Restante continua pendente");

    // clique duplo em "Entregar tudo": uma única entrega (o botão trava durante o envio; o servidor recusa a repetição)
    await rowOf(page, ana.name).getByTestId("deliver-all").dblclick();
    await expect(rowOf(page, ana.name).getByTestId("day-status")).toHaveText("Entregue", { timeout: 15000 });
    await expect(rowOf(page, ana.name).getByTestId("deliver-all")).toHaveCount(0);

    // estoque físico baixou exatamente 3 unidades (100 − 3) e a reserva foi consumida
    const stock = await request.get("/api/inventory", { headers: { authorization: `Bearer ${admin.idToken}` } });
    const items = ((await stock.json()) as { items: { productId: string; onHand: number; reservedUnits: number }[] }).items;
    expect(items.find((i) => i.productId === suco.id)).toMatchObject({ onHand: 97, reservedUnits: 1 }); // 1 un. de Bia ainda reservada

    // o responsável vê o progresso, sem dado interno
    await switchTo(page, guardian.email, "/portal/pedidos");
    await page.getByTestId("orders-tab-completed").click();
    await expect(page.getByTestId("order-row").filter({ hasText: ana.name })).toContainText("Entregue", { timeout: 30000 });
    // No dev server uma compilação tardia pode recarregar a página e descartar o clique: repete até abrir o detalhe.
    await expect(async () => {
      await page.getByTestId("order-row").filter({ hasText: ana.name }).getByRole("link", { name: "Detalhes e recibo" }).click({ timeout: 3000 });
      await expect(page.getByTestId("order-items")).toBeVisible({ timeout: 8000 });
    }).toPass({ timeout: 45000 });
    await expect(page.getByTestId("order-items")).toContainText(suco.name);
    await expect(page.getByTestId("item-delivered").first()).toHaveText("3");
    await expect(page.getByTestId("item-remaining").first()).toHaveText("0");
    await expect(page.getByTestId("order-timeline")).toContainText("Entrega: 1× " + suco.name);
    await expect(page.getByTestId("order-detail")).not.toContainText(cantina.uid);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("pedido de data futura: aparece na lista (para conferência) mas sem ações de entrega/preparo", async ({ page, request }) => {
    const item = await product(request, "Pão", 300);
    const caio = await student("Caio");
    await order(request, caio.id, item, 1, false);
    await login(page, cantina.email, `/operacao/pedidos?date=${TOMORROW}`);
    await expect(rowOf(page, caio.name)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/data futura/)).toBeVisible();
    await expect(rowOf(page, caio.name).getByTestId("deliver-all")).toHaveCount(0);
    await expect(rowOf(page, caio.name).getByTestId("prepare")).toHaveCount(0);
    // celular: sem rolagem lateral da página
    await page.setViewportSize({ width: 375, height: 720 });
    await expect(rowOf(page, caio.name)).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("Não retirado e resolução (A27)", () => {
  test("cantina marca com motivo e não resolve; administração resolve com cobrança mantida; reembolso e reagendamento disponíveis", async ({ page, request }) => {
    const item = await product(request, "Torta", 600);
    const davi = await student("Davi");
    await order(request, davi.id, item, 2, true);

    await login(page, cantina.email, "/operacao/pedidos");
    await expect(rowOf(page, davi.name)).toBeVisible({ timeout: 30000 });
    await rowOf(page, davi.name).getByTestId("notpicked-toggle").click();
    await expect(rowOf(page, davi.name).getByRole("button", { name: "Confirmar não retirado" })).toBeDisabled(); // motivo obrigatório
    await rowOf(page, davi.name).getByLabel("Motivo (obrigatório)").fill("Família avisou que não virá");
    await rowOf(page, davi.name).getByRole("button", { name: "Confirmar não retirado" }).click();
    await expect(rowOf(page, davi.name).getByTestId("day-status")).toHaveText(/Não retirado · aguardando resolução/);
    await expect(rowOf(page, davi.name)).toContainText("Aguarda resolução da administração");
    await expect(rowOf(page, davi.name).getByTestId("resolve-toggle")).toHaveCount(0); // cantina não resolve
    await expect(rowOf(page, davi.name).getByTestId("deliver-all")).toHaveCount(0);
    await expect(page.getByTestId("attention")).toContainText("aguardam resolução");

    // painel: o caso aparece para resolução
    await page.goto("/operacao/preparacao");
    await expect(page.getByTestId("attention-table")).toContainText(davi.name, { timeout: 30000 });
    await expect(page.getByTestId("attention-table")).toContainText("aguarda a administração");

    await switchTo(page, admin.email, "/operacao/pedidos");
    await expect(rowOf(page, davi.name)).toBeVisible({ timeout: 30000 });
    await rowOf(page, davi.name).getByTestId("resolve-toggle").click();
    const form = rowOf(page, davi.name).getByTestId("resolve-panel");
    await expect(form.getByTestId("resolution-refund")).toBeEnabled(); // cancelar e reembolsar existe desde a F14 (provado em e2e/cancellation.spec.ts)
    await expect(form.getByTestId("resolution-reschedule")).toBeEnabled(); // reagendar existe desde a F16 (provado em e2e/amend.spec.ts)
    await expect(form.getByTestId("resolve-submit")).toBeDisabled(); // motivo obrigatório
    await form.getByLabel(/Motivo \/ política aplicada/).fill("Política da escola: cobrança mantida");
    await form.getByTestId("resolve-submit").click();
    await expect(rowOf(page, davi.name).getByTestId("day-status")).toHaveText(/encerrado com cobrança mantida/, { timeout: 15000 });
    await expect(rowOf(page, davi.name).getByTestId("order-command-message")).toContainText("Nenhuma perda registrada");
    // resolvido: sai das pendências do painel (outras pendências do emulador compartilhado não interferem)
    await page.goto("/operacao/preparacao");
    await expect(page.getByTestId("prep-table").or(page.getByText("Nenhum pedido para esta data e turno."))).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("attention-table").filter({ hasText: davi.name })).toHaveCount(0);
  });
});

test.describe("O que preparar (A19)", () => {
  test("totais por produto, previsão de sete dias, impressão e exportação CSV", async ({ page, request }) => {
    const item = await product(request, "Wrap", 700);
    const eva = await student("Eva");
    const fabio = await student("Fabio");
    await order(request, eva.id, item, 2, true);
    await order(request, fabio.id, item, 3, false); // amanhã, aparece só na previsão

    await login(page, cantina.email, "/operacao/preparacao");
    const row = page.getByTestId("prep-row").filter({ hasText: item.name });
    await expect(row).toHaveCount(1, { timeout: 30000 });
    await expect(row.locator("td").nth(1)).toHaveText("2"); // agendadas (hoje)
    await expect(row.locator("td").nth(4)).toHaveText("2"); // restantes
    const forecast = page.getByTestId("forecast-table").locator("tr").filter({ hasText: item.name });
    await expect(forecast.locator("td").nth(1)).toHaveText("2"); // hoje
    await expect(forecast.locator("td").nth(2)).toHaveText("3"); // amanhã

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar produção (CSV)" }).click()]);
    expect(download.suggestedFilename()).toBe(`producao-${TODAY}.csv`);
    const csv = (await (await import("node:fs/promises")).readFile((await download.path())!, "utf8")).replace(/^﻿/, "");
    expect(csv).toContain("Data;Turno;Produto;Agendadas;Canceladas;Entregues;Restantes;Não retiradas");
    expect(csv).toContain(`${TODAY};Manhã Operação ${tag};${item.name};2;0;0;2;0`);

    const [nominal] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar lista nominal (CSV)" }).click()]);
    const nominalCsv = await (await import("node:fs/promises")).readFile((await nominal.path())!, "utf8");
    expect(nominalCsv).toContain(eva.name);
    expect(nominalCsv).not.toContain(fabio.name); // outra data
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("família não alcança as telas operacionais (área indisponível, sem dados de pedidos)", async ({ page }) => {
    await login(page, guardian.email, "/operacao/pedidos");
    await expect(page.getByRole("heading", { name: "Área indisponível para o seu perfil" })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("day-orders")).toHaveCount(0);
    await expect(page.getByTestId("day-order")).toHaveCount(0);
  });
});
