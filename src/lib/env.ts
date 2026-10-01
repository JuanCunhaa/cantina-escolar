import { z } from "zod";

const emulatorHost = z.string().regex(/^[\w.-]+:\d{2,5}$/);

const publicSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().min(1),
  NEXT_PUBLIC_USE_FIREBASE_EMULATORS: z.enum(["true", "false"]).default("false"),
});

const serverSchema = z.object({
  APP_ENV: z.enum(["emulator", "staging", "production"]),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_STORAGE_BUCKET: z.string().min(1).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: emulatorHost.optional(),
  FIRESTORE_EMULATOR_HOST: emulatorHost.optional(),
  FIREBASE_STORAGE_EMULATOR_HOST: emulatorHost.optional(),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

type Source = Record<string, string | undefined>;

/** Validação fechada do ambiente servidor: produção/homologação nunca aceitam emulador; emulador nunca carrega credencial. */
export function parseServerEnv(source: Source): ServerEnv {
  const env = serverSchema.parse(source);
  const hasEmulatorVar = Boolean(
    env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_STORAGE_EMULATOR_HOST,
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
