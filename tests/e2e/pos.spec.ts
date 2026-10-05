import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addDays, localDateOf } from "../../src/lib/dates/school-time";
import { fundDemoWallet, readDemoDoc } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

// PDV de balcão e venda direta (F15) pela interface, no emulador: busca nominal com turma/turno (homônimos), saldo e restrições,
// "10 balas" por digitação rápida, revisão e confirmação, clique duplo, resposta perdida (mesma chave), bloqueio de balcão,
// venda direta com recebimento confirmado e integração com Meus pedidos. O saldo vem SÓ de fixture do emulador.

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_pos_${tag}`;
const CAT = `cat_pos_${tag}`;
const CLS_A = `cls_pos_a_${tag}`;
const CLS_B = `cls_pos_b_${tag}`;
const TODAY = localDateOf(new Date());
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
async function switchTo(page: Page, email: string, path: string) {
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible({ timeout: 20000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("button", { name: "Sair", exact: true })).toBeVisible({ timeout: 30000 });
  await page.goto(path);
}
async function product(request: APIRequestContext, name: string, priceCents: number, stock = 100): Promise<Product> {
  const id = `prd_pos_${tag}_${++counter}`;
  const data = { name: `${name} ${tag}`, nameSlug: `${name.toLowerCase()}-${tag}-${counter}`, description: "Produto de teste (fictício).", categoryId: CAT, priceCents, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [SHIFT], availabilityMode: "physical", status: "active", version: 1 };
  await track(`products/${id}`, data);
  await track(`defaultMenuRules/${id}`, { productId: id, shiftIds: [SHIFT], version: 1 });
  const response = await request.post("/api/inventory/receipts", { headers: { authorization: `Bearer ${admin.idToken}` }, data: { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: stock, unitCost: "1,00" } });
  expect(response.status(), await response.text()).toBe(200);
  return { id, name: data.name, priceCents };
}
async function student(name: string, over: { classId?: string; cents?: number; counter?: boolean; daily?: number } = {}) {
  const id = `stu_pos_${tag}_${++counter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowSitePurchase: true, allowCounterPurchase: over.counter ?? true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, enrollment: `P${tag}${counter}`, status: "active", userUid: null, shiftId: SHIFT, classId: over.classId ?? CLS_A, version: 1 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: true, allowCounterPurchase: over.counter ?? true, configVersion: 1, ...(over.daily !== undefined ? { dailyLimitCents: over.daily } : {}) });
  if ((over.cents ?? 5000) > 0) await fundDemoWallet(targetFromEnv(), id, over.cents ?? 5000);
  return { id, name };
}
const walletOf = async (id: string) => Number((await readDemoDoc(targetFromEnv(), `wallets/${id}`))?.balanceCents ?? 0);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const onHand = async (request: APIRequestContext, id: string) => {
  const response = await request.get("/api/inventory", { headers: { authorization: `Bearer ${admin.idToken}` } });
  return ((await response.json()) as { items: { productId: string; onHand: number }[] }).items.find((i) => i.productId === id)?.onHand;
};

test.beforeAll(async ({ request }) => {
  [admin, cantina, guardian] = await Promise.all([createTestUser(`e2e-pos-adm-${tag}`, "admin"), createTestUser(`e2e-pos-cant-${tag}`, "cantina"), createTestUser(`e2e-pos-g-${tag}`, "guardian")]);
  await track(`shifts/${SHIFT}`, { name: `Manhã PDV ${tag}`, nameSlug: "manha", status: "active" });
  await track(`classes/${CLS_A}`, { name: `Turma PDV A ${tag}`, nameSlug: "turma-pdv-a", status: "active" });
  await track(`classes/${CLS_B}`, { name: `Turma PDV B ${tag}`, nameSlug: "turma-pdv-b", status: "active" });
  await track(`categories/${CAT}`, { name: `Categoria PDV ${tag}`, status: "active" });
  await track(`calendarDays/${TODAY}`, { kind: "extra" });
  await track(`calendarDays/${addDays(TODAY, 1)}`, { kind: "extra" });
  await warmRoutes(request, {
    post: ["/api/pos/sales", "/api/pos/direct-sales", "/api/inventory/receipts"],
    get: ["/operacao/pdv", "/portal/pedidos", "/api/pos/students", "/api/pos/catalog", "/api/inventory", "/api/orders"],
  });
});
test.afterAll(removeCreated);

