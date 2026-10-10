// Status do CI para a IA/dev, com o `gh` autenticado (somente leitura). Uma consulta, sem acompanhamento periódico.
// Mostra jobs/tentativas/durações, etapa que falhou, testes com falha (arquivo:linha + erro principal), artefatos, comando de
// reprodução local por job e o comando para reexecutar SÓ o job falho no mesmo commit. O log completo de cada job falho é
// salvo em .agent-logs/ (não truncado); o resumo aponta para ele e para o link do Actions.
// Uso: npm run ci:status -- [--pr <n> | --run <id> | --branch <nome>]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchRunMetrics } from "./metrics/collect.ts";
import { ghCliFetcher, type Fetcher } from "./metrics/github.ts";
import { bin } from "./lib/bin.ts";
import { writeLines } from "./lib/output.ts";

const REPRO: Record<string, string> = {
  changes: "node scripts/ci/classify-changes.ts --base origin/main --head HEAD",
  fast: "npm run lint; npm run typecheck; npm test; node scripts/ci/e2e-groups.ts verify",
  backend: "npm run test:rules; npm run test:integration (um grupo: $env:INTEGRATION_GROUP='g1'; npm run test:integration)",
  build: "npm run build (CI, Turbopack) — nesta máquina Windows: npm run build:webpack",
  e2e: "npm run build:webpack; $env:E2E_SERVER_MODE='start'; npm run test:e2e:group -- <g1|g2>   (sem build: modo dev, npm run test:e2e:group -- <g1|g2>)",
  security: "npm run audit:prod (Gitleaks/Veracode só no CI; Gitleaks é bloqueado nesta máquina)",
  quality: "npm test -- --coverage (o Quality Gate só existe no SonarQube Cloud)",
  check: "node scripts/ci/ci-status.ts --run <id> (o gate só agrega os demais jobs)",
};

export function extractFailures(log: string): string[] {
  const lines = log.split(/\r?\n/).map((l) => l.replace(/^\S+Z /, "").replace(/\u001b\[[0-9;]*m/g, ""));
  const picked: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*✘\s+\d+|^\s*\d+\) tests\/|^\s*(FAIL|×)\s|::error::|^\s*Error: |AssertionError|TimeoutError|ELIFECYCLE|exit code [1-9]/.test(line)) {
      picked.push(line.trim());
      if (/^\s*(Error: |AssertionError|TimeoutError)/.test(line)) for (const next of lines.slice(i + 1, i + 4)) if (next.trim() && !next.includes("##[")) picked.push(`    ${next.trim()}`);
    }
  });
  return [...new Set(picked)].slice(0, 40);
}

export type Gh = (...args: string[]) => string;
const defaultGh: Gh = (...args) => execFileSync(bin("gh"), args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Status de um run (texto para a IA/dev). `gh` e diretório de logs injetáveis. */
export async function status(argv: string[], deps: { gh?: Gh; logDir?: string; fetcher?: Fetcher } = {}): Promise<string> {
  const gh = deps.gh ?? defaultGh;
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repositório não identificado");
  let runId = arg("run");
  if (!runId) {
    const pr = arg("pr");
    const branch = arg("branch") ?? (pr ? (JSON.parse(gh("pr", "view", pr, "--json", "headRefName")) as { headRefName: string }).headRefName : gh("branch", "--show-current").trim());
    const runs = JSON.parse(gh("run", "list", "--workflow", "ci.yml", "--branch", branch, "-L", "1", "--json", "databaseId")) as { databaseId: number }[];
    if (!runs[0]) throw new Error(`nenhuma execução do ci para ${branch}`);
    runId = String(runs[0].databaseId);
  }
  if (!/^\d+$/.test(runId)) throw new Error("id de run inválido");
  const m = await fetchRunMetrics(deps.fetcher ?? ghCliFetcher(() => gh("auth", "token").trim()), repo, Number(runId));
  const out: string[] = [];
  out.push(`ci run ${m.run.id} · ${m.run.event} · ${m.run.branch} · ${m.run.head_sha.slice(0, 7)} · tentativas ${m.run.attempts} · ${m.run.status}/${m.run.conclusion ?? "—"}`);
  out.push(m.run.url);
  out.push(`espera 1ª tentativa ${m.timing.first_attempt_wait_s ?? "—"} s · runners ${m.consumption.runner_raw_min} min brutos (hospedado ${m.consumption.github_hosted.jobs} job(s) / própria ${m.consumption.self_hosted.jobs} job(s), ${Math.round(m.consumption.self_hosted.raw_s / 6) / 10} min) / ${m.consumption.rounded_estimate_min} min arredondados só do hospedado (estimativa)`);
  const lastByName = new Map<string, (typeof m.jobs)[number]>();
  for (const j of m.jobs) lastByName.set(j.name, j);
  const logDir = deps.logDir ?? ".agent-logs";
  mkdirSync(logDir, { recursive: true });
  for (const j of lastByName.values()) {
    const failedSteps = j.steps.filter((s) => s.conclusion === "failure" || s.conclusion === "cancelled").map((s) => s.name);
    out.push(`- ${j.name} [tentativa ${j.attempt}] ${j.conclusion ?? j.status} ${j.duration_s}s${failedSteps.length ? ` · etapa: ${failedSteps.join(" | ")}` : ""}`);
    if (j.conclusion !== "failure") continue;
    const jobId = j.job_ids[j.job_ids.length - 1]!;
    try {
      const log = gh("api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${jobId}/logs`);
      const path = join(logDir, `ci-${m.run.id}-${jobId}.log`);
      writeFileSync(path, log);
      for (const line of extractFailures(log)) out.push(`    ${line}`);
      out.push(`    log completo: ${path} · ${j.url ?? ""}`);
    } catch {
      out.push(`    log indisponível pela API; ver ${j.url ?? m.run.url}`);
    }
    const base = j.name.replace(/ \(.*\)$/, "");
    out.push(`    reproduzir: ${REPRO[base] ?? "ver docs/testing/ci.md"}`);
    out.push(`    reexecutar só este job (mesmo commit): gh run rerun ${m.run.id} --job ${jobId}`);
  }
  if (m.artifacts.length) {
    out.push("artefatos:");
    for (const a of m.artifacts) out.push(`  ${a.name} (${(a.size_bytes / 1_048_576).toFixed(1)} MB${a.expired ? ", expirado" : ""}) → gh run download ${m.run.id} -n ${a.name}`);
  }
  return out.join("\n");
}

if (import.meta.main) {
  try {
    writeLines(await status(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
