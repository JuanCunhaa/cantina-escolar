// Configuração explícita do armazenamento por ambiente. Sem imports `@/` (carregado também direto pelo Node).
// - emulator: disco local (double); qualquer configuração R2 é recusada para não misturar com a prova hermética.
// - staging/production: Cloudflare R2, credenciais só no servidor, bucket privado exclusivo do ambiente.
import { z } from "zod";

export type StorageConfig =
  | { driver: "local"; dir: string }
  | { driver: "r2"; accountId: string; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

const blankToUndefined = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

const schema = z.object({
  APP_ENV: z.enum(["emulator", "staging", "production"]),
  STORAGE_LOCAL_DIR: optional(z.string().min(1)),
  R2_ACCOUNT_ID: optional(z.string().regex(/^[0-9a-f]{32}$/, "R2_ACCOUNT_ID deve ter 32 caracteres hexadecimais.")),
  R2_ACCESS_KEY_ID: optional(z.string().min(8)),
  R2_SECRET_ACCESS_KEY: optional(z.string().min(16)),
  R2_BUCKET: optional(z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "R2_BUCKET inválido (3–63, minúsculas, números e hífen).")),
  /** Opcional: endpoint com jurisdição (ex.: https://<id>.eu.r2.cloudflarestorage.com). Padrão: https://<id>.r2.cloudflarestorage.com. */
  R2_ENDPOINT: optional(z.string().url()),
});

export const DEFAULT_LOCAL_STORAGE_DIR = ".local-storage";

const STAGING_BUCKET_HINT = /(staging|homolog|test)/;

export function parseStorageConfig(source: Record<string, string | undefined>): StorageConfig {
  const env = schema.parse(source);
  const r2Vars = [env.R2_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, env.R2_BUCKET, env.R2_ENDPOINT];

  if (env.APP_ENV === "emulator") {
    if (r2Vars.some(Boolean)) throw new Error("APP_ENV=emulator não pode carregar configuração R2.");
    return { driver: "local", dir: env.STORAGE_LOCAL_DIR ?? DEFAULT_LOCAL_STORAGE_DIR };
  }

  if (env.STORAGE_LOCAL_DIR) throw new Error(`APP_ENV=${env.APP_ENV} não pode usar armazenamento local.`);
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) {
    throw new Error(`APP_ENV=${env.APP_ENV} exige R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY e R2_BUCKET.`);
  }
  // Bucket exclusivo por ambiente: homologação precisa parecer homologação e produção não pode parecer.
  const looksStaging = STAGING_BUCKET_HINT.test(env.R2_BUCKET);
  if (env.APP_ENV === "staging" && !looksStaging) throw new Error("R2_BUCKET de staging deve conter staging, homolog ou test.");
  if (env.APP_ENV === "production" && looksStaging) throw new Error("R2_BUCKET de production não pode ser um bucket de staging/teste.");

  const endpoint = env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const host = new URL(endpoint);
  if (host.protocol !== "https:" || !host.hostname.endsWith(".r2.cloudflarestorage.com") || host.pathname !== "/") {
    throw new Error("R2_ENDPOINT deve ser https://<conta>[.<jurisdição>].r2.cloudflarestorage.com.");
  }
  return {
    driver: "r2",
    accountId: env.R2_ACCOUNT_ID,
    endpoint: host.origin,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}
