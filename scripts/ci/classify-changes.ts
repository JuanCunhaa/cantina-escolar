// Classifica as mudanças entre duas árvores: "docs" (só documentação elegível) ou "full" (fluxo completo).
// Lista EXPLÍCITA e conservadora; qualquer dúvida (SHA ausente, erro do git, diff vazio, caminho fora da lista) => "full".
// Uso no CI:     node scripts/ci/classify-changes.ts --base <sha> --head <sha>   (escreve mode/reason em $GITHUB_OUTPUT)
// Uso local:     node scripts/ci/classify-changes.ts --base origin/main --head HEAD
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { bin } from "./lib/bin.ts";

/**
 * Elegíveis para dispensar build/backend/e2e/scanners de código e o deploy da Vercel: registros de andamento e de status.
 * NÃO entram: docs/tasks (contratos e aceites), CLAUDE.md/AGENTS.md, .claude/** (skills/regras), docs/*.json (lidos por
 * scripts), workflows, scripts, configs, README e qualquer outro arquivo. Mudar esta lista é mudança de gate (fluxo completo).
 */
export const DOC_ONLY_PATTERNS: readonly RegExp[] = [/^PROGRESS\.md$/, /^docs\/status\/[^/]+\.md$/];

export type Classification = { mode: "docs" | "full"; reason: string; files: string[] };

export function classifyFiles(files: string[]): Classification {
  if (!files.length) return { mode: "full", reason: "diff vazio ou indeterminado", files };
  const outside = files.filter((f) => !DOC_ONLY_PATTERNS.some((p) => p.test(f)));
  if (outside.length) return { mode: "full", reason: `${outside.length} arquivo(s) fora da lista documental (ex.: ${outside.slice(0, 3).join(", ")})`, files };
  return { mode: "docs", reason: `${files.length} arquivo(s), todos na lista documental elegível`, files };
}

const ZERO = /^0+$/;

const SAFE_REF = /^[\w./-]+$/;

/** Diferença entre as ÁRVORES base e head (cobre vários commits e merges). Renomeação conta origem e destino. */
export function changedFiles(base: string, head: string, cwd = process.cwd()): string[] {
  const out = execFileSync(bin("git"), ["diff", "--name-only", "--no-renames", "-z", base, head], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

export function classifyRange(base: string | undefined, head: string | undefined, cwd = process.cwd()): Classification {
  if (!base || !head || ZERO.test(base)) return { mode: "full", reason: "referência base ausente (branch nova, push forçado ou evento sem base)", files: [] };
  if (!SAFE_REF.test(base) || !SAFE_REF.test(head) || base.startsWith("-") || head.startsWith("-")) return { mode: "full", reason: "referência com formato inesperado", files: [] };
  try {
    for (const ref of [base, head]) execFileSync(bin("git"), ["cat-file", "-e", `${ref}^{commit}`], { cwd, stdio: "ignore" });
    return classifyFiles(changedFiles(base, head, cwd));
  } catch {
    return { mode: "full", reason: "não foi possível resolver os commits/diff com segurança", files: [] };
  }
}

/** CLI testável: imprime o modo, grava mode/reason em $GITHUB_OUTPUT e o resumo; sempre devolve 0 (a decisão é o modo). */
export function main(argv: string[], env: Record<string, string | undefined>, deps: { cwd?: string; log?: (text: string) => void } = {}): number {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const log = deps.log ?? console.log;
  const base = arg("base");
  const head = arg("head");
  const result = classifyRange(base, head, deps.cwd);
  log(`modo=${result.mode} — ${result.reason}`);
  for (const f of result.files.slice(0, 50)) log(`  ${f}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `mode=${result.mode}\nreason=${result.reason.replace(/[\r\n]/g, " ")}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### Classificação: \`${result.mode}\`\n\n${result.reason}\n\n${result.files.slice(0, 50).map((f) => `- \`${f}\``).join("\n")}\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
