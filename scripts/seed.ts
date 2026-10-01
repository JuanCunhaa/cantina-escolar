// Seed local: contas fictícias no Auth Emulator + catálogo de demonstração (Firestore/Storage Emulator).
// Recusa qualquer alvo que não seja emulador local com projeto demo-*.
import { ensureAccount, seedDemoCatalog, targetFromEnv } from "./lib/demo-seed.ts";

const target = targetFromEnv();

try {
  const accounts = [
    { email: "familia-a@example.test", password: "senha-fake-a-123" },
    { email: "familia-b@example.test", password: "senha-fake-b-123" },
    { email: "cantina@example.test", password: "senha-fake-c-123", role: "cantina" },
  ];
  for (const account of accounts) {
    await ensureAccount(target, account);
    console.log(`${account.email}: pronta${account.role ? ` (papel ${account.role})` : ""}`);
  }
  await seedDemoCatalog(target);
  console.log("catálogo de demonstração (fictício) gravado em demoProducts + Storage.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "seed falhou");
  process.exit(1);
}
