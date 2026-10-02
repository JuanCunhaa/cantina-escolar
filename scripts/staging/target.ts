// Alvo da homologação integrada: Firebase (Auth + Firestore) de um projeto EXCLUSIVO de homologação + bucket R2 de staging.
// Lê SOMENTE `.env.staging.local` (ou STAGING_ENV_FILE); o `.env` do desenvolvedor nunca é lido nem repassado.
// Dois alvos: "staging" (serviços reais) e "emulator" (ensaio do próprio harness em emuladores locais, demo-*).
// Nada aqui imprime segredo: `describeTarget` mostra apenas destino (projeto, bucket, hash curto da conta R2).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parsePublicEnv, parseServerEnv } from "../../src/lib/env.ts";
import { parseStorageConfig, type StorageConfig } from "../../src/lib/storage/config.ts";

export const STAGING_PORT = 3300;
/** Único bucket autorizado para a homologação (decisão do dono do projeto, 01/10/2026). */
export const AUTHORIZED_BUCKET = "cantina-fotos-staging";
/** Domínios de e-mail fictícios: fixtures duráveis × contas efêmeras criadas pelos testes. */
export const FIXTURE_DOMAIN = "hml.example.test";
export const EPHEMERAL_DOMAIN = "e2e.example.test";

export type Target = {
  kind: "staging" | "emulator";
  projectId: string;
  baseUrl: string;
  /** Variáveis do processo do servidor Next (completas: o que não é do alvo vai em branco, ver `blankUnrelatedKeys`). */
  serverEnv: Record<string, string>;
  /** Chave pública do Web SDK (usada no login por REST dos testes). */
  apiKey: string;
  storage: StorageConfig;
  /** Credencial do Admin SDK; ausente no emulador. */
  adminCredential: { clientEmail: string; privateKey: string } | null;
  fixturesFile: string;
};

type Dict = Record<string, string>;

