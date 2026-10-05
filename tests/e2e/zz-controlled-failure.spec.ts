// TEMPORÁRIO: falha controlada para validar a coleta de evidências do CI. Nunca vai para a main.
import { expect, test } from "@playwright/test";
test("falha controlada (validação da coleta de evidências)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("nao-existe")).toBeVisible({ timeout: 2000 });
});
