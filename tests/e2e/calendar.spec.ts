import { expect, test, type Page } from "@playwright/test";
import { createTestUser, TEST_PASSWORD } from "../helpers/auth-emulator";

const tag = Math.random().toString(36).slice(2, 7);

async function login(page: Page, path: string, email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

// Compilar rotas antes evita recarga/abort do servidor de desenvolvimento no meio do fluxo.
test.beforeAll(async ({ request }) => {
  for (const url of ["/api/school", "/api/school/settings", "/api/school/calendar"]) await request.post(url, { data: {} });
  for (const url of ["/operacao/calendario", "/operacao/escola"]) await request.get(url);
});

test("administração: horários por turno, dia extra e janela de compra pela interface (A12/A13/A14)", async ({ page, request }) => {
  const admin = await createTestUser("e2e-adm5", "admin");
  const created = await request.post("/api/school", {
    headers: { authorization: `Bearer ${admin.idToken}` },
    data: { key: `e2e-shift-${tag}-0001`, action: "create", kind: "shift", name: `Turno ${tag}` },
  });
  expect(created.status()).toBe(200);

  await login(page, "/operacao/calendario", admin.email);
  await expect(page.getByRole("heading", { name: "Calendário e horários" })).toBeVisible({ timeout: 20000 });

  const settings = page.getByTestId("school-settings");
  await expect(settings).toBeVisible({ timeout: 20000 });
  await settings.getByLabel("Nome da escola").fill(`Escola Fictícia ${tag}`);
  await settings.getByLabel(`Fecha compra — Turno ${tag}`).fill("06:45");
  await settings.getByLabel(`Fecha cancelamento — Turno ${tag}`).fill("07:50");
  await settings.getByRole("button", { name: "Salvar configurações" }).click();
  await expect(settings.getByRole("status")).toContainText("Configurações salvas");

  // Dia extra: aparece na lista e some ao remover.
  const exceptions = page.getByTestId("calendar-days");
  const target = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  await exceptions.getByLabel("Data").fill(target);
  await exceptions.getByLabel("Motivo").fill(`Sábado letivo ${tag}`);
  await exceptions.getByRole("button", { name: "Salvar dia" }).click();
  await expect(exceptions.getByRole("cell", { name: `Sábado letivo ${tag}` })).toBeVisible();
  await exceptions.getByRole("button", { name: `Remover ${target}` }).click();
  await expect(exceptions.getByRole("cell", { name: `Sábado letivo ${tag}` })).toHaveCount(0);

  // Janela: oito datas locais (hoje … hoje+7) com horários do turno.
  const windowSection = page.getByTestId("purchase-window");
  await windowSection.getByLabel("Turno").selectOption({ label: `Turno ${tag}` });
  await expect(windowSection.locator("tbody tr")).toHaveCount(8);
  await expect(windowSection.getByRole("cell", { name: "06:45" }).first()).toBeVisible();

  // 375 px: sem rolagem horizontal da página; captura para inspeção visual.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/f05-calendario-375.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "test-results/f05-calendario-desktop.png", fullPage: true });

  // Homologação compartilhada: o horário do turno criado por este teste sai da configuração (os demais ficam como estavam),
  // para o mapa de horários não crescer a cada execução (limite de 50 turnos).
  const headers = { authorization: `Bearer ${admin.idToken}` };
  const shiftId = ((await created.json()) as { id: string }).id;
  const current = (await (await request.get("/api/school/settings", { headers })).json()) as {
    version: number;
    schoolName: string;
    weekdays: number[];
    shiftPolicies: Record<string, unknown>;
  };
  const cleaned = await request.post("/api/school/settings", {
    headers,
    data: {
      key: `e2e-settings-${tag}-0002`,
      expectedVersion: current.version,
      schoolName: current.schoolName,
      weekdays: current.weekdays,
      shiftPolicies: Object.fromEntries(Object.entries(current.shiftPolicies).filter(([id]) => id !== shiftId)),
    },
  });
  expect(cleaned.status()).toBe(200);
});

test("não administração não vê nem usa o calendário", async ({ page }) => {
  const cantina = await createTestUser("e2e-cantina5", "cantina");
  await login(page, "/operacao/calendario", cantina.email);
  await expect(page.getByText("Somente a administração altera o calendário e os horários.")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("school-settings")).toHaveCount(0);
});
