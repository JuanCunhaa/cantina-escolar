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
  /** true = servidor já publicado (Vercel) em STAGING_PUBLISHED_URL; nenhum servidor local é iniciado. */
  published: boolean;
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
  for (const key of Object.keys(process.env)) if (/^(R2_|FIREBASE_|NEXT_PUBLIC_|MERCADOPAGO_|PAYMENTS_)/.test(key)) blanks[key] = "";
  return { ...blanks, ...defined };
}

/**
 * Recarga online na homologação (F18): opcional. Sem `PAYMENTS_*_PROVIDER` no arquivo, os canais ficam indisponíveis. Com
 * `mercadopago`, SÓ sandbox: `MERCADOPAGO_ENV=sandbox` obrigatório e as credenciais de TESTE do arquivo local (nunca o `.env`).
 * Valores nunca são impressos; só os nomes faltantes aparecem no erro.
 */
export function stagingPayments(file: Dict): Dict {
  const pix = file.PAYMENTS_PIX_PROVIDER?.trim() ?? "";
  const card = file.PAYMENTS_CARD_PROVIDER?.trim() ?? "";
  for (const [name, value] of [["PAYMENTS_PIX_PROVIDER", pix], ["PAYMENTS_CARD_PROVIDER", card]] as const) {
    if (value !== "" && value !== "none" && value !== "mercadopago") throw new Error(`${name}: na homologação só "mercadopago" (sandbox) ou vazio.`);
  }
  if (pix !== "mercadopago" && card !== "mercadopago") return { PAYMENTS_PIX_PROVIDER: "", PAYMENTS_CARD_PROVIDER: "" };
  if (file.MERCADOPAGO_ENV?.trim() !== "sandbox") throw new Error("MERCADOPAGO_ENV deve ser sandbox na homologação (nenhuma credencial de produção).");
  const required = ["MERCADOPAGO_ACCESS_TOKEN", ...(card === "mercadopago" ? ["MERCADOPAGO_PUBLIC_KEY"] : [])];
  const missing = required.filter((k) => !file[k]?.trim());
  if (missing.length) throw new Error(`Faltam em .env.staging.local: ${missing.join(", ")} (credenciais de TESTE do Mercado Pago).`);
  return {
    PAYMENTS_PIX_PROVIDER: pix,
    PAYMENTS_CARD_PROVIDER: card,
    MERCADOPAGO_ENV: "sandbox",
    MERCADOPAGO_ACCESS_TOKEN: file.MERCADOPAGO_ACCESS_TOKEN!.trim(),
    MERCADOPAGO_PUBLIC_KEY: file.MERCADOPAGO_PUBLIC_KEY?.trim() ?? "",
  };
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
    published: false,
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
  const published = publishedUrl();
  const baseUrl = published ?? `http://127.0.0.1:${STAGING_PORT}`;
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
    ...stagingPayments(file),
  };
  // Mesmas validações fechadas que a aplicação aplica em runtime (falha aqui, antes de subir qualquer coisa).
  parseServerEnv({ ...appEnv, FIREBASE_AUTH_EMULATOR_HOST: undefined, FIRESTORE_EMULATOR_HOST: undefined });
  parsePublicEnv(appEnv);
  const storage = parseStorageConfig({ ...appEnv, STORAGE_LOCAL_DIR: undefined });

  return {
    kind: "staging",
    projectId,
    baseUrl,
    published: published !== null,
    serverEnv: blankUnrelatedKeys(appEnv),
    apiKey: appEnv.NEXT_PUBLIC_FIREBASE_API_KEY,
    storage,
    adminCredential: { clientEmail, privateKey },
    fixturesFile: `.staging-fixtures.${projectId}.local.json`,
  };
}

/** Único projeto Vercel autorizado para a homologação publicada (URLs de produção, branch e deployment dele). */
export const AUTHORIZED_VERCEL_PROJECT = "cantina-escolar-hml";
/** Segredo do "Protection Bypass for Automation" do projeto: variável ou arquivo local ignorado pelo Git. */
export const BYPASS_SECRET_FILE = ".secrets/vercel-hml-bypass.txt";
/** Cookie de bypass da Vercel (escopo do host do deployment), gerado pelo global-setup; ignorado pelo Git. */
export const PUBLISHED_STATE_FILE = ".secrets/vercel-hml-bypass-state.json";

/**
 * Homologação publicada: STAGING_PUBLISHED_URL precisa ser https em *.vercel.app do projeto cantina-escolar-hml
 * (nunca domínio da escola nem outro projeto). Ausente = servidor local de homologação.
 */
export function publishedUrl(): string | null {
  const raw = process.env.STAGING_PUBLISHED_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || !url.hostname.endsWith(".vercel.app") || !url.hostname.startsWith(`${AUTHORIZED_VERCEL_PROJECT}`)) {
    throw new Error(`STAGING_PUBLISHED_URL deve ser https://${AUTHORIZED_VERCEL_PROJECT}….vercel.app (projeto de homologação).`);
  }
  return url.origin;
}

export function bypassSecret(): string {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || (existsSync(BYPASS_SECRET_FILE) ? readFileSync(BYPASS_SECRET_FILE, "utf8").trim() : "");
  if (!secret) throw new Error(`Falta o segredo de bypass da Vercel (VERCEL_AUTOMATION_BYPASS_SECRET ou ${BYPASS_SECRET_FILE}).`);
  return secret;
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
  lines.push(`servidor de teste: ${target.baseUrl}${target.published ? " (publicado, Vercel)" : ""}`);
  return lines;
}
