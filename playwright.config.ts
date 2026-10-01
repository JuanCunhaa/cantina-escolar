import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
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
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "demo-cantina.appspot.com",
      NEXT_PUBLIC_FIREBASE_APP_ID: "demo-app",
      FIREBASE_PROJECT_ID: "demo-cantina",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
      FIREBASE_STORAGE_BUCKET: "demo-cantina.appspot.com",
      // Hermético: um .env local com credencial real não pode vazar para a prova em emulador.
      FIREBASE_CLIENT_EMAIL: "",
      FIREBASE_PRIVATE_KEY: "",
    },
  },
});
