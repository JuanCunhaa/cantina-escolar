import { z } from "zod";

// Variável em branco = ausente (o launcher de homologação neutraliza o `.env` local enviando nomes vazios).
const emulatorHost = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().regex(/^[\w.-]+:\d{2,5}$/).optional(),
);

const publicSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().min(1),
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: z.enum(["true", "false"]).default("false"),
});

const serverSchema = z.object({
  APP_ENV: z.enum(["emulator", "staging", "production"]),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: emulatorHost,
  FIRESTORE_EMULATOR_HOST: emulatorHost,
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

type Source = Record<string, string | undefined>;

/** Validação fechada do ambiente servidor: produção/homologação nunca aceitam emulador; emulador nunca carrega credencial. */
export function parseServerEnv(source: Source): ServerEnv {
  const env = serverSchema.parse(source);
  const hasEmulatorVar = Boolean(
    env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST,
  );
  if (env.APP_ENV === "emulator") {
    if (env.FIREBASE_PRIVATE_KEY || env.FIREBASE_CLIENT_EMAIL) {
      throw new Error("APP_ENV=emulator não pode carregar credencial administrativa.");
    }
    if (!env.FIRESTORE_EMULATOR_HOST || !env.FIREBASE_AUTH_EMULATOR_HOST) {
      throw new Error("APP_ENV=emulator exige FIRESTORE_EMULATOR_HOST e FIREBASE_AUTH_EMULATOR_HOST.");
    }
  } else {
    if (hasEmulatorVar) throw new Error(`APP_ENV=${env.APP_ENV} não pode definir variáveis de emulador.`);
    if (!env.FIREBASE_PRIVATE_KEY || !env.FIREBASE_CLIENT_EMAIL) {
      throw new Error(`APP_ENV=${env.APP_ENV} exige credencial administrativa do servidor.`);
    }
    if (env.FIREBASE_PROJECT_ID.startsWith("demo-")) {
      throw new Error(`APP_ENV=${env.APP_ENV} não pode usar projeto demo-*.`);
    }
    // Projeto de homologação precisa parecer homologação e produção não pode parecer (mesma regra do bucket R2).
    const looksStaging = /(staging|homolog|hml|test)/.test(env.FIREBASE_PROJECT_ID);
    if (env.APP_ENV === "staging" && !looksStaging) {
      throw new Error("FIREBASE_PROJECT_ID de staging deve conter staging, homolog, hml ou test.");
    }
    if (env.APP_ENV === "production" && looksStaging) {
      throw new Error("FIREBASE_PROJECT_ID de production não pode ser um projeto de staging/teste.");
    }
  }
  return env;
}

export function parsePublicEnv(source: Source): PublicEnv {
  const env = publicSchema.parse(source);
  if (env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true" && !env.NEXT_PUBLIC_FIREBASE_PROJECT_ID.startsWith("demo-")) {
    throw new Error("Emuladores do cliente exigem projeto demo-*.");
  }
  return env;
}
