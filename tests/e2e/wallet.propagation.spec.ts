import { expect, test, type Browser } from "@playwright/test";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { warmRoutes } from "../helpers/dev-server.ts";
import { balance, card, family, fillTransfer, openWallet, status, type Family } from "../helpers/wallet-fixtures";

test.beforeAll(async ({ request }) => {
  await warmRoutes(request, { post: ["/api/wallets/transfer"], get: ["/portal/carteira", "/api/wallets"] });
});

/**
 * PROPAGAÇÃO ENTRE SESSÕES (listener) — registrada À PARTE do comportamento da interface acima. Aqui só se observa se a
 * alteração feita numa sessão chega à outra pelo listener, com o timeout padrão do Playwright (sem folga). No emulador
 * não há o atraso de 24–30 s visto na homologação (docs/status/listener-delay-investigation.md); este teste não
 * representa a homologação.
 */
test.describe("carteira — propagação entre sessões pelo listener", () => {
  async function session(browser: Browser, user: TestUser, f: Family) {
    const page = await (await browser.newContext()).newPage();
    await openWallet(page, user, f);
    return page;
  }

  test("a transferência feita por um responsável chega ao outro responsável sem recarregar", async ({ browser }) => {
    const g1 = await createTestUser("e2e-w-s1", "guardian");
    const g2 = await createTestUser("e2e-w-s2", "guardian");
    const f = await family([g1, g2], 5000, 2000);
    const p1 = await session(browser, g1, f);
    const p2 = await session(browser, g2, f);
    await expect(balance(p2, f.ana.id)).toContainText("R$ 50,00");
    await expect(card(p2, f.ana.id).getByTestId("wallet-reading")).toHaveAttribute("data-sync", "live");

    await fillTransfer(p1, f, "12,50");
    await p1.getByRole("button", { name: "Transferir" }).click();
    await expect(status(p1)).toHaveAttribute("data-phase", "confirmed");
    await expect(balance(p1, f.ana.id)).toContainText("R$ 37,50"); // imediato, pela resposta

    await expect(balance(p2, f.ana.id)).toContainText("R$ 37,50"); // propagação pelo listener, timeout padrão
    await expect(balance(p2, f.bia.id)).toContainText("R$ 32,50");
    await expect(card(p1, f.ana.id).getByTestId("wallet-reading")).toHaveAttribute("data-sync", "live");
  });
});
