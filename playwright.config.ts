import { rmSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Arquivos do e2e: diretório próprio e limpo a cada execução, herdado também pelos workers (seed dos specs).
const storageDir = ".local-storage/e2e";
process.env.STORAGE_LOCAL_DIR = storageDir;
// O config também é carregado em cada worker: limpar só no processo principal.
if (process.env.TEST_WORKER_INDEX === undefined) rmSync(storageDir, { recursive: true, force: true });

export default defineConfig({
  testDir: "tests/e2e",
  // A propagação entre sessões (listener) roda à parte: playwright.propagation.config.ts.
  testIgnore: "**/*.propagation.spec.ts",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3100" },
  webServer: {
    command: "npx next dev --webpack -p 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      APP_ENV: "emulator",
      NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
      NEXT_PUBLIC_FIREBASE_API_KEY: "demo-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo-cantina.firebaseapp.com",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-cantina",
      NEXT_PUBLIC_FIREBASE_APP_ID: "demo-app",
      FIREBASE_PROJECT_ID: "demo-cantina",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      STORAGE_LOCAL_DIR: storageDir,
      R2_ACCOUNT_ID: "",
      R2_ACCESS_KEY_ID: "",
      R2_SECRET_ACCESS_KEY: "",
      R2_BUCKET: "",
      R2_ENDPOINT: "",
      // Hermético: um .env local com credencial real não pode vazar para a prova em emulador.
      FIREBASE_CLIENT_EMAIL: "",
      FIREBASE_PRIVATE_KEY: "",
    },
  },
});