/** Parser mínimo de .env (KEY=VALUE, aspas simples/duplas opcionais, `#` comentário em linha própria). */
export function parseDotenv(text: string): Dict {
  const out: Dict = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

const LOCAL_ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"];

/**
 * O Next carrega `.env*` do projeto e só respeita variável já definida; variável vazia é descartada pelo próprio Next
 * (replaceProcessEnv). Então todo nome presente nesses arquivos que o alvo não define é enviado em branco: o `.env` local
 * (emulador, credencial antiga, R2_TEST_*) fica inerte no servidor de homologação.
 */
export function blankUnrelatedKeys(defined: Dict, cwd = process.cwd()): Dict {
  const blanks: Dict = { FIREBASE_AUTH_EMULATOR_HOST: "", FIRESTORE_EMULATOR_HOST: "", GOOGLE_APPLICATION_CREDENTIALS: "" };
  for (const file of LOCAL_ENV_FILES) {
    const path = `${cwd}/${file}`;
    if (!existsSync(path)) continue;
    for (const key of Object.keys(parseDotenv(readFileSync(path, "utf8")))) blanks[key] = "";
  }
  for (const key of Object.keys(process.env)) if (key.startsWith("R2_") || key.startsWith("FIREBASE_") || key.startsWith("NEXT_PUBLIC_")) blanks[key] = "";
  return { ...blanks, ...defined };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 10);

function need(file: Dict, key: string): string {
  const value = file[key]?.trim();
  if (!value) throw new Error(`Falta ${key} no arquivo de homologação.`);
  return value;
}

function emulatorTarget(): Target {
  const storageDir = ".local-storage/staging-selftest";
  const serverEnv = blankUnrelatedKeys({
    APP_ENV: "emulator",
    APP_BASE_URL: `http://127.0.0.1:${STAGING_PORT}`,
    NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
    NEXT_PUBLIC_FIREBASE_API_KEY: "demo-key",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo-cantina.firebaseapp.com",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-cantina",
    NEXT_PUBLIC_FIREBASE_APP_ID: "demo-app",
    FIREBASE_PROJECT_ID: "demo-cantina",
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099",
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080",
    STORAGE_LOCAL_DIR: storageDir,
  });
  return {
    kind: "emulator",
    projectId: "demo-cantina",
    baseUrl: `http://127.0.0.1:${STAGING_PORT}`,
    serverEnv,
    apiKey: "demo-key",
    storage: { driver: "local", dir: storageDir },
    adminCredential: null,
    fixturesFile: ".local-storage/staging-selftest-fixtures.json",
  };
}

function stagingTarget(): Target {
  const path = process.env.STAGING_ENV_FILE || ".env.staging.local";
  if (!existsSync(path)) {
    throw new Error(`Arquivo ${path} não encontrado. Copie .env.staging.example, preencha com os valores do projeto de homologação e rode de novo.`);
  }
  const file = parseDotenv(readFileSync(path, "utf8"));

  const projectId = need(file, "FIREBASE_PROJECT_ID");
  if (need(file, "NEXT_PUBLIC_FIREBASE_PROJECT_ID") !== projectId) throw new Error("NEXT_PUBLIC_FIREBASE_PROJECT_ID difere de FIREBASE_PROJECT_ID.");
  if (need(file, "STAGING_CONFIRM_PROJECT") !== projectId) {
    throw new Error("STAGING_CONFIRM_PROJECT deve repetir o FIREBASE_PROJECT_ID: confirmação explícita de que é o projeto de homologação.");
  }

  // Credencial do Admin SDK: JSON da conta de serviço em arquivo local (preferido) ou variáveis.
  let clientEmail = file.FIREBASE_CLIENT_EMAIL?.trim() ?? "";
  let privateKey = file.FIREBASE_PRIVATE_KEY?.trim() ?? "";
  const saFile = file.FIREBASE_SERVICE_ACCOUNT_FILE?.trim();
  if (saFile) {
    if (!existsSync(saFile)) throw new Error("FIREBASE_SERVICE_ACCOUNT_FILE aponta para um arquivo inexistente.");
    const json = JSON.parse(readFileSync(saFile, "utf8")) as { project_id?: string; client_email?: string; private_key?: string };
    if (json.project_id !== projectId) throw new Error("A conta de serviço pertence a outro projeto que não o de homologação.");
    clientEmail = json.client_email ?? "";
    privateKey = json.private_key ?? "";
  }
  if (!clientEmail || !privateKey) throw new Error("Falta credencial do Admin SDK (FIREBASE_SERVICE_ACCOUNT_FILE ou FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY).");
  if (!clientEmail.includes(`@${projectId}.iam.gserviceaccount.com`)) throw new Error("FIREBASE_CLIENT_EMAIL não pertence ao projeto de homologação.");

  const r2 = {
    R2_ACCOUNT_ID: need(file, "R2_ACCOUNT_ID"),
    R2_ACCESS_KEY_ID: need(file, "R2_ACCESS_KEY_ID"),
    R2_SECRET_ACCESS_KEY: need(file, "R2_SECRET_ACCESS_KEY"),
    R2_BUCKET: need(file, "R2_BUCKET"),
  };
  if (r2.R2_BUCKET !== AUTHORIZED_BUCKET) throw new Error(`Só o bucket ${AUTHORIZED_BUCKET} está autorizado para a homologação.`);
  const baseUrl = `http://127.0.0.1:${STAGING_PORT}`;
  const appEnv = {
    APP_ENV: "staging",
    APP_BASE_URL: baseUrl,
    APP_TIME_ZONE: "America/Sao_Paulo",
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_CLIENT_EMAIL: clientEmail,
    FIREBASE_PRIVATE_KEY: privateKey,
    NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "false",
    NEXT_PUBLIC_FIREBASE_API_KEY: need(file, "NEXT_PUBLIC_FIREBASE_API_KEY"),
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: need(file, "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
    NEXT_PUBLIC_FIREBASE_APP_ID: need(file, "NEXT_PUBLIC_FIREBASE_APP_ID"),
    ...r2,
    R2_ENDPOINT: file.R2_ENDPOINT?.trim() ?? "",
  };
  // Mesmas validações fechadas que a aplicação aplica em runtime (falha aqui, antes de subir qualquer coisa).
  parseServerEnv({ ...appEnv, FIREBASE_AUTH_EMULATOR_HOST: undefined, FIRESTORE_EMULATOR_HOST: undefined });
  parsePublicEnv(appEnv);
  const storage = parseStorageConfig({ ...appEnv, STORAGE_LOCAL_DIR: undefined });

  return {
    kind: "staging",
    projectId,
    baseUrl,
    serverEnv: blankUnrelatedKeys(appEnv),
    apiKey: appEnv.NEXT_PUBLIC_FIREBASE_API_KEY,
    storage,
    adminCredential: { clientEmail, privateKey },
    fixturesFile: `.staging-fixtures.${projectId}.local.json`,
  };
}

/** STAGING_TARGET é obrigatório e explícito: `staging` (serviços reais) ou `emulator` (ensaio do harness nos emuladores). */
export function loadTarget(): Target {
  const kind = process.env.STAGING_TARGET;
  if (kind === "emulator") return emulatorTarget();
  if (kind === "staging") return stagingTarget();
  throw new Error("Defina STAGING_TARGET=staging (homologação real) ou STAGING_TARGET=emulator (ensaio local). Use os scripts npm staging:*.");
}

export function describeTarget(target: Target): string[] {
  const lines = [`alvo: ${target.kind}`, `projeto Firebase: ${target.projectId}`];
  if (target.storage.driver === "r2") {
    lines.push(`bucket R2: ${target.storage.bucket} (conta ${sha(target.storage.accountId)}…)`);
  } else {
    lines.push(`armazenamento: disco local ${target.storage.dir} (double do R2, só ensaio)`);
  }
  lines.push(`servidor de teste: ${target.baseUrl}`);
  return lines;
}
