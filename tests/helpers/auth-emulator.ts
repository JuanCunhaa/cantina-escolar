import { randomUUID } from "node:crypto";

export type TestUser = { uid: string; email: string; idToken: string };

function authHost(): string {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST ausente: rode via firebase emulators:exec.");
  return host;
}

/** Cria conta fictícia no Auth Emulator (nunca produção) e devolve um ID token real do emulador. */
export async function createTestUser(label: string, role?: string): Promise<TestUser> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const base = `http://${authHost()}/identitytoolkit.googleapis.com/v1`;
  const credentials = JSON.stringify({ email, password: "senha-fake-123", returnSecureToken: true });
  const headers = { "content-type": "application/json" };
  let response = await fetch(`${base}/accounts:signUp?key=fake`, { method: "POST", headers, body: credentials });
  if (!response.ok) throw new Error(`signUp falhou: ${response.status}`);
  let body = (await response.json()) as { localId: string; idToken: string };
  if (role) {
    // Claim provisória de papel (F02): definida pelo "servidor" (token owner do emulador); novo login emite o token com a claim.
    const update = await fetch(`${base}/projects/demo-cantina/accounts:update`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer owner" },
      body: JSON.stringify({ localId: body.localId, customAttributes: JSON.stringify({ role }) }),
    });
    if (!update.ok) throw new Error(`claim falhou: ${update.status}`);
    response = await fetch(`${base}/accounts:signInWithPassword?key=fake`, { method: "POST", headers, body: credentials });
    if (!response.ok) throw new Error(`signIn falhou: ${response.status}`);
    body = (await response.json()) as { localId: string; idToken: string };
  }
  return { uid: body.localId, email, idToken: body.idToken };
}
