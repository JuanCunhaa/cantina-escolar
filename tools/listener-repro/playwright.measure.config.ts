import { defineConfig } from "@playwright/test";
import { loadTarget, PUBLISHED_STATE_FILE } from "../../scripts/staging/target.ts";

// Medição da APLICAÇÃO na investigação do atraso de listener (fora do `staging:verify`). Mesmo alvo/proteção/fixtures do
// harness de homologação. Uso (PowerShell, na raiz):
//   $env:STAGING_TARGET="staging"; $env:STAGING_PUBLISHED_URL="https://cantina-escolar-hml.vercel.app"; $env:MEASURE_RUNS="4"
//   npx playwright test -c tools/listener-repro/playwright.measure.config.ts [-g foto|calendário]
// Sem STAGING_PUBLISHED_URL sobe o app local (next dev, porta 3300) contra a homologação.
const target = loadTarget();

export default defineConfig({
  testDir: ".",
  testMatch: ["app-measure.spec.ts"],
  timeout: 900_000,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "../../tests/staging/global-setup.ts",
  globalTeardown: "../../tests/staging/global-teardown.ts",
  use: { baseURL: target.baseUrl, ...(target.published ? { storageState: PUBLISHED_STATE_FILE } : {}) },
  ...(target.published
    ? {}
    : { webServer: { command: "npx next dev --webpack -p 3300", url: target.baseUrl, reuseExistingServer: false, timeout: 180_000, env: target.serverEnv } }),
});
