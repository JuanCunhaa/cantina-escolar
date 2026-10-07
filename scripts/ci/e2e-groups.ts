// Partição da suíte e2e obrigatória em grupos (scripts/ci/e2e-groups.json).
//   verify          confere que os grupos cobrem exatamente os specs da suíte, sem repetição (sem dependências instaladas)
//   verify --list   também lista os TESTES com o Playwright (sem navegador) e confere união exata e disjunção por teste;
//                   grava ci-results/e2e-expected.json e as contagens em $GITHUB_OUTPUT (expected_total, expected_g1, ...)
//   run <grupo>     executa o grupo como no CI: emuladores Auth/Firestore próprios + Playwright (E2E_SERVER_MODE respeitado)
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export type GroupsFile = { groups: Record<string, string[]>; diagnostic?: { group: string; files: string[] } };

export const loadGroups = (path = "scripts/ci/e2e-groups.json"): GroupsFile => JSON.parse(readFileSync(path, "utf8")) as GroupsFile;

/** Specs obrigatórios: os mesmos de playwright.config.ts (tests/e2e/**\/*.spec.ts, exceto *.propagation.spec.ts). */
export function requiredSpecs(dir = "tests/e2e"): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => relative(dir, join(dir, f)).replace(/\\/g, "/"))
    .filter((f) => /\.spec\.ts$/.test(f) && !/\.propagation\.spec\.ts$/.test(f))
    .sort((a, b) => a.localeCompare(b));
}

export function verifyPartition(groups: GroupsFile, specs: string[]): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const [name, files] of Object.entries(groups.groups)) {
    if (!files.length) errors.push(`grupo ${name} vazio`);
    for (const f of files) {
      const other = seen.get(f);
      if (other) errors.push(`${f} está em ${other} e em ${name}`);
      seen.set(f, name);
      if (!specs.includes(f)) errors.push(`${f} (grupo ${name}) não existe na suíte obrigatória`);
    }
  }
  for (const f of specs) if (!seen.has(f)) errors.push(`${f} não pertence a nenhum grupo: todo spec obrigatório precisa de grupo`);
  return errors;
}

type ListedSuite = { title?: string; file?: string; specs?: { title: string; file: string; line: number; tests?: unknown[] }[]; suites?: ListedSuite[] };

/** IDs dos testes listados pelo Playwright (arquivo:linha › título) para a suíte inteira ou um grupo. */
export function listTests(group?: string): string[] {
  const env = { ...process.env, CI: "", E2E_GROUP: group ?? "" };
  if (!group) delete (env as Record<string, string | undefined>).E2E_GROUP;
  const out = execFileSync(process.execPath, [join("node_modules", "@playwright", "test", "cli.js"), "test", "--list", "--reporter=json"], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(out) as { suites: ListedSuite[] };
  const ids: string[] = [];
  const walk = (suite: ListedSuite, path: string[]) => {
    for (const spec of suite.specs ?? []) for (let i = 0; i < Math.max(1, spec.tests?.length ?? 1); i++) ids.push(`${spec.file}:${spec.line} › ${[...path, spec.title].join(" › ")}#${i}`);
    for (const child of suite.suites ?? []) walk(child, child.title && !child.file?.endsWith(child.title) ? [...path, child.title] : path);
  };
  for (const s of report.suites) walk(s, []);
  return ids.sort((a, b) => a.localeCompare(b));
}

export function verifyTestUnion(all: string[], perGroup: Record<string, string[]>): string[] {
  const errors: string[] = [];
  const owner = new Map<string, string>();
  for (const [g, ids] of Object.entries(perGroup)) {
    for (const id of ids) {
      if (owner.has(id)) errors.push(`teste em dois grupos: ${id}`);
      owner.set(id, g);
    }
  }
  for (const id of all) if (!owner.has(id)) errors.push(`teste da suíte fora dos grupos: ${id}`);
  for (const id of owner.keys()) if (!all.includes(id)) errors.push(`teste de grupo fora da suíte: ${id}`);
  return errors;
}

/** Comando do grupo como no CI: emuladores Auth/Firestore próprios + Playwright (o grupo vai por E2E_GROUP). */
export function groupCommand(): string[] {
  const playwright = `node ${join("node_modules", "@playwright", "test", "cli.js")} test`;
  return [join("node_modules", "firebase-tools", "lib", "bin", "firebase.js"), "emulators:exec", "--only", "auth,firestore", "--project", "demo-cantina", playwright];
}

type Deps = {
  root?: string;
  list?: (group?: string) => string[];
  run?: (args: string[], env: Record<string, string | undefined>) => number;
  log?: (text: string) => void;
};

/** CLI testável: devolve o código de saída. */
export function main(argv: string[], env: Record<string, string | undefined>, deps: Deps = {}): number {
  const [command, arg] = argv;
  const root = deps.root ?? ".";
  const log = deps.log ?? console.log;
  const groups = loadGroups(join(root, "scripts/ci/e2e-groups.json"));
  if (command === "verify") {
    const errors = verifyPartition(groups, requiredSpecs(join(root, "tests/e2e")));
    if (argv.includes("--list")) {
      const list = deps.list ?? listTests;
      const all = list();
      const perGroup = Object.fromEntries(Object.keys(groups.groups).map((g) => [g, list(g)]));
      errors.push(...verifyTestUnion(all, perGroup));
      const counts = { expected_total: all.length, ...Object.fromEntries(Object.entries(perGroup).map(([g, ids]) => [`expected_${g}`, ids.length])) };
      mkdirSync(join(root, "ci-results"), { recursive: true });
      writeFileSync(join(root, "ci-results/e2e-expected.json"), `${JSON.stringify({ ...counts, tests: perGroup }, null, 2)}\n`);
      log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));
      if (env.GITHUB_OUTPUT && !errors.length) appendFileSync(env.GITHUB_OUTPUT, Object.entries(counts).map(([k, v]) => `${k}=${v}\n`).join(""));
    }
    if (errors.length) {
      log(`Partição e2e inválida:\n- ${errors.join("\n- ")}`);
      return 1;
    }
    log(`Partição e2e OK: ${Object.entries(groups.groups).map(([g, f]) => `${g}=${f.length} arquivos`).join(", ")}`);
    return 0;
  }
  if (command === "run" && arg && groups.groups[arg]) {
    const run = deps.run ?? ((args, childEnv) => spawnSync(process.execPath, args, { stdio: "inherit", env: childEnv as NodeJS.ProcessEnv }).status ?? 1);
    return run(groupCommand(), { ...env, E2E_GROUP: arg });
  }
  log("Uso: node scripts/ci/e2e-groups.ts verify [--list] | run <grupo>");
  return 2;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
