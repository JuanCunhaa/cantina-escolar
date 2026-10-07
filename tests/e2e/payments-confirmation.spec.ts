import { expect, test, type Page } from "@playwright/test";
import { fundDemoWallet, readDemoDoc, writeDemoDoc } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";
import { family, fillTransfer, login, openWallet, status } from "../helpers/wallet-fixtures";
import { randomBytes } from "node:crypto";

// Confirmação, crédito e reversão da recarga online (F19) na INTERFACE, no emulador. O provedor da interface é o de
// DEMONSTRAÇÃO (nunca confirma); por isso o estado "Crédito lançado" é alimentado por resposta INTERCEPTADA da API de
// conciliação — isto prova a tela (processamento ≠ crédito lançado, saldo reconciliado pela versão do livro, listener/
// leitura antiga não confirmam nem regridem), NÃO o crédito financeiro: a transação, a assinatura, a duplicidade e a
// concorrência estão em tests/integration/online-confirmation-api.test.ts (emulador) e tests/staging (sandbox real).
// A tela de revisão da administração e o bloqueio da carteira usam documentos do emulador e comandos REAIS.

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const target = () => targetFromEnv();
let guardian: TestUser;
let admin: TestUser;
let secretaria: TestUser;
let counter = 0;

const hexId = () => `tpi_${randomBytes(10).toString("hex")}`;
async function loginTo(page: Page, email: string, path: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test.beforeAll(async ({ request }) => {
  [guardian, admin, secretaria] = await Promise.all([createTestUser(`e2e-pc-g-${tag}`, "guardian"), createTestUser(`e2e-pc-a-${tag}`, "admin"), createTestUser(`e2e-pc-s-${tag}`, "secretaria")]);
  await warmRoutes(request, {
    post: ["/api/topups/online", "/api/topups/online/tpi_00000000000000000000/reconcile", "/api/wallets/transfer", "/api/admin/payments/pendencies/tpi_00000000000000000000/resolve", "/api/admin/payments/reconcile"],
    get: ["/portal/carteira/recarga", "/portal/carteira", "/operacao/pagamentos", "/api/topups/online", "/api/topups/online/config", "/api/wallets", "/api/admin/payments"],
  });
});

test.describe("recarga online: processamento × crédito lançado (A05/A34)", () => {
  test("Pix em processamento NÃO é saldo; só a resposta do servidor com a intenção confirmada lança 'Crédito lançado', reconciliado pela versão; leitura antiga não regride", async ({ page, request }) => {
    const id = `stu_pc_${tag}_${++counter}`;
    const name = `Aluna Pagamento ${tag}${counter}`;
    await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid] });

    await loginTo(page, guardian.email, "/portal/carteira/recarga");
    await expect(page.getByTestId("online-topup-form")).toBeVisible({ timeout: 30000 });
    await page.getByLabel("Aluno").selectOption({ label: name });
    await page.getByLabel("Valor (R$)").fill("50,00");
    await page.getByTestId("topup-channel-pix").check();
    await page.getByRole("button", { name: "Revisar" }).click();
    await page.getByRole("button", { name: "Gerar Pix" }).click();

    const panel = page.getByTestId("topup-intent");
    await expect(panel).toHaveAttribute("data-status", "awaiting_payment", { timeout: 30000 });
    const intentId = (await panel.getAttribute("data-intent"))!;
    // Em processamento: nenhuma menção a crédito lançado, nem saldo da carteira na tela de recarga.
    await expect(page.getByTestId("topup-not-credited")).toContainText("nenhum crédito foi lançado");
    await expect(page.getByTestId("topup-credited")).toHaveCount(0);
    await expect(page.getByTestId("topup-wallet")).toHaveCount(0);

    // Um movimento qualquer na carteira (como um aviso atrasado do listener) NÃO confirma o pagamento.
    const funded = await fundDemoWallet(target(), id, 5000);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("topup-credited")).toHaveCount(0);
    await expect(panel).toHaveAttribute("data-status", "awaiting_payment");

    // A conciliação do servidor passa a informar a intenção CONFIRMADA (resposta interceptada: ver cabeçalho do arquivo).
    const real = (await (await request.get(`/api/topups/online/${intentId}`, { headers: { authorization: `Bearer ${guardian.idToken}` } })).json()) as Record<string, unknown>;
    const confirmed = {
      ...real,
      status: "confirmed",
      displayStatus: "confirmed",
      statusLabel: "Crédito lançado",
      credited: true,
      awaitingConfirmation: false,
      needsReconcile: false,
      pix: null,
      credit: { amountCents: 5000, walletEntryId: `${intentId}_credit`, walletSeq: funded.version, balanceAfterCents: funded.balanceCents, confirmedAt: new Date().toISOString(), afterExpiry: false },
      reconcile: "not_needed",
      confirmation: "credited",
      wallet: null,
    };
    await page.route(`**/api/topups/online/${intentId}/reconcile`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(confirmed) }));

    await expect(page.getByTestId("topup-credited")).toContainText("Crédito lançado", { timeout: 20000 });
    await expect(page.getByTestId("topup-credited")).toContainText("R$ 50,00");
    await expect(panel).toHaveAttribute("data-status", "confirmed");
    await expect(page.getByTestId("topup-not-credited")).toHaveCount(0);
    await expect(page.getByTestId("topup-wallet-balance")).toContainText("R$ 50,00");
    await expect(page.getByTestId("topup-wallet")).toHaveAttribute("data-version", String(funded.version));
    // Acompanhamento encerrado: histórico mostra o rótulo do servidor.
    await expect(page.getByTestId("topup-history").locator(`[data-intent="${intentId}"]`)).toHaveCount(1);
  });
});

