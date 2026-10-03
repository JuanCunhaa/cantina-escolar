// Apoio do e2e da carteira (só emulador local: as fixtures usam o token "owner" do Firestore Emulator).
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { fundDemoWallet } from "../../scripts/lib/demo-seed.ts";
import { seedStudentAccess, targetFromEnv, TEST_PASSWORD, type TestUser } from "./auth-emulator";

export const tag = Math.random().toString(36).slice(2, 7);
export let n = 0;

export async function login(page: Page, path: string, email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

export type Family = { ana: { id: string; name: string }; bia: { id: string; name: string } };

/** Dois alunos ativos vinculados aos responsáveis informados, com saldo inicial por FIXTURE (recarga real é F17–F19). */
export async function family(guardians: TestUser[], anaCents: number, biaCents: number): Promise<Family> {
  const make = async (label: string, cents: number) => {
    const id = `stu_${tag}_${label}_${++n}`;
    const name = `${label} ${tag}${n}`;
    await seedStudentAccess({ studentId: id, name, guardianUids: guardians.map((g) => g.uid) });
    if (cents > 0) await fundDemoWallet(targetFromEnv(), id, cents);
    return { id, name };
  };
  return { ana: await make("Ana", anaCents), bia: await make("Bia", biaCents) };
}

export const card = (page: Page, id: string): Locator => page.locator(`[data-testid="wallet-student"][data-student="${id}"]`);
export const balance = (page: Page, id: string) => card(page, id).getByTestId("wallet-balance");
export const status = (page: Page) => page.getByTestId("transfer-status");

export async function openWallet(page: Page, user: TestUser, f: Family) {
  await login(page, "/portal/carteira", user.email);
  await expect(card(page, f.ana.id)).toBeVisible({ timeout: 20000 });
  await expect(card(page, f.bia.id)).toBeVisible();
}

export async function fillTransfer(page: Page, f: Family, amount: string) {
  await page.locator("#transfer-from").selectOption({ label: f.ana.name });
  await page.locator("#transfer-to").selectOption({ label: f.bia.name });
  await page.locator("#transfer-amount").fill(amount);
}

/** Verificação adicional pelo servidor (API autenticada) e pelo Admin/emulador, independente do que a tela mostra. */
export async function serverWallet(request: APIRequestContext, token: string, id: string) {
  const response = await request.get(`/api/wallets?studentId=${id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  return (await response.json()) as { balanceCents: number; version: number; entries: { type: string; amountCents: number }[] };
}
export async function reconciled(request: APIRequestContext, admin: TestUser, id: string) {
  const response = await request.get(`/api/wallets/reconcile?studentId=${id}`, { headers: { authorization: `Bearer ${admin.idToken}` } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, problems: [] });
}
