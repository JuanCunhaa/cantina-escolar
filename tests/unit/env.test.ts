import { describe, expect, it } from "vitest";
import { parsePublicEnv, parseServerEnv } from "@/lib/env";

const emulatorEnv = {
  APP_ENV: "emulator",
  FIREBASE_PROJECT_ID: "demo-cantina",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
};
const prodCreds = { FIREBASE_CLIENT_EMAIL: "svc@example.iam", FIREBASE_PRIVATE_KEY: "fake-key" };

describe("parseServerEnv (validação fechada)", () => {
  it("aceita emulador sem credencial", () => {
    expect(parseServerEnv(emulatorEnv).APP_ENV).toBe("emulator");
  });
  it("recusa emulador com credencial administrativa", () => {
    expect(() => parseServerEnv({ ...emulatorEnv, ...prodCreds })).toThrow();
  });
  it("recusa emulador sem hosts", () => {
    expect(() => parseServerEnv({ APP_ENV: "emulator", FIREBASE_PROJECT_ID: "demo-cantina" })).toThrow();
  });
  it("recusa produção/homologação com variável de emulador", () => {
    expect(() => parseServerEnv({ APP_ENV: "production", FIREBASE_PROJECT_ID: "escola", ...prodCreds, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" })).toThrow();
  });
  it("recusa produção sem credencial ou com projeto demo", () => {
    expect(() => parseServerEnv({ APP_ENV: "production", FIREBASE_PROJECT_ID: "escola" })).toThrow();
    expect(() => parseServerEnv({ APP_ENV: "staging", FIREBASE_PROJECT_ID: "demo-x", ...prodCreds })).toThrow();
  });
  it("homologação exige projeto com cara de homologação; produção recusa esse nome", () => {
    expect(parseServerEnv({ APP_ENV: "staging", FIREBASE_PROJECT_ID: "cantina-hml", ...prodCreds }).APP_ENV).toBe("staging");
    expect(() => parseServerEnv({ APP_ENV: "staging", FIREBASE_PROJECT_ID: "cantina-claude", ...prodCreds })).toThrow(/staging/);
    expect(() => parseServerEnv({ APP_ENV: "production", FIREBASE_PROJECT_ID: "cantina-staging", ...prodCreds })).toThrow(/production/);
  });
  it("aceita produção com credencial e sem emulador", () => {
    expect(parseServerEnv({ APP_ENV: "production", FIREBASE_PROJECT_ID: "escola", ...prodCreds }).APP_ENV).toBe("production");
  });
  it("variáveis de emulador em branco valem como ausentes (staging com .env local neutralizado)", () => {
    const env = { APP_ENV: "staging", FIREBASE_PROJECT_ID: "cantina-hml", ...prodCreds, FIREBASE_AUTH_EMULATOR_HOST: "", FIRESTORE_EMULATOR_HOST: "" };
    expect(parseServerEnv(env).APP_ENV).toBe("staging");
    expect(() => parseServerEnv({ ...env, APP_ENV: "emulator", FIREBASE_CLIENT_EMAIL: "", FIREBASE_PRIVATE_KEY: "" })).toThrow();
  });
  it("recusa APP_ENV desconhecido", () => {
    expect(() => parseServerEnv({ ...emulatorEnv, APP_ENV: "dev" })).toThrow();
  });
});

describe("parsePublicEnv", () => {
  const base = {
    NEXT_PUBLIC_FIREBASE_API_KEY: "k",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "d",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "escola",
    NEXT_PUBLIC_FIREBASE_APP_ID: "a",
  };
  it("recusa emulador do cliente em projeto não demo", () => {
    expect(() => parsePublicEnv({ ...base, NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true" })).toThrow();
  });
  it("aceita emulador em projeto demo e padrão false", () => {
    expect(parsePublicEnv({ ...base, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-cantina", NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true" }).NEXT_PUBLIC_USE_FIREBASE_EMULATORS).toBe("true");
    expect(parsePublicEnv(base).NEXT_PUBLIC_USE_FIREBASE_EMULATORS).toBe("false");
  });
});
