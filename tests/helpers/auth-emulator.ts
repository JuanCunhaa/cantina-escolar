import { randomUUID } from "node:crypto";

export type TestUser = { uid: string; email: string; idToken: string };

function authHost(): string {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST ausente: rode via firebase emulators:exec.");
  return host;
}

/** Cria conta fictícia no Auth Emulator (nunca produção) e devolve um ID token real do emulador. */
export async function createTestUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const response = await fetch(`http://${authHost()}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "senha-fake-123", returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`signUp falhou: ${response.status}`);
  const body = (await response.json()) as { localId: string; idToken: string };
  return { uid: body.localId, email, idToken: body.idToken };
}
