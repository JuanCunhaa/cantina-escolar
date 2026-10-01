// Dev server Next hermético para a prova em emuladores. Variáveis do processo têm precedência sobre qualquer
// .env/.env.local, então um .env local com credencial real ou APP_ENV=production não é usado aqui.
// Uso: npm run emulators (outro terminal) → npm run dev:emulator → npm run seed.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const port = process.env.PORT ?? "3000";

const child = spawn(process.execPath, [nextBin, "dev", "--webpack", "-p", port], {
  stdio: "inherit",
  env: {
    ...process.env,
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
    FIREBASE_CLIENT_EMAIL: "",
    FIREBASE_PRIVATE_KEY: "",
  },
});

child.on("exit", (code) => process.exit(code ?? 1));
