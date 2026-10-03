// Preparação e limpeza do experimento de listener no CI (homologação). Rode LOCALMENTE, na raiz, com o login do desenvolvedor no
// `gh` e a conta de serviço da homologação em `.secrets/` (ignorada pelo Git):
//   node tools/listener-repro/ci-setup.ts setup     # ambiente restrito à branch, conta fictícia própria e secrets
//   node tools/listener-repro/ci-setup.ts cleanup   # apaga os secrets, a conta fictícia, o documento de sonda e o ambiente
// Nenhum valor secreto é impresso nem gravado em arquivo. A conta fictícia não tem perfil em `users/` (não acessa nada do app).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const REPO = "JuanCunhaa/cantina-escolar";
const ENV = "diagnostico-listener";
const BRANCH = "diagnostico/listener-ci-hml";
const EMAIL = "listener-diag@hml.example.test";
const PROJECT = "cantina-escolar-hml";
const SECRETS = ["HML_FIREBASE_API_KEY", "HML_FIREBASE_APP_ID", "DIAG_PASSWORD", "HML_SERVICE_ACCOUNT_B64"];

const mode = process.argv[2];
if (mode !== "setup" && mode !== "cleanup") throw new Error("uso: node tools/listener-repro/ci-setup.ts <setup|cleanup>");

const gh = (args: string[], input?: string) => spawnSync("gh", args, { input, encoding: "utf8" });

const env = Object.fromEntries(
  readFileSync(".env.staging.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]),
);
if (env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT) throw new Error("projeto do .env.staging.local não é a homologação");
const saFile = readdirSync(".secrets").find((f) => /hml.*adminsdk.*\.json$/.test(f));
if (!saFile) throw new Error("conta de serviço da homologação não encontrada em .secrets/");
const saText = readFileSync(`.secrets/${saFile}`, "utf8");
if ((JSON.parse(saText) as { project_id?: string }).project_id !== PROJECT) throw new Error("conta de serviço de outro projeto");
const app = initializeApp({ credential: cert(JSON.parse(saText) as never), projectId: PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);

if (mode === "setup") {
  // Ambiente restrito: só a branch do diagnóstico recebe os secrets.
  gh(["api", "-X", "PUT", `repos/${REPO}/environments/${ENV}`, "-F", "deployment_branch_policy[protected_branches]=false", "-F", "deployment_branch_policy[custom_branch_policies]=true"]);
  gh(["api", "-X", "POST", `repos/${REPO}/environments/${ENV}/deployment-branch-policies`, "-f", `name=${BRANCH}`, "-f", "type=branch"]);
  const password = randomBytes(24).toString("base64url");
  let uid: string;
  try {
    uid = (await auth.getUserByEmail(EMAIL)).uid;
    await auth.updateUser(uid, { password, disabled: false });
    console.log("conta do diagnóstico já existia: senha renovada");
  } catch (error) {
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    uid = (await auth.createUser({ email: EMAIL, password, emailVerified: false, displayName: "Diagnóstico de listener (fictícia)" })).uid;
    console.log("conta do diagnóstico criada");
  }
  if ((await db.doc(`users/${uid}`).get()).exists) throw new Error("a conta do diagnóstico não deve ter perfil em users/");
  const values: Record<string, string> = {
    HML_FIREBASE_API_KEY: env.NEXT_PUBLIC_FIREBASE_API_KEY!,
    HML_FIREBASE_APP_ID: env.NEXT_PUBLIC_FIREBASE_APP_ID!,
    DIAG_PASSWORD: password,
    HML_SERVICE_ACCOUNT_B64: Buffer.from(saText, "utf8").toString("base64"),
  };
  for (const name of SECRETS) {
    const ok = gh(["secret", "set", name, "--env", ENV, "--repo", REPO], values[name]).status === 0;
    console.log(`secret ${name}: ${ok ? "gravado" : "FALHOU"}`);
    if (!ok) throw new Error("gh secret set falhou");
  }
} else {
  for (const name of SECRETS) console.log(`secret ${name}: ${gh(["secret", "delete", name, "--env", ENV, "--repo", REPO]).status === 0 ? "apagado" : "já ausente/falhou"}`);
  try {
    const uid = (await auth.getUserByEmail(EMAIL)).uid;
    await db.doc(`foundationProbes/${uid}`).delete();
    await auth.deleteUser(uid);
    console.log("conta do diagnóstico e documento de sonda apagados");
  } catch (error) {
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    console.log("conta do diagnóstico já ausente");
  }
  console.log(`ambiente ${ENV}: ${gh(["api", "-X", "DELETE", `repos/${REPO}/environments/${ENV}`]).status === 0 ? "apagado" : "falhou/ausente"}`);
}
process.exit(0);
