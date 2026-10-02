// Preflight SOMENTE LEITURA do alvo de homologação: confirma destino e alcance de Auth, Firestore, login por e-mail/senha e R2.
import { createObjectStore } from "../../src/lib/storage/factory.ts";
import { admin, signIn } from "./admin.ts";
import { describeTarget, type Target } from "./target.ts";

export type Check = { name: string; ok: boolean; detail: string };

export async function runPreflight(target: Target): Promise<Check[]> {
  const checks: Check[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "falhou" });
    }
  };
  const { auth, db } = admin(target);
  await check("Auth (Admin): listar 1 usuário", async () => `${(await auth.listUsers(1)).users.length} lido(s)`);
  await check("Firestore (Admin): leitura de settings/school", async () => ((await db.doc("settings/school").get()).exists ? "existe" : "ausente (ok)"));
  await check("Login e-mail/senha habilitado", async () => {
    try {
      await signIn(target, "preflight-inexistente@hml.example.test", "x");
      return "inesperado: login aceito";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/OPERATION_NOT_ALLOWED|API key not valid|CONFIGURATION_NOT_FOUND/.test(message)) throw error;
      return "provedor responde (credencial inexistente recusada)";
    }
  });
  await check(`Armazenamento (${target.storage.driver}): listar prefixo products/`, async () => {
    let n = 0;
    for await (const object of createObjectStore(target.storage).list("products/")) n += object.key ? 1 : 0;
    return `${n} objeto(s)`;
  });
  return checks;
}

export function printPreflight(target: Target, checks: Check[]): boolean {
  for (const line of describeTarget(target)) console.log(line);
  for (const c of checks) console.log(`${c.ok ? "OK   " : "FALHA"} ${c.name}: ${c.detail}`);
  return checks.every((c) => c.ok);
}
