// Fonte única do ambiente HERMÉTICO do e2e (emulador, dados fictícios): usada pelo playwright.config.ts (servidor) e pelo
// build compartilhado do CI (scripts/ci/build-manifest.ts), para que o app compilado e o servidor de teste usem os mesmos
// valores públicos. Nada aqui é credencial: projeto demo-cantina e chave de API fictícia.

/** Variáveis do build (as NEXT_PUBLIC_* são embutidas no bundle na compilação). */
export const E2E_BUILD_ENV = {
  APP_ENV: "emulator",
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
  NEXT_PUBLIC_FIREBASE_API_KEY: "demo-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo-cantina.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-cantina",
  NEXT_PUBLIC_FIREBASE_APP_ID: "demo-app",
  FIREBASE_PROJECT_ID: "demo-cantina",
} as const;

/** Ambiente do servidor durante o e2e (dev ou compilado). */
export function e2eServerEnv(storageDir: string): Record<string, string> {
  return {
    ...E2E_BUILD_ENV,
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    STORAGE_LOCAL_DIR: storageDir,
    // Recarga online (F18): provedor de DEMONSTRAÇÃO, aceito só com APP_ENV=emulator; nunca cobra nem confirma.
    PAYMENTS_PIX_PROVIDER: "demo",
    PAYMENTS_CARD_PROVIDER: "demo",
    R2_ACCOUNT_ID: "",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    R2_BUCKET: "",
    R2_ENDPOINT: "",
    // Hermético: um .env local com credencial real não pode vazar para a prova em emulador.
    FIREBASE_CLIENT_EMAIL: "",
    FIREBASE_PRIVATE_KEY: "",
  };
}