test.describe("carteira bloqueada por pendência de reembolso/chargeback (A31)", () => {
  test("aviso na carteira e transferência de saída recusada pelo servidor, sem alterar saldos; liberar reabre a transferência", async ({ page, request }) => {
    const f = await family([guardian], 5000, 0);
    await writeDemoDoc(target(), `wallets/${f.ana.id}`, { pendingReversalCents: 3800 }, ["pendingReversalCents"]);
    await openWallet(page, guardian, f);
    await expect(page.getByTestId("wallet-student").filter({ has: page.locator(`[data-testid="wallet-blocked"]`) })).toHaveCount(1);
    await expect(page.locator(`[data-student="${f.ana.id}"]`).getByTestId("wallet-blocked")).toContainText("R$ 38,00");
    await expect(page.locator(`[data-student="${f.bia.id}"]`).getByTestId("wallet-blocked")).toHaveCount(0);

    await fillTransfer(page, f, "10,00");
    await page.getByRole("button", { name: "Transferir" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "refused");
    await expect(status(page)).toContainText("bloqueada para novas compras");
    const w = (await (await request.get(`/api/wallets?studentId=${f.ana.id}`, { headers: { authorization: `Bearer ${guardian.idToken}` } })).json()) as { balanceCents: number; version: number; pendingReversalCents: number };
    expect(w).toMatchObject({ balanceCents: 5000, version: 1, pendingReversalCents: 3800 });

    await writeDemoDoc(target(), `wallets/${f.ana.id}`, { pendingReversalCents: 0 }, ["pendingReversalCents"]);
    await page.getByRole("button", { name: "Transferir" }).click();
    await expect(status(page)).toHaveAttribute("data-phase", "confirmed", { timeout: 15000 });
  });
});

test.describe("revisão administrativa dos pagamentos online (A31)", () => {
  test("a administração vê a pendência e a divergência, absorve o valor com motivo e a carteira é liberada; outros perfis não têm acesso", async ({ page, request }) => {
    const id = `stu_pr_${tag}_${++counter}`;
    const pendencyId = hexId();
    const reviewId = hexId();
    await seedStudentAccess({ studentId: id, name: `Aluno Revisão ${tag}`, guardianUids: [guardian.uid] });
    await writeDemoDoc(target(), `wallets/${id}`, { studentId: id, currency: "BRL", balanceCents: 0, version: 2, pendingReversalCents: 3800 });
    await writeDemoDoc(target(), `paymentPendencies/${pendencyId}`, {
      pendencyId, intentId: pendencyId, studentId: id, studentName: `Aluno Revisão ${tag}`, cause: "chargeback", status: "open",
      openedCents: 3800, outstandingCents: 3800, recoveredCents: 0, writtenOffCents: 0, resolution: null, version: 1, createdAt: new Date(), updatedAt: new Date(),
    });
    await writeDemoDoc(target(), `topupIntents/${reviewId}`, {
      intentId: reviewId, channel: "pix", status: "in_review", studentId: id, studentName: `Aluno Revisão ${tag}`, amountCents: 5000, currency: "BRL",
      provider: { id: "mercadopago", mode: "live" }, charge: { id: "ORDREV", providerStatus: "processed/accredited" }, review: { reason: "amount_mismatch", at: new Date() },
      version: 2, createdAt: new Date(), updatedAt: new Date(),
    });

    // Secretaria não vê a revisão (nem pela API).
    const denied = await request.get("/api/admin/payments", { headers: { authorization: `Bearer ${secretaria.idToken}` } });
    expect(denied.status()).toBe(403);

    await login(page, "/operacao/pagamentos", admin.email);
    const pendency = page.locator(`[data-pendency="${pendencyId}"]`);
    await expect(pendency).toContainText("Contestação (chargeback)", { timeout: 30000 });
    await expect(pendency).toContainText("R$ 38,00");
    await expect(pendency).toContainText("bloqueada para novas compras");
    const review = page.locator(`[data-review="${reviewId}"]`);
    await expect(review).toContainText("Valor pago diferente do valor da recarga");
    await expect(review).toContainText("nenhum crédito foi lançado");

    // Sem saldo, "descontar do saldo" fica desabilitado; absorver exige motivo.
    await expect(pendency.getByRole("button", { name: "Descontar do saldo atual" })).toBeDisabled();
    await pendency.getByRole("button", { name: "Absorver o valor" }).click();
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByTestId("payments-message")).toContainText("Informe o motivo");
    await page.getByLabel("Motivo").fill("Perda assumida pela escola, autorizada");
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByTestId("payments-message")).toContainText("Valor absorvido pela escola: R$ 38,00", { timeout: 20000 });
    await expect(page.locator(`[data-pendency="${pendencyId}"]`)).toHaveCount(0);

    const after = await readDemoDoc(target(), `wallets/${id}`);
    expect(Number(after?.pendingReversalCents ?? 0)).toBe(0);
    expect(Number(after?.balanceCents)).toBe(0);
    expect(Number(after?.version)).toBe(2); // absorver não cria lançamento no livro
    const stored = await readDemoDoc(target(), `paymentPendencies/${pendencyId}`);
    expect(String(stored?.status)).toBe("resolved");
  });
});