test.describe("PDV de balcão (A25)", () => {
  test("homônimos por turma/turno, saldo e restrições, 10 balas por digitação rápida, revisão, clique duplo e Meus pedidos", async ({ page, request }) => {
    const bala = await product(request, "Bala", 100);
    const nome = `Maria Homônima ${tag}`;
    const certa = await student(nome, { classId: CLS_A, cents: 5000, daily: 2500 });
    const outra = await student(nome, { classId: CLS_B, cents: 3000 });

    await login(page, cantina.email, "/operacao/pdv");
    await expect(page.getByTestId("pos-student-search")).toBeVisible({ timeout: 30000 });
    await page.keyboard.press("Escape");
    await page.getByTestId("pos-student-search").fill(nome.toLowerCase().replace("ô", "o"));
    const options = page.getByTestId("pos-student-option");
    await expect(options).toHaveCount(2);
    await expect(options.filter({ hasText: `Turma PDV A ${tag}` })).toContainText(`Manhã PDV ${tag}`);
    await expect(options.filter({ hasText: `Turma PDV B ${tag}` })).toContainText("Nome repetido");

    await options.filter({ hasText: `Turma PDV A ${tag}` }).getByRole("button").click();
    await expect(page.getByTestId("pos-student-name")).toHaveText(nome);
    await expect(page.getByTestId("pos-selected")).toContainText(`Turma PDV A ${tag}`);
    await expect(page.getByTestId("pos-balance")).toHaveText(/50,00/);
    await expect(page.getByTestId("pos-remaining")).toContainText("25,00");

    // 10 balas: digitação rápida na busca de produto (Enter adiciona o primeiro resultado).
    await page.getByTestId("pos-product-search").fill(`10 bala ${tag}`);
    await expect(page.getByTestId("pos-product").filter({ hasText: bala.name })).toBeVisible({ timeout: 20000 });
    await page.getByTestId("pos-product-search").press("Enter");
    await expect(page.getByTestId("pos-line").filter({ hasText: bala.name })).toContainText("10");
    await expect(page.getByTestId("pos-total")).toContainText("10,00");
    await expect(page.getByTestId("pos-balance-effect")).toContainText("40,00");

    await page.getByTestId("pos-review").click();
    await expect(page.getByRole("heading", { name: "Revisar venda" })).toBeVisible();
    await expect(page.getByTestId("pos-who")).toContainText(`Turma PDV A ${tag}`);
    // clique duplo na confirmação: UMA venda, UM débito.
    await page.getByTestId("pos-confirm").dblclick();
    await expect(page.getByTestId("pos-receipt")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("pos-receipt")).toContainText("Venda registrada");
    await expect(page.getByTestId("pos-receipt-balance")).toHaveText(/40,00/);
    expect(await walletOf(certa.id)).toBe(4000);
    expect(await walletOf(outra.id)).toBe(3000); // o homônimo ficou intacto
    expect(await onHand(request, bala.id)).toBe(90);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    // O responsável vê a venda do balcão em Meus pedidos, concluída, com recibo.
    await switchTo(page, guardian.email, "/portal/pedidos");
    await page.getByTestId("orders-tab-completed").click();
    const row = page.getByTestId("order-row").filter({ hasText: nome }).filter({ hasText: "Compra no balcão" });
    await expect(row).toBeVisible({ timeout: 30000 });
    await expect(row).toContainText("Entregue");
    await expect(row).toContainText("10,00");
  });

  test("resposta perdida: a tela pede para repetir a MESMA venda e o servidor não cobra duas vezes", async ({ page, request }) => {
    const suco = await product(request, "Suco", 450);
    const aluno = await student(`Lia Resposta ${tag}`, { cents: 2000 });
    let attempts = 0;
    await page.route("**/api/pos/sales", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fetch(); // o servidor registra a venda…
        await route.abort("connectionreset"); // …mas a resposta nunca chega ao navegador
      } else await route.continue();
    });
    await login(page, cantina.email, "/operacao/pdv");
    await page.getByTestId("pos-student-search").fill(aluno.name);
    await page.getByTestId("pos-student-option").first().click();
    await expect(page.getByTestId("pos-balance")).toHaveText(/20,00/);
    await page.getByTestId("pos-product-search").fill(suco.name);
    await expect(page.getByTestId("pos-product").filter({ hasText: suco.name })).toBeVisible({ timeout: 20000 });
    await page.getByTestId("pos-product").filter({ hasText: suco.name }).getByTestId("pos-add-1").click();
    await page.getByTestId("pos-review").click();
    await page.getByTestId("pos-confirm").click();
    await expect(page.getByText(/Sem resposta do servidor/)).toBeVisible({ timeout: 25000 });
    await expect(page.getByTestId("pos-receipt")).toHaveCount(0); // nada é dado como feito sem a resposta
    expect(await walletOf(aluno.id)).toBe(1550); // mas o servidor já tinha debitado UMA vez
    await page.getByTestId("pos-confirm").click(); // "Tentar novamente a mesma venda"
    await expect(page.getByTestId("pos-receipt")).toContainText("Venda já registrada", { timeout: 20000 });
    await expect(page.getByTestId("pos-receipt-balance")).toHaveText(/15,50/);
    expect(await walletOf(aluno.id)).toBe(1550);
    expect(await onHand(request, suco.id)).toBe(99);
    expect(attempts).toBe(2);
  });

  test("quantidade digitada acima do estoque livre nunca é reduzida em silêncio", async ({ page, request }) => {
    const raro = await product(request, "Raro", 100, 3);
    const aluno = await student(`Uma Pouca ${tag}`, { cents: 5000 });
    await login(page, cantina.email, "/operacao/pdv");
    await page.getByTestId("pos-student-search").fill(aluno.name);
    await page.getByTestId("pos-student-option").first().click();
    await page.getByTestId("pos-product-search").fill(`10 ${raro.name}`);
    await expect(page.getByTestId("pos-product").filter({ hasText: raro.name })).toBeVisible({ timeout: 20000 });
    await page.getByTestId("pos-product-search").press("Enter");
    await expect(page.getByTestId("pos-clamp-notice")).toContainText("foram adicionadas 3, não 10");
    await expect(page.getByTestId("pos-line").filter({ hasText: raro.name })).toContainText("3");
    await expect(page.getByTestId("pos-total")).toContainText("3,00");
  });

  test("balcão não liberado e saldo curto: a tela explica e não deixa vender; o servidor também recusa", async ({ page, request }) => {
    const suco = await product(request, "Água", 300);
    const bloqueado = await student(`Noa Bloqueado ${tag}`, { counter: false });
    const curto = await student(`Ivo Curto ${tag}`, { cents: 500 });
    await login(page, cantina.email, "/operacao/pdv");
    await page.getByTestId("pos-student-search").fill(bloqueado.name);
    await page.getByTestId("pos-student-option").first().click();
    await expect(page.getByTestId("pos-counter-blocked")).toBeVisible();
    await expect(page.getByTestId("pos-product-search")).toBeDisabled();

    await page.getByTestId("pos-change-student").click();
    await page.getByTestId("pos-student-search").fill(curto.name);
    await page.getByTestId("pos-student-option").first().click();
    await page.getByTestId("pos-product-search").fill(suco.name);
    await expect(page.getByTestId("pos-product").filter({ hasText: suco.name })).toBeVisible({ timeout: 20000 });
    const add = page.getByTestId("pos-product").filter({ hasText: suco.name }).getByTestId("pos-add-1");
    await add.click();
    await add.click();
    await expect(page.getByTestId("pos-over-balance")).toContainText("faltam");
    await expect(page.getByTestId("pos-review")).toBeDisabled();
    // O servidor recusa mesmo se a tela fosse contornada.
    const direct = await request.post("/api/pos/sales", { headers: { authorization: `Bearer ${cantina.idToken}` }, data: { key: randomUUID(), studentId: bloqueado.id, expectedShiftId: SHIFT, lines: [{ productId: suco.id, quantity: 1, expectedPriceCents: 300 }] } });
    expect(direct.status()).toBe(403);
    expect(await walletOf(curto.id)).toBe(500);
  });
});

