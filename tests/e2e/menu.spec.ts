import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createTestUser, TEST_PASSWORD } from "../helpers/auth-emulator";
import { createTempProduct, prepareCatalog, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { warmRoutes } from "../helpers/dev-server.ts";
import { createFamily } from "../helpers/menu-fixtures.ts";

// Cardápio por data/turno (F07), no emulador e na homologação. Usa só dados próprios: família com aluno fictício na
// manhã de exemplo e produtos temporários criados pela API (desativados ao fim; nada é apagado). As datas vêm da janela
// devolvida pelo servidor (hoje … hoje+7), evitando hoje para não depender do horário de fechamento.

async function login(page: Page, path: string, email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

type Week = { today: string; days: { date: string; allowed: boolean; service: string; items: { productId: string; source: string }[] }[] };
const dayMonth = (date: string) => date.split("-").reverse().slice(0, 2).join("/");
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test.beforeAll(async ({ request }) => {
  await prepareCatalog();
  // TODAS as rotas do fluxo compiladas antes de abrir as páginas (família e administração ficam abertas juntas).
  await warmRoutes(request, {
    post: ["/api/students", "/api/links", "/api/menu", "/api/catalog/products"],
    get: ["/api/catalog/photo?productId=x", "/api/menu", "/operacao/cardapio", "/portal/cardapio"],
  });
});

test("administração monta o cardápio da data pela tela; a família vê o extra só na data/turno e o oculto some só nela (A15/A12/A14)", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 6);
  const family = await createFamily(request, "e2e-cardapio");
  const afternoon = await createFamily(request, "e2e-cardapio-tarde", "Tarde (exemplo)");
  const admin = family.admin;
  const names = { base: `Suco do dia ${tag}`, extra: `Hot-dog ${tag}`, hidden: `Pão de queijo ${tag}` };
  const ids = {
    base: await createTempProduct(request, admin.idToken, names.base),
    extra: await createTempProduct(request, admin.idToken, names.extra),
    hidden: await createTempProduct(request, admin.idToken, names.hidden),
  };
  try {
    const readWeek = async (token: string, studentId: string) => (await (await request.get(`/api/menu?studentId=${studentId}`, { headers: bearer(token) })).json()) as Week;
    const week = await readWeek(family.guardian.idToken, family.studentId);
    expect(week.days).toHaveLength(8);
    const [d1, d2] = week.days.filter((d) => d.allowed && d.date !== week.today).map((d) => d.date);
    expect(d1 && d2, "duas datas com compra permitida na janela").toBeTruthy();

    // Família entra primeiro (no dev server a 1ª compilação de uma rota recarrega as outras páginas abertas).
    const familyPage = await (await browser.newContext()).newPage();
    await login(familyPage, "/portal/cardapio", family.guardian.email);
    await expect(familyPage.getByTestId("menu-student")).toContainText(family.studentName, { timeout: 30000 });
    await expect(familyPage.getByRole("group", { name: "Data do lanche" }).getByRole("radio")).toHaveCount(8);

    const page = await (await browser.newContext()).newPage();
    await login(page, "/operacao/cardapio", admin.email);
    await expect(page.getByRole("heading", { name: "Cardápio", exact: true })).toBeVisible({ timeout: 20000 });

    // Cardápio padrão pela tela: produto base e "pão" entram na manhã de exemplo.
    const defaults = page.getByTestId("menu-default");
    for (const name of [names.base, names.hidden]) {
      const box = defaults.getByRole("checkbox", { name: `${name} no cardápio padrão — Manhã (exemplo)` });
      await box.click();
      await expect(box).toBeChecked({ timeout: 15000 });
    }
    await expect(defaults.getByRole("checkbox", { name: `${names.extra} no cardápio padrão — Manhã (exemplo)` })).not.toBeChecked();

    // Exceções em d1/manhã: extra com limite e ocultação do pão (com motivo).
    const day = page.getByTestId("menu-day");
    await day.getByLabel("Data", { exact: true }).fill(d1!);
    await day.getByLabel("Turno", { exact: true }).selectOption({ label: "Manhã (exemplo)" });
    await expect(day.getByTestId("service-state")).toContainText("Atendimento normal");
    await day.getByLabel("Motivo (fica na auditoria; não aparece para as famílias)").fill(`Dia especial ${tag}`);
    await day.getByLabel("Adicionar produto extra nesta data e turno").selectOption({ label: names.extra });
    await day.getByLabel("Limite do extra (opcional)").fill("30");
    await day.getByRole("button", { name: "Adicionar extra" }).click();
    const extraRow = day.getByTestId("day-row").filter({ hasText: names.extra });
    await expect(extraRow).toContainText("Extra", { timeout: 15000 });
    await expect(extraRow).toContainText("30 un.");
    await day.getByRole("button", { name: `Ocultar ${names.hidden}` }).click();
    await expect(day.getByTestId("day-row").filter({ hasText: names.hidden })).toContainText("Oculto nesta data", { timeout: 15000 });
    // Próximas exceções: a data aparece com o resumo (na homologação pode somar entradas de execuções anteriores).
    await expect(page.getByTestId("menu-upcoming").getByRole("listitem").filter({ hasText: dayMonth(d1!) }).filter({ hasText: "Manhã (exemplo)" })).toContainText(
      /\d+ extras?, \d+ ocultos?/,
    );

    // Família (aluno da manhã): em d1 vê o extra (limitado) e não vê o pão; em d2 vê o pão e não vê o extra.
    await familyPage.reload();
    const product = (name: string) => familyPage.getByTestId("product").filter({ hasText: name });
    await familyPage.getByRole("radio", { name: new RegExp(dayMonth(d1!)) }).check();
    await expect(product(names.extra)).toBeVisible({ timeout: 20000 });
    await expect(product(names.extra)).toContainText("Extra do dia");
    await expect(product(names.extra)).toContainText("Quantidade limitada");
    await expect(product(names.base)).toBeVisible();
    await expect(product(names.hidden)).toHaveCount(0);
    await expect(familyPage.getByText(`Dia especial ${tag}`)).toHaveCount(0); // motivo é interno
    await familyPage.getByRole("radio", { name: new RegExp(dayMonth(d2!)) }).check();
    await expect(product(names.hidden)).toBeVisible();
    await expect(product(names.base)).toBeVisible();
    await expect(product(names.extra)).toHaveCount(0);

    // O turno é do aluno: o aluno da tarde não recebe o padrão nem o extra da manhã.
    const tarde = await readWeek(afternoon.guardian.idToken, afternoon.studentId);
    const offeredAfternoon = tarde.days.flatMap((d) => d.items.map((i) => i.productId));
    for (const id of Object.values(ids)) expect(offeredAfternoon).not.toContain(id);
    // Outra família não lê o cardápio deste aluno.
    expect((await request.get(`/api/menu?studentId=${family.studentId}`, { headers: bearer(afternoon.guardian.idToken) })).status()).toBe(403);

    // Suspensão em d2 pela tela: a família vê "Suspenso", sem itens; retomar volta ao normal.
    await day.getByLabel("Data", { exact: true }).fill(d2!);
    await expect(day.getByTestId("service-state")).toContainText("Atendimento normal");
    await day.getByLabel("Motivo (fica na auditoria; não aparece para as famílias)").fill(`Passeio ${tag}`);
    await day.getByRole("button", { name: "Suspender atendimento" }).click();
    await expect(day.getByTestId("service-state")).toContainText("Atendimento suspenso", { timeout: 15000 });
    await familyPage.reload();
    const d2Radio = familyPage.getByRole("radio", { name: new RegExp(`${dayMonth(d2!)}: Suspenso`) });
    await d2Radio.check();
    await expect(familyPage.getByTestId("day-notice")).toContainText("Atendimento suspenso");
    await expect(familyPage.getByTestId("product")).toHaveCount(0);
    await day.getByRole("button", { name: "Retomar atendimento" }).click();
    await expect(day.getByTestId("service-state")).toContainText("Atendimento normal", { timeout: 15000 });

    // Remover o extra e voltar a mostrar o pão em d1 (a tela da família, recarregada, volta ao padrão).
    await day.getByLabel("Data", { exact: true }).fill(d1!);
    await day.getByRole("button", { name: `Remover extra ${names.extra}` }).click();
    await expect(day.getByTestId("day-row").filter({ hasText: names.extra })).toHaveCount(0, { timeout: 15000 });
    await day.getByRole("button", { name: `Mostrar ${names.hidden}` }).click();
    await expect(day.getByTestId("day-row").filter({ hasText: names.hidden })).toContainText("Padrão", { timeout: 15000 });
    await familyPage.reload();
    await familyPage.getByRole("radio", { name: new RegExp(dayMonth(d1!)) }).check();
    await expect(product(names.hidden)).toBeVisible({ timeout: 20000 });
    await expect(product(names.extra)).toHaveCount(0);

    // Inspeção visual: 375 px sem rolagem horizontal (operação e portal) e desktop.
    for (const [target, label] of [
      [page, "operacao"],
      [familyPage, "portal"],
    ] as const) {
      await target.setViewportSize({ width: 375, height: 800 });
      await expect.poll(() => target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await target.screenshot({ path: `test-results/f07-${label}-375.png`, fullPage: true });
      await target.setViewportSize({ width: 1280, height: 900 });
      await target.screenshot({ path: `test-results/f07-${label}-1280.png`, fullPage: true });
    }
  } finally {
    for (const id of Object.values(ids)) await retireTempProduct(request, admin.idToken, id);
  }
});

test("cantina consulta o cardápio sem alterar; secretaria não usa a tela; janela recusa hoje+8 (A14/A30)", async ({ page, request }) => {
  const family = await createFamily(request, "e2e-cardapio-janela");
  const week = (await (await request.get(`/api/menu?studentId=${family.studentId}`, { headers: bearer(family.guardian.idToken) })).json()) as Week;
  const beyond = new Date(`${week.today}T12:00:00Z`);
  beyond.setUTCDate(beyond.getUTCDate() + 8);
  const plus8 = beyond.toISOString().slice(0, 10);
  const plus7 = week.days.at(-1)!.date;
  expect((await request.get(`/api/menu?studentId=${family.studentId}&date=${plus8}`, { headers: bearer(family.guardian.idToken) })).status()).toBe(422);
  expect((await request.get(`/api/menu?studentId=${family.studentId}&date=${plus7}`, { headers: bearer(family.guardian.idToken) })).status()).toBe(200);
  // Fim de semana na janela: sem atendimento, sem itens.
  expect(week.days.some((d) => d.service === "closed" && d.items.length === 0)).toBe(true);
  // Família não altera o cardápio.
  const denied = await request.post("/api/menu", {
    headers: bearer(family.guardian.idToken),
    data: { key: randomUUID(), action: "setService", date: plus7, shiftId: "shf_x", expectedVersion: 0, suspended: true, reason: "Golpe" },
  });
  expect(denied.status()).toBe(403);

  const cantina = await createTestUser("e2e-cardapio-cantina", "cantina");
  await login(page, "/operacao/cardapio", cantina.email);
  await expect(page.getByTestId("menu-default")).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("Seu perfil pode consultar; alterações são da administração.", { exact: false })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Adicionar extra" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Suspender atendimento" })).toHaveCount(0);

  const secretaria = await createTestUser("e2e-cardapio-secretaria", "secretaria");
  const other = await (await page.context().browser()!.newContext()).newPage();
  await login(other, "/operacao/cardapio", secretaria.email);
  await expect(other.getByText("Seu perfil não consulta o cardápio da operação.")).toBeVisible({ timeout: 20000 });
});
