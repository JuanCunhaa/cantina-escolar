import { expect, test, type Page } from "@playwright/test";
import { createTestUser } from "../helpers/auth-emulator";

async function login(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill("senha-fake-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText(`Conectado: ${email}`)).toBeVisible();
}

test("duas contas fictícias: login, listener privado e comando servidor isolados (A33/A34/A35)", async ({ browser }) => {
  const a = await createTestUser("e2e-a");
  const b = await createTestUser("e2e-b");
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();

  await login(pageA, a.email);
  await login(pageB, b.email);
  await expect(pageA.getByTestId("balance")).toContainText("R$ 0,00");
  await expect(pageB.getByTestId("balance")).toContainText("R$ 0,00");

  // Comando servidor em A: listener de A atualiza após commit; B não muda.
  await pageA.getByRole("button", { name: /Creditar/ }).click();
  await expect(pageA.getByRole("status")).toContainText("confirmado");
  await expect(pageA.getByTestId("balance")).toContainText("R$ 5,00");
  await pageB.waitForTimeout(500);
  await expect(pageB.getByTestId("balance")).toContainText("R$ 0,00");

  // Logout desliga o listener e limpa a tela; novo login não mostra dado da outra conta.
  await pageA.getByRole("button", { name: "Sair" }).click();
  await expect(pageA.getByRole("button", { name: "Entrar" })).toBeVisible();
  await expect(pageA.getByTestId("balance")).toHaveCount(0);
  await login(pageA, b.email);
  await expect(pageA.getByTestId("balance")).toContainText("R$ 0,00");
});
