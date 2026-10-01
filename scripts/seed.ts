// Seed local: cria duas contas fictícias no Auth Emulator. Recusa qualquer alvo que não seja emulador local.
const host = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const project = process.env.FIREBASE_PROJECT_ID ?? "demo-cantina";

if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || !project.startsWith("demo-")) {
  console.error("seed recusado: só emulador local com projeto demo-*.");
  process.exit(1);
}

const accounts = [
  { email: "familia-a@example.test", password: "senha-fake-a-123" },
  { email: "familia-b@example.test", password: "senha-fake-b-123" },
];

for (const account of accounts) {
  const response = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...account, returnSecureToken: false }),
  });
  console.log(`${account.email}: ${response.ok ? "criada" : `ignorada (${response.status})`}`);
}

export {};
