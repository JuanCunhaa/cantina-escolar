// Suporte da suíte e2e quando ela roda pelo harness de homologação (STAGING_TARGET definido): contra serviços REAIS
// (`staging`) ou, no ensaio do próprio harness, contra emuladores (`emulator`). Contas fictícias são criadas pelo Admin
// SDK (nunca por rota pública), entram por signInWithPassword e são removidas no teardown.
import { randomUUID } from "node:crypto";
import { admin, signIn } from "../../scripts/staging/admin.ts";
import type { DemoProfile } from "../../scripts/lib/demo-seed.ts";
import { EPHEMERAL_DOMAIN, FIXTURE_DOMAIN } from "../../scripts/staging/target.ts";

export const isCloud = (): boolean => Boolean(process.env.STAGING_TARGET);

export const TEST_PASSWORD = "senha-fake-123";

export async function writeProfile(uid: string, email: string, profile: DemoProfile): Promise<void> {
  await admin().db.doc(`users/${uid}`).set({
    email,
    displayName: profile.displayName ?? email.split("@")[0] ?? email,
    role: profile.role,
    status: profile.status ?? "active",
    permissions: profile.permissions ?? [],
    accessVersion: 1,
  });
}

export async function createCloudUser(
  label: string,
  role?: DemoProfile["role"],
  profile: Partial<DemoProfile> = {},
): Promise<{ uid: string; email: string; idToken: string }> {
  const { auth, target } = admin();
  const email = `${label}-${randomUUID().slice(0, 8)}@${EPHEMERAL_DOMAIN}`;
  const user = await auth.createUser({ email, password: TEST_PASSWORD, emailVerified: true });
  if (role) await writeProfile(user.uid, email, { role, ...profile });
  const { idToken } = await signIn(target, email, TEST_PASSWORD);
  return { uid: user.uid, email, idToken };
}

export async function signInCloud(email: string, password: string): Promise<{ uid: string; idToken: string }> {
  return signIn(admin().target, email, password);
}

/** Remove as contas efêmeras (qualquer @*.example.test que não seja fixture durável) e seus perfis. */
export async function cleanupCloudAccounts(): Promise<number> {
  const { auth, db } = admin();
  const doomed: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      const email = user.email ?? "";
      if (/@([a-z0-9-]+\.)?example\.test$/.test(email) && !email.endsWith(`@${FIXTURE_DOMAIN}`)) doomed.push(user.uid);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  for (let i = 0; i < doomed.length; i += 100) {
    const chunk = doomed.slice(i, i + 100);
    await auth.deleteUsers(chunk);
    const batch = db.batch();
    for (const uid of chunk) batch.delete(db.doc(`users/${uid}`));
    await batch.commit();
  }
  return doomed.length;
}
