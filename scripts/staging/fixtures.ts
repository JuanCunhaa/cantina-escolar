// Fixtures pequenas e DURÁVEIS da homologação: contas fictícias (@hml.example.test) com perfis + catálogo fictício com fotos.
// Senhas aleatórias ficam só no manifesto local ignorado pelo Git (nunca impressas). Idempotente; só opera no alvo confirmado.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { seedCloudCatalog, writeProfile } from "../../tests/helpers/cloud.ts";
import type { DemoProfile } from "../lib/demo-seed.ts";
import { admin } from "./admin.ts";
import { FIXTURE_DOMAIN, type Target } from "./target.ts";

export type FixtureAccount = { uid: string; email: string; password: string; role: DemoProfile["role"] | null };
export type FixtureManifest = { projectId: string; accounts: Record<string, FixtureAccount> };

const ACCOUNTS: { name: string; role: DemoProfile["role"] | null; status?: "active" | "disabled" }[] = [
  { name: "admin", role: "admin" },
  { name: "secretaria", role: "secretaria" },
  { name: "cantina", role: "cantina" },
  { name: "familia-a", role: "guardian" },
  { name: "familia-b", role: "guardian" },
  { name: "aluno", role: "student" },
  { name: "semperfil", role: null },
  { name: "desativada", role: "guardian", status: "disabled" },
];

export function loadManifest(target: Target): FixtureManifest | null {
  if (!existsSync(target.fixturesFile)) return null;
  const manifest = JSON.parse(readFileSync(target.fixturesFile, "utf8")) as FixtureManifest;
  return manifest.projectId === target.projectId ? manifest : null;
}

export async function ensureFixtures(target: Target): Promise<FixtureManifest> {
  const { auth } = admin(target);
  const previous = loadManifest(target);
  const manifest: FixtureManifest = { projectId: target.projectId, accounts: {} };
  for (const spec of ACCOUNTS) {
    const email = `${spec.name}@${FIXTURE_DOMAIN}`;
    const password = previous?.accounts[spec.name]?.password ?? randomBytes(18).toString("base64url");
    const disabled = spec.status === "disabled";
    let uid: string;
    try {
      uid = (await auth.getUserByEmail(email)).uid;
      // Senha só muda quando o manifesto local foi perdido (mantém a conta, troca o segredo).
      await auth.updateUser(uid, { password, disabled, emailVerified: true });
    } catch (error) {
      if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
      uid = (await auth.createUser({ email, password, emailVerified: true, disabled })).uid;
    }
    if (spec.role) await writeProfile(uid, email, { role: spec.role, status: spec.status ?? "active", displayName: `Fixture ${spec.name}` });
    manifest.accounts[spec.name] = { uid, email, password, role: spec.role };
  }
  writeFileSync(target.fixturesFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await seedCloudCatalog();
  return manifest;
}
