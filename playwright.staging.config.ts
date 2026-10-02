import { defineConfig } from "@playwright/test";
import { loadTarget } from "./scripts/staging/target.ts";

// Suíte de homologação integrada: reaproveita as specs e2e (fluxo real da aplicação) e acrescenta tests/staging/*.
// Alvo escolhido por STAGING_TARGET (definido por `node scripts/staging/run.ts verify [--emulator]`).
const target = loadTarget();

export default defineConfig({
  testDir: "tests",
  testMatch: ["e2e/*.spec.ts", "staging/*.spec.ts"],
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/staging/global-setup.ts",
  globalTeardown: "./tests/staging/global-teardown.ts",
  use: { baseURL: target.baseUrl },
  webServer: {
    command: "npx next dev --webpack -p 3300",
    url: target.baseUrl,
    reuseExistingServer: false,
    timeout: 180000,
    env: target.serverEnv,
  },
});
