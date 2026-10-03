import { randomUUID } from "node:crypto";
import { createCloudUser, isCloud, signInCloud, TEST_PASSWORD as CLOUD_PASSWORD } from "./cloud.ts";
import { setDemoProfile, targetFromEnv, writeDemoDoc, type DemoProfile } from "../../scripts/lib/demo-seed.ts";

export type TestUser = { uid: string; email: string; idToken: string };

function authHost(): string {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST ausente: rode via firebase emulators:exec.");
  return host;
}

export const TEST_PASSWORD = CLOUD_PASSWORD;

/**
 * Cria conta fictícia no Auth Emulator (nunca produção) e devolve um ID token real do emulador.
 * Com `role`, grava o perfil de acesso em users/{uid} (fonte do papel, escrita só pelo servidor/seed). Sem `role`,
 * a conta fica sem perfil: autenticada, porém sem nenhum acesso.
 */
export async function createTestUser(label: string, role?: DemoProfile["role"], profile: Partial<DemoProfile> = {}): Promise<TestUser> {
  // Homologação real (STAGING_TARGET=staging): conta fictícia pelo Admin SDK e login real; nunca o emulador.
  if (isCloud()) return createCloudUser(label, role, profile);
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const base = `http://${authHost()}/identitytoolkit.googleapis.com/v1`;
  const response = await fetch(`${base}/accounts:signUp?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`signUp falhou: ${response.status}`);
  const body = (await response.json()) as { localId: string; idToken: string };
  if (role) await setDemoProfile(targetFromEnv(), body.localId, email, { role, ...profile });
  return { uid: body.localId, email, idToken: body.idToken };
}

/** Cadastro de aluno, vínculo e política fictícios (formato documentado em docs/firebase/schema.md). */
export async function seedStudentAccess(input: {
  studentId: string;
  name?: string;
  guardianUids?: string[];
  revokedGuardianUids?: string[];
  studentUid?: string;
  studentStatus?: "active" | "inactive";
  allowSitePurchase?: boolean;
  allowCounterPurchase?: boolean;
}): Promise<void> {
  const target = targetFromEnv();
  await writeDemoDoc(target, `students/${input.studentId}`, {
    name: input.name ?? "Aluno Exemplo",
    status: input.studentStatus ?? "active",
    userUid: input.studentUid ?? null,
  });
  await writeDemoDoc(target, `studentPolicies/${input.studentId}`, {
    allowSitePurchase: input.allowSitePurchase ?? false,
    allowCounterPurchase: input.allowCounterPurchase ?? false,
  });
  for (const [uids, status] of [
    [input.guardianUids ?? [], "active"],
    [input.revokedGuardianUids ?? [], "revoked"],
  ] as const) {
    for (const uid of uids) {
      await writeDemoDoc(target, `guardianStudentLinks/${uid}_${input.studentId}`, { guardianUid: uid, studentId: input.studentId, status });
    }
  }
}

export { writeDemoDoc, targetFromEnv };

const authBase = () => `http://${authHost()}/identitytoolkit.googleapis.com/v1`;

/** Novo login (novo ID token) de conta existente do Auth Emulator. */
export async function signInTestUser(email: string, password: string = TEST_PASSWORD): Promise<TestUser> {
  if (isCloud()) return { email, ...(await signInCloud(email, password)) };
  const response = await fetch(`${authBase()}/accounts:signInWithPassword?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`signIn falhou: ${response.status}`);
  const body = (await response.json()) as { localId: string; idToken: string };
  return { uid: body.localId, email, idToken: body.idToken };
}

/** Define claims customizadas pelo "servidor" (token owner do emulador): usadas para provar que claim nenhuma concede acesso. */
export async function setCustomClaims(uid: string, claims: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${authBase()}/projects/demo-cantina/accounts:update`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify(claims) }),
  });
  if (!response.ok) throw new Error(`claim falhou: ${response.status}`);
}

/** Fluxo de recuperação do emulador: pede o código, lê-o no endpoint do emulador e define a nova senha. */
export async function resetPasswordViaEmulator(email: string, newPassword: string): Promise<void> {
  const headers = { "content-type": "application/json" };
  const sent = await fetch(`${authBase()}/accounts:sendOobCode?key=fake`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
  });
  if (!sent.ok) throw new Error(`sendOobCode falhou: ${sent.status}`);
  const codes = await fetch(`http://${authHost()}/emulator/v1/projects/demo-cantina/oobCodes`);
  const { oobCodes } = (await codes.json()) as { oobCodes: { email: string; oobCode: string; requestType: string }[] };
  const code = oobCodes.filter((c) => c.email === email && c.requestType === "PASSWORD_RESET").at(-1);
  if (!code) throw new Error("oobCode não encontrado");
  const reset = await fetch(`${authBase()}/accounts:resetPassword?key=fake`, {
    method: "POST",
    headers,
    body: JSON.stringify({ oobCode: code.oobCode, newPassword }),
  });
  if (!reset.ok) throw new Error(`resetPassword falhou: ${reset.status}`);
}
