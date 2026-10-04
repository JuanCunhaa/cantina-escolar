import { defineConfig } from "@playwright/test";
import { loadTarget, PUBLISHED_STATE_FILE } from "./scripts/staging/target.ts";

// Suíte de homologação integrada: reaproveita as specs e2e (fluxo real da aplicação) e acrescenta tests/staging/*.
// Alvo escolhido por STAGING_TARGET (definido por `node scripts/staging/run.ts verify [--emulator]`).
// Com STAGING_PUBLISHED_URL o servidor é o deployment da Vercel (cantina-escolar-hml): nenhum servidor local sobe e o
// bypass da proteção vai num cookie do próprio host (gravado pelo global-setup), nunca em requisições a terceiros.
const target = loadTarget();

export default defineConfig({
  testDir: "tests",
  testMatch: ["e2e/*.spec.ts", "staging/*.spec.ts"],
  // Carteira (F08): fixtures de saldo só existem no emulador; a verificação em homologação ainda não foi escrita.
  // Meus pedidos (F12): e2e compra pelo checkout com saldo de fixture (emulador); o equivalente publicado é staging/orders-history-smoke.spec.ts.
  // Políticas (F09): e2e usa fixtures de uso por data (emulador); o equivalente publicado é staging/policies-smoke.spec.ts.
  testIgnore: ["e2e/wallet*.spec.ts", "e2e/policies*.spec.ts", "e2e/checkout*.spec.ts", "e2e/my-orders*.spec.ts"],
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/staging/global-setup.ts",
  globalTeardown: "./tests/staging/global-teardown.ts",
  use: { baseURL: target.baseUrl, ...(target.published ? { storageState: PUBLISHED_STATE_FILE } : {}) },
  ...(target.published
    ? {}
    : {
        webServer: {
          command: "npx next dev --webpack -p 3300",
          url: target.baseUrl,
          reuseExistingServer: false,
          timeout: 180000,
          env: target.serverEnv,
        },
      }),
});
