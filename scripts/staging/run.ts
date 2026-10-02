// Ponto único dos comandos de homologação: node scripts/staging/run.ts <preflight|fixtures|deploy|dev|verify|cleanup> [--emulator]
// Sem --emulator o alvo é a homologação REAL (.env.staging.local). Nunca lê o .env do desenvolvedor.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const [command, ...flags] = process.argv.slice(2);
process.env.STAGING_TARGET = flags.includes("--emulator") ? "emulator" : "staging";
// --published: valida o deployment da Vercel (URL de produção do projeto de homologação, ou STAGING_PUBLISHED_URL).
if (flags.includes("--published")) {
  if (flags.includes("--emulator")) throw new Error("--published e --emulator são exclusivos.");
  process.env.STAGING_PUBLISHED_URL ||= "https://cantina-escolar-hml.vercel.app";
}

const { loadTarget, describeTarget, STAGING_PORT } = await import("./target.ts");
const target = loadTarget();
for (const line of describeTarget(target)) console.log(line);

switch (command) {
  case "preflight": {
    const { printPreflight, runPreflight } = await import("./preflight.ts");
    process.exit(printPreflight(target, await runPreflight(target)) ? 0 : 1);
    break;
  }
  case "fixtures": {
    const { ensureFixtures } = await import("./fixtures.ts");
    const manifest = await ensureFixtures(target);
    console.log(`fixtures prontas: ${Object.keys(manifest.accounts).join(", ")} (senhas em ${target.fixturesFile}, não impressas)`);
    break;
  }
  case "deploy": {
    // Regras e índices do Firestore (somente) no projeto confirmado; o CLI usa o login do desenvolvedor.
    if (target.kind !== "staging") throw new Error("deploy só existe para a homologação real.");
    const result = spawnSync("npx", ["firebase-tools", "deploy", "--only", "firestore", "--project", target.projectId, "--non-interactive"], { stdio: "inherit", shell: true });
    process.exit(result.status ?? 1);
    break;
  }
  case "cleanup": {
    const { cleanupCloudAccounts } = await import("../../tests/helpers/cloud.ts");
    console.log(`${await cleanupCloudAccounts()} conta(s) efêmera(s) removida(s)`);
    break;
  }
  case "dev": {
    const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
    const child = spawn(process.execPath, [nextBin, "dev", "--webpack", "-p", String(STAGING_PORT)], { stdio: "inherit", env: { ...process.env, ...target.serverEnv } });
    child.on("exit", (code) => process.exit(code ?? 1));
    break;
  }
  case "verify": {
    const args = ["playwright", "test", "-c", "playwright.staging.config.ts", ...flags.filter((f) => f !== "--emulator" && f !== "--published")];
    const result = spawnSync("npx", args, { stdio: "inherit", shell: true, env: process.env });
    process.exit(result.status ?? 1);
    break;
  }
  default:
    console.error("Uso: node scripts/staging/run.ts <preflight|fixtures|deploy|dev|verify|cleanup> [--emulator]");
    process.exit(2);
}
