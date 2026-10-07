// Mescla relatórios LCOV de suítes que executam código da aplicação EM PROCESSO (unit e integração) num único arquivo
// para o SonarQube Cloud. Uma linha/ramo/função por chave, contagens somadas: não duplica linhas nem perde caminhos.
// Só entram arquivos presentes nos relatórios (instrumentados pelo Vitest); nenhum registro é inventado.
// Rules NÃO entra: os testes de Rules exercitam firestore.rules no emulador (Java), sem importar código de src/.
// Uso: node scripts/ci/lcov-merge.ts --out coverage/merged/lcov.info unit=coverage/unit/lcov.info integration=coverage/integration/lcov.info
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type FileCov = { lines: Map<number, number>; functions: Map<string, { line: number; hits: number }>; branches: Map<string, number | null> };
export type Coverage = Map<string, FileCov>;

export function normalizePath(path: string, cwd = process.cwd()): string {
  const p = path.replace(/\\/g, "/");
  const root = `${cwd.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  return p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length) : p;
}

export function parseLcov(text: string, cwd = process.cwd()): Coverage {
  const result: Coverage = new Map();
  let current: FileCov | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const file = normalizePath(line.slice(3), cwd);
      current = result.get(file) ?? { lines: new Map(), functions: new Map(), branches: new Map() };
      result.set(file, current);
    } else if (line === "end_of_record") current = null;
    else if (!current) continue;
    else if (line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",");
      current.lines.set(Number(ln), (current.lines.get(Number(ln)) ?? 0) + Number(hits));
    } else if (line.startsWith("FN:")) {
      const [ln, ...name] = line.slice(3).split(",");
      const key = name.join(",");
      if (!current.functions.has(key)) current.functions.set(key, { line: Number(ln), hits: 0 });
    } else if (line.startsWith("FNDA:")) {
      const [hits, ...name] = line.slice(5).split(",");
      const key = name.join(",");
      const fn = current.functions.get(key) ?? { line: 0, hits: 0 };
      fn.hits += Number(hits);
      current.functions.set(key, fn);
    } else if (line.startsWith("BRDA:")) {
      const [ln, block, branch, taken] = line.slice(5).split(",");
      const key = `${ln},${block},${branch}`;
      const prev = current.branches.get(key);
      const value = taken === "-" ? null : Number(taken);
      current.branches.set(key, prev === undefined ? value : value === null ? prev : (prev ?? 0) + value);
    }
  }
  return result;
}

export function mergeCoverage(reports: Coverage[]): Coverage {
  const merged: Coverage = new Map();
  for (const report of reports) {
    for (const [file, cov] of report) {
      const target = merged.get(file) ?? { lines: new Map(), functions: new Map(), branches: new Map() };
      for (const [ln, hits] of cov.lines) target.lines.set(ln, (target.lines.get(ln) ?? 0) + hits);
      for (const [name, fn] of cov.functions) {
        const prev = target.functions.get(name);
        target.functions.set(name, { line: prev?.line || fn.line, hits: (prev?.hits ?? 0) + fn.hits });
      }
      for (const [key, taken] of cov.branches) {
        const prev = target.branches.get(key);
        target.branches.set(key, prev === undefined ? taken : taken === null ? prev : (prev ?? 0) + taken);
      }
      merged.set(file, target);
    }
  }
  return merged;
}

export function serializeLcov(cov: Coverage): string {
  const out: string[] = [];
  for (const file of [...cov.keys()].sort((a, b) => a.localeCompare(b))) {
    const c = cov.get(file)!;
    out.push(`SF:${file}`);
    const fns = [...c.functions.entries()].sort((a, b) => a[1].line - b[1].line || a[0].localeCompare(b[0]));
    for (const [name, fn] of fns) out.push(`FN:${fn.line},${name}`);
    for (const [name, fn] of fns) out.push(`FNDA:${fn.hits},${name}`);
    out.push(`FNF:${fns.length}`, `FNH:${fns.filter(([, f]) => f.hits > 0).length}`);
    const branches = [...c.branches.entries()].sort((a, b) => {
      const [la, ba, ra] = a[0].split(",").map(Number);
      const [lb, bb, rb] = b[0].split(",").map(Number);
      return (la ?? 0) - (lb ?? 0) || (ba ?? 0) - (bb ?? 0) || (ra ?? 0) - (rb ?? 0);
    });
    for (const [key, taken] of branches) out.push(`BRDA:${key},${taken === null ? "-" : taken}`);
    out.push(`BRF:${branches.length}`, `BRH:${branches.filter(([, t]) => (t ?? 0) > 0).length}`);
    const lines = [...c.lines.entries()].sort((a, b) => a[0] - b[0]);
    for (const [ln, hits] of lines) out.push(`DA:${ln},${hits}`);
    out.push(`LF:${lines.length}`, `LH:${lines.filter(([, h]) => h > 0).length}`, "end_of_record");
  }
  return `${out.join("\n")}\n`;
}

export function stats(cov: Coverage) {
  let lines = 0;
  let hit = 0;
  for (const c of cov.values()) {
    lines += c.lines.size;
    for (const h of c.lines.values()) if (h > 0) hit++;
  }
  return { files: cov.size, lines, lines_hit: hit, line_rate: lines ? Math.round((hit / lines) * 1000) / 10 : 0 };
}

/** CLI testável: devolve o código de saída. */
export function main(argv: string[], env: Record<string, string | undefined>, out: (text: string) => void = (text) => process.stdout.write(text)): number {
  const outIndex = argv.indexOf("--out");
  const target = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const inputs = argv.filter((a, i, all) => a !== "--out" && all[i - 1] !== "--out");
  if (!target || !inputs.length || inputs.some((i) => !/^[\w-]+=.+/.test(i))) {
    console.error("Uso: node scripts/ci/lcov-merge.ts --out <lcov> <suite>=<lcov> [...]");
    return 2;
  }
  const contributions: Record<string, ReturnType<typeof stats>> = {};
  const reports: Coverage[] = [];
  const missing: string[] = [];
  for (const input of inputs) {
    const [suite, path] = [input.slice(0, input.indexOf("=")), input.slice(input.indexOf("=") + 1)];
    if (!existsSync(path)) {
      missing.push(`${suite} (${path})`);
      continue;
    }
    const cov = parseLcov(readFileSync(path, "utf8"));
    if (!cov.size) missing.push(`${suite} (vazio)`);
    contributions[suite] = stats(cov);
    reports.push(cov);
  }
  // Cobertura parcial seria enganosa: relatório esperado ausente ou vazio reprova.
  if (missing.length) {
    console.error(`LCOV ausente/vazio: ${missing.join(", ")}`);
    return 1;
  }
  const merged = mergeCoverage(reports);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serializeLcov(merged));
  const summary = { suites: contributions, merged: stats(merged), excluded: { rules: "não executa código da aplicação (firestore.rules no emulador)", e2e: "servidor Next em outro processo, sem instrumentação" } };
  writeFileSync(`${dirname(target)}/coverage-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const md = `### Cobertura (LCOV mesclado)\n\n| Suíte | Arquivos | Linhas | Cobertas | % |\n|---|---|---|---|---|\n${Object.entries(contributions)
    .map(([s, v]) => `| ${s} | ${v.files} | ${v.lines} | ${v.lines_hit} | ${v.line_rate} |`)
    .join("\n")}\n| **mesclado** | ${summary.merged.files} | ${summary.merged.lines} | ${summary.merged.lines_hit} | ${summary.merged.line_rate} |\n\nNão contribuem: Rules (sem código de src/) e e2e (sem instrumentação do servidor).\n`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  out(md);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
