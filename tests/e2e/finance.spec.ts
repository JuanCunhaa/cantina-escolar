import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";
import { localDateOf } from "../../src/lib/dates/school-time.ts";

// Caixa por operador e financeiro da administração (F20) pela interface, no emulador, com dados FICTÍCIOS: abrir com saldo inicial
// confirmado, ver dinheiro/Pix/cartão separados, contar a gaveta pelo total, fechar sem diferença e com diferença (pendente, sem
// ajuste), revisão e reabertura pela administração, cadastro de maquininha e regra fictícia, conferência da taxa real e o relatório
// com a exportação. O operador não vê o financeiro da administração. Celular sem rolagem lateral.

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_fin_${tag}`;
const CLS = `cls_fin_${tag}`;
let admin: TestUser;
let secretaria: TestUser;
let guardian: TestUser;
let counter = 0;
const created: string[] = [];

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
async function student(name: string) {
  const id = `stu_fin_${tag}_${++counter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowSitePurchase: true, allowCounterPurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, enrollment: `F${tag}${counter}`, status: "active", userUid: null, shiftId: SHIFT, classId: CLS, version: 1 });
  return id;
}
async function topup(request: APIRequestContext, by: TestUser, studentId: string, body: Record<string, unknown>) {
  const r = await request.post("/api/topups", { headers: { authorization: `Bearer ${by.idToken}` }, data: { key: randomUUID(), studentId, receivedConfirmed: true, ...body } });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as { topupId: string };
}
/** Sobra horizontal da página (0 = sem rolagem lateral); com sobra, lista os elementos que passam da largura para diagnóstico. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const extra = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const wide = extra > 1 ? [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !e.closest(".table-scroll") && !e.closest(".shell-nav")).slice(0, 6).map((e) => `${e.tagName.toLowerCase()}.${String(e.className)}:${Math.round(e.getBoundingClientRect().right)}`) : [];
    return { extra, wide };
  });

test.beforeAll(async ({ request }) => {
  [admin, secretaria, guardian] = await Promise.all([
    createTestUser(`e2e-fin-adm-${tag}`, "admin", { displayName: "Admin Financeiro E2E" }),
    createTestUser(`e2e-fin-sec-${tag}`, "secretaria", { displayName: "Secretaria Caixa E2E" }),
    createTestUser(`e2e-fin-g-${tag}`, "guardian"),
  ]);
  await track(`shifts/${SHIFT}`, { name: `Manhã Fin ${tag}`, nameSlug: "manha", status: "active" });
  await track(`classes/${CLS}`, { name: `Turma Fin ${tag}`, nameSlug: "turma-fin", status: "active" });
  // Todas as rotas que o fluxo toca, antes de abrir páginas (compilar no meio do fluxo recarrega a tela e perde o estado).
  await warmRoutes(request, {
    post: ["/api/topups", "/api/cash/open", "/api/cash/close", "/api/admin/finance/cash/review", "/api/admin/finance/cash/reopen", "/api/admin/finance/sources", "/api/admin/finance/rules", "/api/admin/finance/reconcile"],
    get: [
      "/operacao/caixa",
      "/operacao/financeiro",
      "/operacao/financeiro/taxas",
      "/operacao/financeiro/conferencia",
      "/operacao/financeiro/relatorio",
      "/operacao/financeiro/caixas/x__y__z",
      "/api/cash",
      "/api/cash/x__y__z",
      "/api/finance/terminals",
      "/api/admin/finance/cash",
      "/api/admin/finance/fees",
      "/api/admin/finance/receipts",
      "/api/admin/finance/report",
    ],
  });
});
test.afterAll(removeCreated);

test.describe("caixa da secretaria (fechamento por operador)", () => {
  test("abre com saldo confirmado, vê dinheiro/Pix/cartão separados, conta pelo total e fecha SEM diferença", async ({ page, request }) => {
    const aluno = await student(`Ana Caixa ${tag}`);
    await login(page, secretaria.email, "/operacao/caixa");
    await expect(page.getByTestId("cash-point-secretaria")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("cash-point-counter")).toHaveCount(0); // a secretaria só tem o caixa da secretaria
    await expect(page.getByTestId("cash-status-secretaria")).toHaveText("Sem caixa aberto");

    await expect(page.getByTestId("cash-open")).toBeDisabled();
    await page.getByTestId("cash-opening").fill("100");
    await expect(page.getByTestId("cash-open")).toBeDisabled(); // falta confirmar a contagem
    await page.getByTestId("cash-opening-confirm").check();
    await page.getByTestId("cash-open").click();
    await expect(page.getByTestId("cash-status-secretaria")).toHaveText("Aberto", { timeout: 20000 });
    await expect(page.getByTestId("cash-message")).toContainText("R$ 100,00");

    await topup(request, secretaria, aluno, { amountCents: 5000, method: "cash" });
    await topup(request, secretaria, aluno, { amountCents: 3000, method: "pix", reference: `E2E${tag}PIX1` });
    await topup(request, secretaria, aluno, { amountCents: 2000, method: "card_credit", reference: `NSU${tag}CARD1` });
    await page.reload();
    const table = page.getByTestId("cash-methods");
    await expect(table.getByRole("row", { name: /Dinheiro/ })).toContainText("R$ 50,00", { timeout: 20000 });
    await expect(table.getByRole("row", { name: /^Pix/ })).toContainText("R$ 30,00");
    await expect(table.getByRole("row", { name: /Cartão de crédito/ })).toContainText("R$ 20,00");
    await expect(page.getByTestId("cash-expected-live")).toHaveText("R$ 150,00"); // 100 de saldo inicial + 50 em dinheiro; Pix e cartão não entram na gaveta

    await page.screenshot({ path: "test-results/f20-caixa-aberto.png", fullPage: true }); // inspeção visual (não é asserção)
    await page.getByTestId("cash-counted").fill("150");
    await page.getByTestId("cash-review").click();
    await expect(page.getByTestId("cash-expected")).toHaveText("R$ 150,00");
    await expect(page.getByTestId("cash-difference")).toContainText("Sem diferença");
    await page.getByTestId("cash-close").dblclick(); // clique duplo: uma só vez
    await expect(page.getByTestId("cash-closed")).toContainText("Fechamento 1", { timeout: 20000 });
    await expect(page.getByTestId("cash-review-status")).toHaveText("Sem divergência");
    await expect(page.getByTestId("cash-status-secretaria")).toHaveText("Fechado");
    await expect(page.getByTestId("cash-close")).toHaveCount(0);
  });

  test("movimento depois do fechamento é identificado e o fechamento não muda", async ({ page, request }) => {
    const aluno = await student(`Bia Posterior ${tag}`);
    await topup(request, secretaria, aluno, { amountCents: 700, method: "cash" });
    await login(page, secretaria.email, "/operacao/caixa");
    await expect(page.getByTestId("cash-after-close")).toContainText("1 movimento(s) lançado(s) depois do fechamento", { timeout: 30000 });
    await expect(page.getByTestId("cash-closed")).toContainText("Fechamento 1");
    await expect(page.getByTestId("cash-closed")).toContainText("Sem diferença");
  });

  test("a secretaria não vê nem abre o financeiro da administração", async ({ page }) => {
    await login(page, secretaria.email, "/operacao/financeiro");
    await expect(page.getByText("Seu perfil não acessa o financeiro.")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("link", { name: "Financeiro" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Caixa" })).toBeVisible();
  });
});

test.describe("divergência, revisão e reabertura pela administração", () => {
  let operator: TestUser;
  test("fechar com 1 centavo a menos: aviso claro, pendente de revisão e nenhum ajuste", async ({ page, request }) => {
    operator = await createTestUser(`e2e-fin-div-${tag}`, "secretaria", { displayName: "Secretaria Divergência E2E" });
    const aluno = await student(`Caio Divergência ${tag}`);
    await login(page, operator.email, "/operacao/caixa");
    await page.getByTestId("cash-opening").fill("20");
    await page.getByTestId("cash-opening-confirm").check();
    await page.getByTestId("cash-open").click();
    await expect(page.getByTestId("cash-status-secretaria")).toHaveText("Aberto", { timeout: 20000 });
    await topup(request, operator, aluno, { amountCents: 1000, method: "cash" });
    await page.reload();
    await page.getByTestId("cash-counted").fill("29,99");
    await page.getByTestId("cash-review").click();
    await expect(page.getByTestId("cash-difference")).toContainText("Falta R$ 0,01");
    await expect(page.getByTestId("cash-review-panel")).toContainText("Qualquer diferença, mesmo de 1 centavo, fica pendente de revisão");
    await page.getByTestId("cash-close").click();
    await expect(page.getByTestId("cash-review-status")).toHaveText("Divergência pendente de revisão da administração", { timeout: 20000 });
    await expect(page.getByTestId("cash-message")).toContainText("divergência");
  });

  test("a administração vê o alerta, revisa sem ajuste e depois reabre com motivo; o operador fecha de novo", async ({ page }) => {
    await login(page, admin.email, "/operacao/financeiro");
    const row = page.getByTestId("fin-sessions").getByRole("row", { name: /Secretaria Divergência E2E/ });
    await expect(row).toContainText("Falta R$ 0,01", { timeout: 30000 });
    await expect(row).toContainText("Divergência pendente");
    await expect(page.getByTestId("fin-alerts")).toContainText("Divergência pendente de revisão");
    await row.getByRole("link").first().click();

    await expect(page.getByTestId("fin-closure")).toContainText("Falta R$ 0,01", { timeout: 20000 });
    await expect(page.getByTestId("fin-review")).toBeDisabled(); // nota obrigatória
    await page.screenshot({ path: "test-results/f20-caixa-admin.png", fullPage: true });
    await page.getByTestId("fin-note").fill("Troco conferido com a operadora");
    await page.getByTestId("fin-review").click();
    await expect(page.getByTestId("fin-message")).toContainText("aprovada, sem ajuste", { timeout: 20000 });
    await expect(page.getByTestId("fin-review-status")).toContainText("aprovada pela administração (sem ajuste)");

    await expect(page.getByTestId("fin-reopen")).toBeDisabled(); // motivo obrigatório
    await page.getByTestId("fin-reason").fill("Faltou lançar o troco devolvido");
    await page.getByTestId("fin-reopen").click();
    await expect(page.getByTestId("fin-message")).toContainText("Caixa reaberto", { timeout: 20000 });
    await expect(page.getByTestId("fin-history")).toContainText("Caixa reaberto");
    await expect(page.getByTestId("fin-history")).toContainText("Faltou lançar o troco devolvido");
  });

  test("reaberto, o operador volta a ver o fechamento e fecha de novo (versão 2); a versão 1 fica no histórico", async ({ page }) => {
    await login(page, operator.email, "/operacao/caixa");
    await expect(page.getByTestId("cash-status-secretaria")).toHaveText("Reaberto", { timeout: 30000 });
    await page.getByTestId("cash-counted").fill("30");
    await page.getByTestId("cash-review").click();
    await page.getByTestId("cash-close").click();
    await expect(page.getByTestId("cash-closed")).toContainText("Fechamento 2", { timeout: 20000 });
    await expect(page.getByTestId("cash-closed")).toContainText("Fechamento 1 ·");
    await expect(page.getByTestId("cash-review-status")).toHaveText("Sem divergência");
  });
});

test.describe("taxas, conferência e relatório (regras FICTÍCIAS)", () => {
  let aluno: string;

  test("a administração cadastra maquininha e regra fictícias; a regra fica marcada, versionada e sem retroatividade", async ({ page }) => {
    aluno = await student(`Duda Taxa ${tag}`);
    await login(page, admin.email, "/operacao/financeiro/taxas");
    await expect(page.getByTestId("fees-env")).toContainText("FICTÍCIOS são permitidos", { timeout: 30000 });
    await page.getByLabel("Código (letras minúsculas e números)").fill(`m${tag}`.toLowerCase().replace(/[^a-z0-9]/g, ""));
    await page.getByLabel("Nome", { exact: true }).fill("Maquininha E2E");
    await page.getByTestId("src-create").click();
    await expect(page.getByTestId("fees-message")).toContainText("Cadastro criado", { timeout: 20000 });
    await expect(page.getByTestId("fees-sources")).toContainText("[FICTÍCIA] Maquininha E2E");

    await page.getByLabel("Fonte").selectOption({ label: "[FICTÍCIA] Maquininha E2E" });
    await page.getByLabel("Meio").selectOption({ label: "Cartão de crédito (1x)" });
    await page.getByTestId("rule-percent").fill("3,00");
    await expect(page.getByLabel(/^Prazo \(em/)).toBeDisabled(); // sem escolher a base, o prazo nem é digitável
    await page.getByLabel("Base do prazo de liquidação").selectOption("calendar_days");
    await page.getByLabel(/^Prazo \(em dias corridos\)/).fill("30");
    await expect(page.getByTestId("rule-publish")).toBeDisabled(); // falta o motivo
    await page.getByTestId("rule-reason").fill("Regra FICTÍCIA de homologação E2E");
    await page.getByTestId("rule-publish").click();
    await expect(page.getByTestId("fees-message")).toContainText("Lançamentos anteriores não mudam", { timeout: 20000 });
    const series = page.locator("[data-testid^='fees-series-term_']");
    await expect(series.first()).toContainText("v1");
    await expect(series.first()).toContainText("Em vigor");
    await expect(series.first()).toContainText("3,00%");
    await expect(series.first()).toContainText("30 dias corridos"); // a base do prazo sempre à vista
    await expect(series.first()).toContainText("FICTÍCIA");
    await page.screenshot({ path: "test-results/f20-taxas.png", fullPage: true });
  });

  test("recebimento no cartão com a maquininha: a secretaria escolhe só pelo nome; a administração confere a taxa REAL e o relatório usa o real", async ({ page, request }) => {
    // a secretaria vê a maquininha pelo nome, nunca o percentual
    const terminals = await request.get("/api/finance/terminals", { headers: { authorization: `Bearer ${secretaria.idToken}` } });
    const list = (await terminals.json()) as { terminals: { sourceId: string; name: string }[] };
    const terminal = list.terminals.find((t) => t.name === "[FICTÍCIA] Maquininha E2E")!;
    expect(terminal).toBeTruthy();
    expect(JSON.stringify(list)).not.toMatch(/percent|3,00|prazo/i);
    const t = await topup(request, secretaria, aluno, { amountCents: 5000, method: "card_credit", reference: `NSU${tag}TAXA1`, sourceId: terminal.sourceId });

    await login(page, admin.email, "/operacao/financeiro/conferencia");
    const row = page.locator(`tr[data-ref="topup:${t.topupId}"]`);
    await expect(row).toContainText("Estimada pela regra", { timeout: 30000 });
    await expect(row).toContainText("R$ 1,50"); // 3% de R$ 50,00
    await expect(row).toContainText("regra FICTÍCIA");
    await row.getByRole("button", { name: "Conferir" }).click();
    await page.getByLabel(/^Taxa real, R\$/).fill("1,48");
    await page.getByLabel("Liquidada em").fill(localDateOf(new Date()));
    await page.getByTestId(`save-topup:${t.topupId}`).click();
    await expect(page.getByTestId("rec-message")).toContainText("Carteira e livro não foram alterados", { timeout: 20000 });
    await expect(page.locator(`tr[data-ref="topup:${t.topupId}"]`)).toHaveCount(0); // taxa e liquidação conferidas: saiu da lista
    const today = localDateOf(new Date());
    const report = await request.get(`/api/admin/finance/report?from=${today}&to=${today}`, { headers: { authorization: `Bearer ${admin.idToken}` } });
    expect(report.status()).toBe(200);
  });

  test("relatório: base de data, totais sem repetir taxa, aviso de regra fictícia e exportação; celular sem rolagem lateral", async ({ page }) => {
    await login(page, admin.email, "/operacao/financeiro/relatorio");
    await expect(page.getByTestId("rep-totals")).toContainText("Taxa efetiva (soma, sem repetir)", { timeout: 30000 });
    await expect(page.getByText("data do recebimento")).toBeVisible();
    await expect(page.getByTestId("rep-fictitious")).toContainText("regra FICTÍCIA");
    await page.screenshot({ path: "test-results/f20-relatorio.png", fullPage: true });
    await expect(page.getByTestId("rep-export-detail")).toBeEnabled();
    const download = page.waitForEvent("download");
    await page.getByTestId("rep-export-summary").click();
    expect((await download).suggestedFilename()).toMatch(/^financeiro-resumo-\d{4}-\d{2}\.csv$/);

    await page.setViewportSize({ width: 360, height: 760 });
    for (const path of ["/operacao/financeiro/relatorio", "/operacao/financeiro/taxas", "/operacao/financeiro/conferencia", "/operacao/financeiro"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Financeiro" })).toBeVisible({ timeout: 20000 });
      const o = await overflow(page);
      expect(o.extra, `${path} ${o.wide.join(" | ")}`).toBeLessThanOrEqual(1);
    }
  });

  test("caixa no celular: sem rolagem lateral", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await login(page, secretaria.email, "/operacao/caixa");
    await expect(page.getByTestId("cash-point-secretaria")).toBeVisible({ timeout: 30000 });
    const o = await overflow(page);
    expect(o.extra, o.wide.join(" | ")).toBeLessThanOrEqual(1);
  });
});
