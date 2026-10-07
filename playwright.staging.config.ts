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
  // Entrega (F13): e2e usa pedidos reais do checkout com saldo e data movida por fixture (emulador); o equivalente publicado é staging/fulfillment-smoke.spec.ts.
  // Cancelamento (F14): e2e usa pedidos reais do checkout com saldo de fixture (emulador); o equivalente publicado é staging/cancellation-smoke.spec.ts.
  // PDV (F15): e2e vende com saldo de fixture (emulador); o equivalente publicado, sem saldo, é staging/pos-smoke.spec.ts.
  // Reagendamento/troca (F16): e2e usa pedidos reais do checkout com saldo de fixture (emulador); o equivalente publicado, sem pedido nem saldo, é staging/amend-smoke.spec.ts.
  // Recarga manual (F17): e2e cria alunos por escrita direta no emulador; o equivalente na homologação, com recebimentos SIMULADOS
  // pelo fluxo normal e saldo real no livro, é staging/topups-hml.spec.ts.
  // Confirmação de pagamento online (F19): e2e usa fixtures de carteira/pendência por escrita direta no emulador; o equivalente na
  // homologação, com o sandbox real do Mercado Pago, é staging/online-confirmation-sandbox.spec.ts.
  // Recarga online (F18): o e2e usa o provedor de DEMONSTRAÇÃO e escreve no emulador (127.0.0.1:8080), então não roda contra a HML
  // (achado da suíte publicada completa de 07/10/2026: ECONNREFUSED); o equivalente é staging/online-topup-sandbox.spec.ts.
  testIgnore: ["e2e/online-topup*.spec.ts", "e2e/payments-confirmation*.spec.ts", "e2e/wallet*.spec.ts", "e2e/policies*.spec.ts", "e2e/checkout*.spec.ts", "e2e/my-orders*.spec.ts", "e2e/fulfillment*.spec.ts", "e2e/cancellation*.spec.ts", "e2e/pos*.spec.ts", "e2e/amend*.spec.ts", "e2e/topups*.spec.ts"],
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
