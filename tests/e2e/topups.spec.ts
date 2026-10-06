import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readDemoDoc } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";

// Recarga manual e estorno (F17) pela interface, no emulador: busca nominal com turma/turno (homônimos), recebimento → revisão →
// confirmação pela RESPOSTA do servidor, R$ 50 com taxa de R$ 1,50 (crédito R$ 50, líquido R$ 48,50), clique duplo, resposta
// perdida (mesma chave), referência duplicada, comprovante, conferência do dia e estorno só com a permissão separada.

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SHIFT = `shf_tpu_${tag}`;
const CLS_A = `cls_tpu_a_${tag}`;
const CLS_B = `cls_tpu_b_${tag}`;
let admin: TestUser;
let secretaria: TestUser;
let secretariaRev: TestUser;
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
async function student(name: string, classId = CLS_A) {
  const id = `stu_tpu_${tag}_${++counter}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowSitePurchase: true, allowCounterPurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, enrollment: `T${tag}${counter}`, status: "active", userUid: null, shiftId: SHIFT, classId, version: 1 });
  return { id, name };
}
const walletOf = async (id: string) => Number((await readDemoDoc(targetFromEnv(), `wallets/${id}`))?.balanceCents ?? 0);
async function reconciled(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/wallets/reconcile?studentId=${id}`, { headers: { authorization: `Bearer ${admin.idToken}` } });
  return (await response.json()) as { ok: boolean; entryCount: number; balanceCents: number };
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function pickStudent(page: Page, name: string, classText?: string) {
  await expect(page.getByTestId("topup-student-search")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("topup-student-search").fill(name);
  const option = classText ? page.getByTestId("topup-student-option").filter({ hasText: classText }) : page.getByTestId("topup-student-option").first();
  await option.getByRole("button").click();
}
async function fill(page: Page, f: { amount: string; method?: string; reference?: string; fee?: string }) {
  await page.getByTestId("topup-amount").fill(f.amount);
  await page.getByTestId(`topup-method-${f.method ?? "pix"}`).check();
  if (f.reference !== undefined) await page.getByTestId("topup-reference").fill(f.reference);
  if (f.fee !== undefined) await page.getByTestId("topup-fee").fill(f.fee);
  await page.getByTestId("topup-review").click();
}

test.beforeAll(async ({ request }) => {
  [admin, secretaria, secretariaRev, guardian] = await Promise.all([
    createTestUser(`e2e-tpu-adm-${tag}`, "admin", { displayName: "Admin E2E" }),
    createTestUser(`e2e-tpu-sec-${tag}`, "secretaria", { displayName: "Secretaria E2E" }),
    createTestUser(`e2e-tpu-secrev-${tag}`, "secretaria", { displayName: "Secretaria Estorno E2E", permissions: ["topup.reverse"] }),
    createTestUser(`e2e-tpu-g-${tag}`, "guardian"),
  ]);
  await track(`shifts/${SHIFT}`, { name: `Manhã Rec ${tag}`, nameSlug: "manha", status: "active" });
  await track(`classes/${CLS_A}`, { name: `Turma Rec A ${tag}`, nameSlug: "turma-rec-a", status: "active" });
  await track(`classes/${CLS_B}`, { name: `Turma Rec B ${tag}`, nameSlug: "turma-rec-b", status: "active" });
  await warmRoutes(request, { post: ["/api/topups"], get: ["/operacao/recebimentos", "/operacao/recebimentos/tpm_x", "/api/topups", "/api/topups/students"] });
});
test.afterAll(removeCreated);

test.describe("recarga manual na secretaria (A04/A07)", () => {
  test("homônimos por turma/turno, R$ 50 com taxa R$ 1,50: revisão, clique duplo, crédito integral, comprovante e conferência", async ({ page, request }) => {
    const nome = `Rafa Homônimo ${tag}`;
    const certo = await student(nome, CLS_A);
    const outro = await student(nome, CLS_B);
    await login(page, secretaria.email, "/operacao/recebimentos");
    await expect(page.getByRole("link", { name: "Recebimentos" })).toBeVisible({ timeout: 30000 });
    await page.getByTestId("topup-student-search").fill(nome.toLowerCase().replace("ô", "o"));
    await expect(page.getByTestId("topup-student-option")).toHaveCount(2);
    await expect(page.getByTestId("topup-student-option").filter({ hasText: `Turma Rec B ${tag}` })).toContainText("Nome repetido");
    await pickStudent(page, nome, `Turma Rec A ${tag}`);
    await expect(page.getByTestId("topup-student")).toContainText(`Turma Rec A ${tag}`);
    await expect(page.getByTestId("topup-balance")).toHaveText(/0,00/);

    const ref = `E2E${tag}PIX0001`;
    await fill(page, { amount: "50", reference: ref, fee: "1,50" });
    await expect(page.getByTestId("topup-review-credit")).toContainText("R$ 50,00");
    await expect(page.getByTestId("topup-review-net")).toContainText("1,50");
    await expect(page.getByTestId("topup-review-net")).toContainText("48,50");
    await expect(page.getByTestId("topup-confirm")).toBeDisabled(); // sem a confirmação da conferência
    await page.getByTestId("topup-confirmed").check();
    await page.getByTestId("topup-confirm").dblclick();
    await expect(page.getByTestId("topup-done-text")).toContainText("R$ 50,00 creditados", { timeout: 20000 });
    await expect(page.getByTestId("topup-balance")).toHaveText(/50,00/);
    expect(await walletOf(certo.id)).toBe(5000);
    expect(await walletOf(outro.id)).toBe(0);
    expect(await reconciled(request, certo.id)).toMatchObject({ ok: true, entryCount: 1, balanceCents: 5000 });

    await expect(page.getByTestId("topup-day-row").filter({ hasText: nome })).toContainText("48,50");
    await page.getByTestId("topup-only-mine").check();
    await expect(page.getByTestId("topup-day-row").filter({ hasText: nome })).toContainText("Secretaria E2E");

    await page.getByTestId("topup-receipt-link").click();
    await expect(page.getByTestId("receipt-credited")).toHaveText("R$ 50,00", { timeout: 20000 });
    await expect(page.getByTestId("receipt-net")).toHaveText("R$ 48,50");
    await expect(page.getByTestId("receipt-student")).toContainText(nome);
    await expect(page.getByTestId("receipt-reverse-open")).toHaveCount(0); // secretaria sem a permissão separada
    await expect(page.getByText("Estorno só com permissão específica")).toBeVisible();
  });

  test("resposta perdida: a tela pede para repetir a MESMA recarga e o servidor credita uma vez; referência repetida é recusada", async ({ page, request }) => {
    const aluno = await student(`Bia Resposta ${tag}`);
    let attempts = 0;
    await page.route("**/api/topups", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts += 1;
      if (attempts === 1) {
        await route.fetch(); // o servidor registra a recarga…
        await route.abort("connectionreset"); // …mas a resposta não chega
      } else await route.continue();
    });
    await login(page, secretaria.email, "/operacao/recebimentos");
    await pickStudent(page, aluno.name);
    const ref = `NSU${tag}777AUT1`;
    await fill(page, { amount: "20", method: "card_credit", reference: ref });
    await page.getByTestId("topup-confirmed").check();
    await page.getByTestId("topup-confirm").click();
    await expect(page.getByTestId("topup-uncertain")).toBeVisible({ timeout: 25000 });
    await expect(page.getByTestId("topup-confirm")).toHaveText("Tentar novamente a mesma recarga");
    await page.getByTestId("topup-confirm").click();
    await expect(page.getByTestId("topup-done-text")).toContainText("R$ 20,00 creditados", { timeout: 20000 });
    expect(attempts).toBe(2);
    expect(await reconciled(request, aluno.id)).toMatchObject({ ok: true, entryCount: 1, balanceCents: 2000 });

    // O mesmo comprovante (NSU) lançado de novo, agora com outra chave, é recusado com link para o lançamento existente.
    await fill(page, { amount: "20", method: "card_debit", reference: ref.toLowerCase() });
    await page.getByTestId("topup-confirmed").check();
    await page.getByTestId("topup-confirm").click();
    await expect(page.getByTestId("topup-message")).toContainText("já foi lançado");
    await expect(page.getByRole("link", { name: "Ver o recebimento já lançado" })).toBeVisible();
    expect(await walletOf(aluno.id)).toBe(2000);
  });

  test("estorno com permissão separada: novo movimento, motivo, saldo atualizado e histórico preservado; celular sem rolagem lateral", async ({ page, request }) => {
    const aluno = await student(`Caio Estorno ${tag}`);
    const r = await request.post("/api/topups", { headers: { authorization: `Bearer ${secretaria.idToken}` }, data: { key: randomUUID(), studentId: aluno.id, amountCents: 3000, method: "cash", receivedConfirmed: true } });
    expect(r.status(), await r.text()).toBe(200);
    const { topupId } = (await r.json()) as { topupId: string };

    await login(page, secretariaRev.email, `/operacao/recebimentos/${topupId}`);
    await expect(page.getByTestId("receipt-credited")).toHaveText("R$ 30,00", { timeout: 30000 });
    await page.getByTestId("receipt-reverse-open").click();
    await expect(page.getByTestId("reverse-max")).toHaveText("R$ 30,00");
    await page.getByTestId("reverse-amount").fill("12,50");
    await page.getByTestId("reverse-reason").fill("Valor digitado a mais");
    await page.getByTestId("reverse-review").click();
    await expect(page.getByTestId("reverse-summary")).toContainText("R$ 12,50");
    await page.getByTestId("reverse-confirm").dblclick();
    await expect(page.getByTestId("receipt-message")).toContainText("Saldo do aluno agora: R$ 17,50", { timeout: 20000 });
    await expect(page.getByTestId("receipt-reversals")).toContainText("Valor digitado a mais");
    await expect(page.getByTestId("receipt-status")).toContainText("Estornada em parte");
    await expect(page.getByTestId("receipt-credited")).toHaveText("R$ 30,00"); // o lançamento original não muda
    expect(await reconciled(request, aluno.id)).toMatchObject({ ok: true, entryCount: 2, balanceCents: 1750 });

    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/operacao/recebimentos");
    await expect(page.getByTestId("topup-student-search")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("topup-day-row").first()).toBeVisible({ timeout: 20000 });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });
});
