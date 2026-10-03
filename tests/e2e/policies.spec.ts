import { expect, test, type Locator, type Page } from "@playwright/test";
import { addDays, localDateOf, weekStartOf } from "../../src/lib/dates/school-time";
import { readDemoDoc } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc } from "../helpers/auth-emulator";
import { prepareCatalog } from "../helpers/catalog-fixtures.ts";
import { warmRoutes } from "../helpers/dev-server.ts";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);

async function login(page: Page, email: string) {
  await page.goto("/portal/alunos");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}
const panelOf = (page: Page, studentId: string): Locator => page.locator(`[data-testid="policy-panel"][data-student="${studentId}"]`);

test.beforeAll(async ({ request }) => {
  await prepareCatalog();
  await warmRoutes(request, { post: ["/api/policies", "/api/policies/exceptions"], get: ["/portal/alunos"] });
});

test.describe("limites, bloqueios e comprometimento no portal do responsável (A08–A11, A35 parcial)", () => {
  test("limite por data de consumo, redução sem cancelar compromisso, bloqueios e autorização única; segundo responsável e isolamento", async ({ page, browser }) => {
    const guardianA = await createTestUser(`e2e-p-a-${tag}`, "guardian");
    const guardianB = await createTestUser(`e2e-p-b-${tag}`, "guardian");
    const outsider = await createTestUser(`e2e-p-x-${tag}`, "guardian");
    const studentId = `stu_${tag}_pol`;
    await seedStudentAccess({ studentId, name: `Ana Política ${tag}`, guardianUids: [guardianA.uid, guardianB.uid] });

    // Compromisso anterior (R$ 8,00 para amanhã), como virá dos pedidos de F11/F15: fixture de TESTE no formato real.
    const tomorrow = addDays(localDateOf(new Date()), 1);
    await writeDemoDoc(targetFromEnv(), `studentUsage/${studentId}/days/${tomorrow}`, { studentId, date: tomorrow, committedCents: 800, version: 1 });
    await writeDemoDoc(targetFromEnv(), `studentUsage/${studentId}/weeks/${weekStartOf(tomorrow)}`, { studentId, weekStart: weekStartOf(tomorrow), committedCents: 800, version: 1 });

    await login(page, guardianA.email);
    const panel = panelOf(page, studentId);
    await expect(panel).toBeVisible({ timeout: 20000 });
    const row = panel.locator(`[data-date="${tomorrow}"]`);
    await expect(row).toContainText("R$ 8,00"); // comprometimento ao vivo

    // Limite diário R$ 10: sobram R$ 2,00 para amanhã; outros dias mostram o teto inteiro.
    await panel.getByLabel("Limite diário (R$)").fill("10,00");
    await panel.getByLabel("Limite semanal (R$)").fill("30,00");
    await panel.getByRole("button", { name: "Salvar limites" }).click();
    await expect(panel.getByTestId("policy-message")).toContainText("Limites salvos");
    await expect(row).toContainText("R$ 2,00");
    await expect(panel.locator(`[data-week="${weekStartOf(tomorrow)}"]`)).toContainText("R$ 22,00");

    // Reduzir o limite NÃO cancela: o compromisso aparece acima do teto e o uso no banco permanece igual.
    await panel.getByLabel("Limite diário (R$)").fill("5,00");
    await panel.getByRole("button", { name: "Salvar limites" }).click();
    const existing = panel.getByTestId("existing-commitments");
    await expect(existing).toContainText("mantidos, nada foi cancelado");
    await expect(existing).toContainText("R$ 8,00");
    await expect(existing).toContainText("excesso R$ 3,00");
    await expect(row).toContainText("R$ 8,00");
    const usage = await readDemoDoc(targetFromEnv(), `studentUsage/${studentId}/days/${tomorrow}`);
    expect(usage?.committedCents).toBe(800);

    // Valor inválido não vai ao servidor; limite diário maior que o semanal é recusado pelo servidor.
    await panel.getByLabel("Limite diário (R$)").fill("abc");
    await panel.getByRole("button", { name: "Salvar limites" }).click();
    await expect(panel.getByTestId("policy-message")).toContainText("Informe valores em reais");
    await panel.getByLabel("Limite diário (R$)").fill("40,00");
    await panel.getByRole("button", { name: "Salvar limites" }).click();
    await expect(panel.getByTestId("policy-message")).toContainText("limite diário não pode ser maior");

    // Bloqueios por categoria e produto (valem no site e no balcão).
    // A caixa só muda quando o servidor confirma (leitura ao vivo): clique + espera, não check().
    await panel.getByLabel("Bebidas (exemplo)", { exact: true }).click();
    await expect(panel.getByLabel("Bebidas (exemplo)", { exact: true })).toBeChecked();
    await expect(panel.getByTestId("policy-message")).toContainText("Bloqueios atualizados");
    await panel.getByLabel(/^Pão com queijo \(exemplo\)/).click();
    await expect(panel.getByLabel(/^Pão com queijo \(exemplo\)/)).toBeChecked();
    await expect(panel.getByTestId("blocked-products")).toContainText("Pão com queijo (exemplo)");

    // Autorização de uso único para amanhã (aparece na lista e pode ser revogada).
    await panel.getByLabel("Data do consumo").selectOption(tomorrow);
    await panel.getByLabel("Valor máximo (R$)").fill("6,50");
    await panel.getByRole("button", { name: "Autorizar" }).click();
    const authorizations = panel.getByTestId("active-exceptions");
    await expect(authorizations).toContainText("até R$ 6,50");
    await expect(authorizations).toContainText("autorização do responsável");
    await authorizations.getByRole("button", { name: "Revogar" }).click();
    await expect(panel.getByTestId("active-exceptions")).toHaveCount(0);

    // Segundo responsável (sessão separada) vê o mesmo estado e altera; tudo persiste após recarregar.
    const other = await browser.newContext();
    const pageB = await other.newPage();
    await login(pageB, guardianB.email);
    const panelB = panelOf(pageB, studentId);
    await expect(panelB.getByLabel("Bebidas (exemplo)", { exact: true })).toBeChecked({ timeout: 20000 });
    await expect(panelB.getByLabel("Limite semanal (R$)")).toHaveValue("30,00");
    await expect(panelB.getByLabel("Limite diário (R$)")).toHaveValue("5,00");
    await panelB.getByLabel("Bebidas (exemplo)", { exact: true }).click();
    await expect(panelB.getByLabel("Bebidas (exemplo)", { exact: true })).not.toBeChecked();
    await expect(panelB.getByTestId("policy-message")).toContainText("Bloqueios atualizados");
    await page.reload();
    await expect(panelOf(page, studentId).getByLabel("Bebidas (exemplo)", { exact: true })).not.toBeChecked({ timeout: 20000 });
    await other.close();

    // Responsável de outra família não vê o aluno nem o painel.
    const stranger = await browser.newContext();
    const pageX = await stranger.newPage();
    await login(pageX, outsider.email);
    await expect(pageX.getByText("Nenhum aluno vinculado à sua conta ainda.")).toBeVisible({ timeout: 20000 });
    await expect(pageX.getByTestId("policy-panel")).toHaveCount(0);
    await stranger.close();
  });
});
