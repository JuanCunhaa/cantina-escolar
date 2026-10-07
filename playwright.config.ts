import { readFileSync, rmSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { e2eServerEnv } from "./tests/helpers/e2e-env.ts";

const groups = JSON.parse(readFileSync("scripts/ci/e2e-groups.json", "utf8")) as { groups: Record<string, string[]> };

// Arquivos do e2e: diretório próprio e limpo a cada execução, herdado também pelos workers (seed dos specs).
const storageDir = ".local-storage/e2e";
process.env.STORAGE_LOCAL_DIR = storageDir;
// O config também é carregado em cada worker: limpar só no processo principal.
if (process.env.TEST_WORKER_INDEX === undefined) rmSync(storageDir, { recursive: true, force: true });

// CI: grupo da partição (scripts/ci/e2e-groups.json) e modo do servidor. Sem E2E_GROUP roda a suíte inteira, como antes.
const group = process.env.E2E_GROUP;
const groupFiles = group ? groups.groups[group] : undefined;
if (group && !groupFiles) throw new Error(`E2E_GROUP desconhecido: ${group}`);
// dev (padrão): next dev --webpack. start: app JÁ compilado (.next do build compartilhado do CI), sem recompilar.
const serverMode = process.env.E2E_SERVER_MODE ?? "dev";
if (serverMode !== "dev" && serverMode !== "start") throw new Error(`E2E_SERVER_MODE inválido: ${serverMode}`);
const report = process.env.E2E_REPORT ?? group ?? "all";

export default defineConfig({
  testDir: "tests/e2e",
  // A propagação entre sessões (listener) roda à parte: playwright.propagation.config.ts.
  testIgnore: "**/*.propagation.spec.ts",
  ...(groupFiles ? { testMatch: groupFiles } : {}),
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  globalTeardown: "./tests/helpers/ci-resource-teardown.ts",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
    // CI: resultado estruturado para o resumo de falhas e o gate (contagem executada = listada, sem skips).
    ...(process.env.CI ? [["json", { outputFile: `ci-results/playwright-${report}.json` }] as ["json", { outputFile: string }]] : []),
  ],
  // Evidência barata das falhas (captura de tela só quando falha). Traces NÃO ficam ligados por padrão: medidos no CI (2 CPUs) o
  // e2e passou de ~6,5–7 min para ~12 min e houve falhas por tempo; instrumento não pode perturbar o que mede.
  use: { baseURL: "http://127.0.0.1:3100", screenshot: "only-on-failure" },
  webServer: {
    // Wrapper só mede o tempo até o servidor ficar pronto (ci-results/server-ready-*.json); o comando é o mesmo.
    command: `node scripts/ci/timed-server.ts ${serverMode}`,
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120000,
    env: e2eServerEnv(storageDir),
  },
});
