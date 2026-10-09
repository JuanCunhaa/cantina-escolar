// Telas novas da F19 na aplicação PUBLICADA (preview × Firestore HML): revisão administrativa dos pagamentos online e a carteira/recarga da
// família com a leitura do servidor. Só leitura e navegação: nenhum pagamento é criado aqui. Capturas em test-results/.
import { expect, test } from "@playwright/test";
import { TEST_PASSWORD } from "../helpers/auth-emulator";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";

test.describe.configure({ mode: "serial" });

let fam: Family;
const tag = Math.random().toString(36).slice(2, 7);

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-f19ui-${tag}`);
});

async function login(page: import("@playwright/test").Page, email: string, path: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("administração: tela de revisão carrega pendências, contestações, pagamentos em revisão e sem recarga; família não acessa", async ({ page, request }) => {
  await login(page, fam.admin.email, "/operacao/pagamentos");
  await expect(page.getByRole("heading", { name: "Pagamentos online", level: 1 })).toBeVisible({ timeout: 45000 });
  for (const heading of [/Pendências abertas \(\d+\)/, /Pagamentos em revisão \(\d+\)/, /Contestações \(chargeback\) para acompanhar \(\d+\)/, /Pagamentos sem recarga correspondente \(\d+\)/]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Conciliar com o provedor agora" })).toBeEnabled();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Pagamentos online" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/f19-publicada-revisao-admin.png", fullPage: true });

  // A família não vê a tela nem a API.
  const denied = await request.get("/api/admin/payments", { headers: { authorization: `Bearer ${fam.guardian.idToken}` } });
  expect(denied.status()).toBe(403);
});

test("família: recarga online mostra o aviso de sandbox, o texto de que gerar o Pix não credita e a carteira consultada pelo servidor", async ({ page }) => {
  await login(page, fam.guardian.email, "/portal/carteira/recarga");
  await expect(page.getByRole("heading", { name: "Recarregar carteira" })).toBeVisible({ timeout: 45000 });
  await expect(page.getByText("O saldo só aumenta depois que o pagamento é")).toBeVisible();
  await expect(page.getByTestId("topup-sandbox")).toBeVisible();
  await expect(page.getByTestId("online-topup-form")).toBeVisible();
  await page.screenshot({ path: "test-results/f19-publicada-recarga-familia.png", fullPage: true });

  await page.goto("/portal/carteira");
  await expect(page.getByTestId("wallet-student").first()).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId("wallet-blocked")).toHaveCount(0); // sem pendência, sem aviso de bloqueio
  await page.screenshot({ path: "test-results/f19-publicada-carteira-familia.png", fullPage: true });
});
