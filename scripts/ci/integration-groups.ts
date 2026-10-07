// Partição da suíte de integração em grupos (scripts/ci/integration-groups.json); cada grupo roda num job com emulador próprio.
//   verify          confere que os grupos cobrem exatamente os arquivos da suíte, sem repetição (sem dependências instaladas)
//   verify --list   também lista os TESTES com o Vitest (sem emulador, sem executar) e confere união exata e disjunção por
//                   teste; grava as contagens e o grupo do Rules em $GITHUB_OUTPUT (expected_total, expected_g1, ..., rules_group)
// O grupo chega ao Vitest por INTEGRATION_GROUP (vitest.integration.config.ts); sem a variável roda a suíte inteira.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { verifyPartition, verifyTestUnion } from "./e2e-groups.ts";

export type IntegrationGroups = { groups: Record<string, string[]>; rules: string };

export const loadIntegrationGroups = (path = "scripts/ci/integration-groups.json"): IntegrationGroups => JSON.parse(readFileSync(path, "utf8")) as IntegrationGroups;

/** Arquivos obrigatórios: os mesmos do include de vitest.integration.config.ts (tests/integration/**\/*.test.ts). */
export function requiredFiles(dir = "tests/integration"): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => relative(dir, join(dir, f)).replace(/\\/g, "/"))
    .filter((f) => /\.test\.ts$/.test(f))
    .sort((a, b) => a.localeCompare(b));
}

/** IDs dos testes listados pelo Vitest (arquivo:linha › nome#ocorrência) para a suíte inteira ou um grupo. */
export function listTests(group?: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "integration-list-"));
  const out = join(dir, "list.json");
  try {
    const env = { ...process.env, INTEGRATION_GROUP: group ?? "" };
    execFileSync(process.execPath, [join("node_modules", "vitest", "vitest.mjs"), "list", "--config", "vitest.integration.config.ts", `--json=${out}`], { env, stdio: "ignore" });
    const items = JSON.parse(readFileSync(out, "utf8")) as { name: string; file: string; location?: { line: number } }[];
    const seen = new Map<string, number>();
    return items
      .map((t) => {
        const base = `${relative(process.cwd(), t.file).replace(/\\/g, "/")}:${t.location?.line ?? 0} › ${t.name}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return `${base}#${n}`;
      })
      .sort((a, b) => a.localeCompare(b));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Deps = { root?: string; list?: (group?: string) => string[]; log?: (text: string) => void };

/** CLI testável: devolve o código de saída. */
export function main(argv: string[], env: Record<string, string | undefined>, deps: Deps = {}): number {
  const root = deps.root ?? ".";
  const log = deps.log ?? console.log;
  if (argv[0] !== "verify") {
    log("Uso: node scripts/ci/integration-groups.ts verify [--list]");
    return 2;
  }
  const config = loadIntegrationGroups(join(root, "scripts/ci/integration-groups.json"));
  const errors = verifyPartition({ groups: config.groups }, requiredFiles(join(root, "tests/integration")));
  if (!config.groups[config.rules]) errors.push(`grupo do Rules desconhecido: ${config.rules}`);
  if (argv.includes("--list")) {
    const list = deps.list ?? listTests;
    const all = list();
    const perGroup = Object.fromEntries(Object.keys(config.groups).map((g) => [g, list(g)]));
    errors.push(...verifyTestUnion(all, perGroup));
    const outputs = { expected_total: all.length, ...Object.fromEntries(Object.entries(perGroup).map(([g, ids]) => [`expected_${g}`, ids.length])), rules_group: config.rules };
    log(Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join(" "));
    if (env.GITHUB_OUTPUT && !errors.length) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
  }
  if (errors.length) {
    log(`Partição da integração inválida:\n- ${errors.join("\n- ")}`);
    return 1;
  }
  log(`Partição da integração OK: ${Object.entries(config.groups).map(([g, f]) => `${g}=${f.length} arquivos`).join(", ")}; Rules em ${config.rules}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
