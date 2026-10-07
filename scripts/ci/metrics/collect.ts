// Coletor FinOps do CI: lê só metadados da API (run, tentativas, jobs, artefatos, status do commit) e grava JSON + Markdown.
// Não baixa nem executa artefatos/código do PR, não dispara workflows e não altera o resultado do CI.
// Uso: node scripts/ci/metrics/collect.ts --repo dono/repo --run <id> [--out dir] [--history 30] [--collector-run <id>] [--gh]
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeRunMetrics, equivalenceKey, summarizeHistory, type ApiArtifact, type ApiAttempt, type ApiJob, type ApiRun, type RunMetrics } from "./compute.ts";
import { ghCliFetcher, paginate, tokenFetcher, type Fetcher } from "./github.ts";
import { renderMarkdown } from "./render.ts";

export async function fetchRunMetrics(fetcher: Fetcher, repo: string, runId: number, withExtras = true): Promise<RunMetrics> {
  const run = (await fetcher(`repos/${repo}/actions/runs/${runId}`)) as ApiRun;
  const attempts: ApiAttempt[] = [];
  const jobsByAttempt: ApiJob[][] = [];
  for (let n = 1; n <= run.run_attempt; n++) {
    attempts.push((await fetcher(`repos/${repo}/actions/runs/${runId}/attempts/${n}`)) as ApiAttempt);
    jobsByAttempt.push(await paginate<ApiJob>(fetcher, `repos/${repo}/actions/runs/${runId}/attempts/${n}/jobs`, "jobs"));
  }
  let artifacts: ApiArtifact[] = [];
  let vercel: { state: string; created_at: string; updated_at: string } | null = null;
  if (withExtras) {
    artifacts = await paginate<ApiArtifact>(fetcher, `repos/${repo}/actions/runs/${runId}/artifacts`, "artifacts");
    try {
      const status = (await fetcher(`repos/${repo}/commits/${run.head_sha}/status`)) as { statuses?: { context: string; state: string; created_at: string; updated_at: string }[] };
      vercel = status.statuses?.find((s) => s.context === "Vercel") ?? null;
    } catch {
      vercel = null; // sem permissão/sem status: relatado como indisponível
    }
  }
  return computeRunMetrics({ run, attempts, jobsByAttempt, artifacts, vercel });
}

async function history(fetcher: Fetcher, repo: string, current: RunMetrics, limit: number) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const runs = await paginate<ApiRun>(fetcher, `repos/${repo}/actions/workflows/${current.workflow.id}/runs?status=completed&created=%3E%3D${since}`, "workflow_runs", 3);
  const key = equivalenceKey(current);
  const samples: RunMetrics[] = [current];
  for (const run of runs.filter((r) => r.id !== current.run.id).slice(0, limit)) {
    const metrics = await fetchRunMetrics(fetcher, repo, run.id, false);
    if (equivalenceKey(metrics) === key) samples.push(metrics);
  }
  return summarizeHistory(samples);
}

/** O coletor não conhece a própria duração final enquanto executa: informa a parcial e o total FINAL das execuções anteriores. */
async function collectorUsage(fetcher: Fetcher, repo: string, collectorRunId: number) {
  const own = (await fetcher(`repos/${repo}/actions/runs/${collectorRunId}`)) as ApiRun;
  const jobs = await paginate<ApiJob>(fetcher, `repos/${repo}/actions/runs/${collectorRunId}/jobs`, "jobs");
  const started = jobs.map((j) => j.started_at).filter((v): v is string => Boolean(v)).sort()[0];
  const previous = await paginate<ApiRun>(fetcher, `repos/${repo}/actions/workflows/${own.workflow_id}/runs?status=completed`, "workflow_runs", 1);
  let previousRawS = 0;
  let previousRounded = 0;
  const sample = previous.filter((r) => r.id !== collectorRunId).slice(0, 10);
  for (const r of sample) {
    const m = await fetchRunMetrics(fetcher, repo, r.id, false);
    previousRawS += m.consumption.runner_raw_s;
    previousRounded += m.consumption.rounded_estimate_min;
  }
  return {
    run_id: collectorRunId,
    partial_duration_s: started ? Math.round((Date.now() - Date.parse(started)) / 1000) : null,
    partial_note: "parcial: medida antes do fim do próprio job",
    previous_runs_final: { n: sample.length, runner_raw_s: previousRawS, rounded_estimate_min: previousRounded },
  };
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
    else {
      args[a.slice(2)] = next;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = String(args.repo ?? process.env.GITHUB_REPOSITORY ?? "");
  const runId = Number(args.run);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(runId) || runId <= 0) {
    console.error("Uso: node scripts/ci/metrics/collect.ts --repo dono/repo --run <id> [--out dir] [--history N] [--collector-run <id>] [--gh]");
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN;
  const fetcher = args.gh || !token ? ghCliFetcher() : tokenFetcher(token, process.env.GITHUB_API_URL);
  const metrics = await fetchRunMetrics(fetcher, repo, runId);
  const limit = args.history === undefined ? 0 : Number(args.history);
  const hist = limit > 0 ? await history(fetcher, repo, metrics, limit) : null;
  const collector = args["collector-run"] ? await collectorUsage(fetcher, repo, Number(args["collector-run"])) : null;
  const report = { ...metrics, history: hist, collector };
  const markdown = renderMarkdown(metrics, { history: hist, collector });
  const out = String(args.out ?? "ci-metrics");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "ci-metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, "ci-metrics.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else process.stdout.write(markdown);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Coleta de métricas falhou: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
