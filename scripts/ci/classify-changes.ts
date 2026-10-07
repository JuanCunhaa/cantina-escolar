// Classifica as mudanças entre duas árvores: "docs" (só documentação elegível) ou "full" (fluxo completo).
// Lista EXPLÍCITA e conservadora; qualquer dúvida (SHA ausente, erro do git, diff vazio, caminho fora da lista) => "full".
// Uso no CI:     node scripts/ci/classify-changes.ts --base <sha> --head <sha>   (escreve mode/reason em $GITHUB_OUTPUT)
// Uso local:     node scripts/ci/classify-changes.ts --base origin/main --head HEAD
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

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
const SHA = /^[0-9a-f]{7,40}$/i;

/** Diferença entre as ÁRVORES base e head (cobre vários commits e merges). Renomeação conta origem e destino. */
export function changedFiles(base: string, head: string, cwd = process.cwd()): string[] {
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

export function classifyRange(base: string | undefined, head: string | undefined, cwd = process.cwd()): Classification {
  if (!base || !head || ZERO.test(base)) return { mode: "full", reason: "referência base ausente (branch nova, push forçado ou evento sem base)", files: [] };
  try {
    for (const ref of [base, head]) execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd, stdio: "ignore" });
    return classifyFiles(changedFiles(base, head, cwd));
  } catch {
    return { mode: "full", reason: "não foi possível resolver os commits/diff com segurança", files: [] };
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const base = arg("base");
  const head = arg("head");
  // Entradas vêm de variáveis do evento; validar o formato antes de passar ao git (SHA ou ref local simples).
  const safe = (v: string | undefined) => v === undefined || SHA.test(v) || /^[\w./-]+$/.test(v);
  const result = safe(base) && safe(head) ? classifyRange(base, head) : { mode: "full" as const, reason: "referência com formato inesperado", files: [] };
  console.log(`modo=${result.mode} — ${result.reason}`);
  for (const f of result.files.slice(0, 50)) console.log(`  ${f}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nreason=${result.reason.replace(/[\r\n]/g, " ")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Classificação: \`${result.mode}\`\n\n${result.reason}\n\n${result.files.slice(0, 50).map((f) => `- \`${f}\``).join("\n")}\n`);
  }
}