test.describe("Venda direta sem aluno", () => {
  test("recebimento confirmado, meio de pagamento e taxa; estoque baixa e nenhuma carteira é tocada", async ({ page, request }) => {
    const salgado = await product(request, "Salgado", 700);
    const bystander = await student(`Teo Parado ${tag}`, { cents: 1000 });
    await login(page, cantina.email, "/operacao/pdv");
    await page.getByTestId("pos-tab-direct").click();
    // O emulador acumula turnos "manhã" de outros specs: o turno do cardápio é escolhido explicitamente.
    await page.getByLabel("Turno do cardápio").selectOption(SHIFT);
    await page.getByTestId("pos-product-search").fill(salgado.name);
    await expect(page.getByTestId("pos-product").filter({ hasText: salgado.name })).toBeVisible({ timeout: 30000 });
    await page.getByTestId("pos-product").filter({ hasText: salgado.name }).getByTestId("pos-add-5").click();
    await page.getByTestId("pos-method-pix").check();
    await page.getByTestId("pos-fee").fill("0,20");
    await page.getByLabel("Quem comprou").selectOption("teacher");
    await page.getByLabel("Identificação (opcional)").fill("Prof. Joana");
    await page.getByTestId("pos-review").click();
    // Sem confirmar o recebimento não registra.
    await expect(page.getByTestId("pos-confirm")).toBeDisabled();
    await page.getByTestId("pos-received").check();
    await page.getByTestId("pos-confirm").click();
    await expect(page.getByTestId("pos-receipt")).toContainText("Venda direta de R$", { timeout: 20000 });
    await expect(page.getByTestId("pos-receipt")).toContainText("35,00");
    await expect(page.getByTestId("pos-receipt")).toContainText("líquido");
    expect(await onHand(request, salgado.id)).toBe(95);
    expect(await walletOf(bystander.id)).toBe(1000);
  });

  test("celular e tablet: sem rolagem lateral e com o essencial visível", async ({ page, request }) => {
    const item = await product(request, "Chiclete", 50);
    const aluno = await student(`Zeca Layout ${tag}`, { cents: 4000 });
    await login(page, cantina.email, "/operacao/pdv");
    for (const [width, height] of [[390, 800], [820, 1100]] as const) {
      await page.setViewportSize({ width, height });
      await page.getByTestId("pos-student-search").waitFor({ timeout: 30000 }).catch(() => undefined);
      if (await page.getByTestId("pos-student-search").isVisible()) {
        await page.getByTestId("pos-student-search").fill(aluno.name);
        await page.getByTestId("pos-student-option").first().click();
      }
      await page.getByTestId("pos-product-search").fill(item.name);
      await expect(page.getByTestId("pos-product").filter({ hasText: item.name })).toBeVisible({ timeout: 20000 });
      await page.getByTestId("pos-product").filter({ hasText: item.name }).getByTestId("pos-add-1").click();
      await expect(page.getByTestId("pos-total")).toBeVisible();
      await expect(page.getByTestId("pos-balance")).toBeVisible();
      expect(await overflow(page), `largura ${width}`).toBeLessThanOrEqual(0);
    }
  });
});
