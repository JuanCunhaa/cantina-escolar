// Cálculo das métricas FinOps de uma execução do Actions a partir dos metadados da API (fonte principal).
// Funções puras: recebem os objetos da API e devolvem o relatório; testadas com fixtures de execuções reais.
import { jobIdOf, type NeedsGraph } from "./graph.ts";

export type ApiStep = { name: string; number: number; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null };
export type ApiJob = {
  id: number;
  name: string;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  runner_name: string | null;
  labels: string[];
  html_url?: string | null;
  steps?: ApiStep[];
};
export type ApiAttempt = { run_attempt: number; run_started_at: string; created_at: string; status: string; conclusion: string | null };
export type ApiRun = {
  id: number;
  name: string;
  path: string;
  workflow_id: number;
  event: string;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  run_started_at: string;
  pull_requests?: { number: number }[];
};
export type ApiArtifact = { id: number; name: string; size_in_bytes: number; created_at: string | null; expires_at: string | null; expired: boolean };

/** Origem do runner: máquina própria (self-hosted) ou hospedado pelo GitHub. Minutos da máquina própria NÃO são minutos hospedados. */
export type RunnerOrigin = "self-hosted" | "github-hosted";

export type Execution = {
  job_ids: number[];
  name: string;
  attempt: number;
  conclusion: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  start_delay_s: number | null;
  duration_s: number;
  rounded_min: number;
  runner_origin: RunnerOrigin;
  /** Fila do runner: do momento em que o job ficou PRONTO (criado e dependências concluídas) até o início. null = grafo indisponível ou job copiado. */
  queue_s: number | null;
  /** Tempo do job sem runner atribuído (fila até cancelamento/conclusão): não é consumo de runner. */
  without_runner_s: number;
  runner_name: string | null;
  labels: string[];
  url: string | null;
  steps: { name: string; conclusion: string | null; duration_s: number | null }[];
};

const seconds = (from: string | null | undefined, to: string | null | undefined): number | null => {
  if (!from || !to) return null;
  return Math.round((Date.parse(to) - Date.parse(from)) / 1000);
};

/** Pelo rótulo `self-hosted` de runs-on; sem rótulos, runner com nome fora do padrão "GitHub Actions N" também é próprio. */
export function runnerOrigin(job: Pick<ApiJob, "labels" | "runner_name">): RunnerOrigin {
  const labels = (job.labels ?? []).map((l) => l.toLowerCase());
  if (labels.includes("self-hosted")) return "self-hosted";
  if (!labels.length && job.runner_name && !/^GitHub Actions/i.test(job.runner_name)) return "self-hosted";
  return "github-hosted";
}

/** Estimativa por job: o GitHub arredonda cada job para o minuto inteiro superior. Não é cobrança oficial. */
export const roundedMinutes = (durationS: number): number => (durationS > 0 ? Math.ceil(durationS / 60) : 0);

/**
 * Deduplica os jobs de todas as tentativas. Medido em 07/10/2026 (run 37552886769): numa reexecução parcial, a API devolve na
 * tentativa nova os jobs NÃO reexecutados com ID NOVO e `run_attempt` da tentativa nova, porém com `started_at`/`completed_at`
 * e runner da execução original (início anterior à criação). Por isso a identidade da execução é (nome, runner, início, fim)
 * e ela é atribuída à tentativa mais antiga em que aparece; o ID sozinho duplicaria o consumo.
 */
export function dedupeExecutions(jobsByAttempt: ApiJob[][]): Execution[] {
  const byKey = new Map<string, Execution>();
  const ordered: Execution[] = [];
  jobsByAttempt.forEach((jobs, index) => {
    for (const job of jobs) {
      const attempt = job.run_attempt || index + 1;
      // Sem runner atribuído (ex.: cancelado na fila durante incidente do Actions, 0 etapas) não é execução de runner.
      const executed = Boolean(job.started_at && job.completed_at && job.runner_name) && job.conclusion !== "skipped";
      const key = executed ? `${job.name}|${job.runner_name ?? ""}|${job.started_at}|${job.completed_at}` : `${job.id}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.job_ids.includes(job.id)) existing.job_ids.push(job.id);
        if (attempt < existing.attempt) existing.attempt = attempt;
        continue;
      }
      const duration = executed ? Math.max(0, seconds(job.started_at, job.completed_at) ?? 0) : 0;
      const waitedWithoutRunner = !executed && !job.runner_name && job.conclusion !== "skipped" ? Math.max(0, seconds(job.created_at, job.completed_at) ?? 0) : 0;
      // started_at anterior à criação = job copiado de tentativa anterior cujo original não veio na listagem.
      const carried = executed && job.started_at !== null && Date.parse(job.started_at) + 1000 < Date.parse(job.created_at);
      const execution: Execution = {
        job_ids: [job.id],
        name: job.name,
        attempt: carried ? Math.max(1, attempt - 1) : attempt,
        conclusion: job.conclusion,
        status: job.status,
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
        start_delay_s: carried ? null : seconds(job.created_at, job.started_at),
        duration_s: duration,
        // Só runner hospedado entra na estimativa de minutos do GitHub; a máquina própria é tempo medido, sem arredondamento.
        rounded_min: runnerOrigin(job) === "github-hosted" ? roundedMinutes(duration) : 0,
        runner_origin: runnerOrigin(job),
        queue_s: null,
        without_runner_s: waitedWithoutRunner,
        runner_name: job.runner_name,
        labels: job.labels ?? [],
        url: job.html_url ?? null,
        steps: (job.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion, duration_s: seconds(s.started_at, s.completed_at) })),
      };
      byKey.set(key, execution);
      ordered.push(execution);
    }
  });
  return ordered;
}

/**
 * Fila do runner = início − momento em que o job ficou pronto. A API só dá criação→início (start_delay_s), que também inclui a
 * espera pelas dependências (`needs`); com o grafo do workflow, pronto = max(criação, fim das dependências já concluídas).
 * Sem grafo, job fora dele ou job copiado de tentativa anterior: null (desconhecido, nunca zero).
 */
export function applyQueue(executions: Execution[], needs: NeedsGraph | undefined): void {
  if (!needs) return;
  for (const e of executions) {
    if (e.start_delay_s === null || !e.started_at) continue;
    const id = jobIdOf(e.name, needs);
    if (!id) continue;
    const started = Date.parse(e.started_at);
    const ready = (needs[id] ?? [])
      .flatMap((dep) => executions.filter((d) => jobIdOf(d.name, needs) === dep && d.completed_at && Date.parse(d.completed_at) <= started + 1000).map((d) => Date.parse(d.completed_at ?? "")))
      .reduce((max, t) => Math.max(max, t), Date.parse(e.created_at));
    e.queue_s = Math.max(0, Math.round((started - ready) / 1000));
  }
}

const countBy = (executions: Execution[]) => {
  const counts: Record<string, number> = {};
  for (const e of executions) {
    const key = e.status === "completed" ? (e.conclusion ?? "unknown") : e.status;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

const maxIso = (values: (string | null)[]): string | null => {
  const times = values.filter((v): v is string => Boolean(v)).map((v) => Date.parse(v));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
};

const ranOf = (executions: Execution[], origin: RunnerOrigin) => executions.filter((e) => e.duration_s > 0 && e.runner_origin === origin);

export type RunMetrics = ReturnType<typeof computeRunMetrics>;

export function computeRunMetrics(input: {
  run: ApiRun;
  attempts: ApiAttempt[];
  jobsByAttempt: ApiJob[][];
  artifacts?: ApiArtifact[];
  vercel?: { state: string; created_at: string; updated_at: string } | null;
  generatedAt?: string;
  /** Grafo `needs` do workflow (scripts/ci/metrics/graph.ts); sem ele a fila fica indisponível. */
  needs?: NeedsGraph;
}) {
  const { run, attempts } = input;
  const executions = dedupeExecutions(input.jobsByAttempt);
  applyQueue(executions, input.needs);
  const hosted = ranOf(executions, "github-hosted");
  const own = ranOf(executions, "self-hosted");
  const queues = own.map((e) => e.queue_s);
  const queueKnown = own.length > 0 && queues.every((q) => q !== null);
  const ran = executions.filter((e) => e.duration_s > 0);
  const rawS = ran.reduce((sum, e) => sum + e.duration_s, 0);
  const roundedMin = ran.reduce((sum, e) => sum + e.rounded_min, 0);
  const completed = run.status === "completed" && executions.every((e) => e.status === "completed");

  let previousEnd: string | null = null;
  const attemptRows = attempts
    .slice()
    .sort((a, b) => a.run_attempt - b.run_attempt)
    .map((a) => {
      const own = executions.filter((e) => e.attempt === a.run_attempt);
      const ownRan = own.filter((e) => e.duration_s > 0);
      const end = maxIso(own.map((e) => e.completed_at));
      const row = {
        attempt: a.run_attempt,
        conclusion: a.conclusion,
        started_at: a.run_started_at,
        completed_at: end,
        duration_s: seconds(a.run_started_at, end),
        // Intervalo entre o fim da tentativa anterior e o início desta: espera humana/decisão, NÃO é tempo de runner.
        idle_before_s: previousEnd ? seconds(previousEnd, a.run_started_at) : null,
        jobs_executed: ownRan.map((e) => e.name),
        runner_raw_s: ownRan.reduce((s, e) => s + e.duration_s, 0),
        rounded_estimate_min: ownRan.reduce((s, e) => s + e.rounded_min, 0),
        counts: countBy(own),
      };
      previousEnd = end ?? previousEnd;
      return row;
    });

  const lastEnd = maxIso(executions.map((e) => e.completed_at));
  const firstAttemptEnd = attemptRows[0]?.completed_at ?? null;
  const reruns = ran.filter((e) => e.attempt > 1);
  const artifacts = (input.artifacts ?? []).map((a) => ({
    name: a.name,
    size_bytes: a.size_in_bytes,
    created_at: a.created_at,
    expires_at: a.expires_at,
    retention_days: a.created_at && a.expires_at ? Math.round((Date.parse(a.expires_at) - Date.parse(a.created_at)) / 86_400_000) : null,
    expired: a.expired,
  }));
  // Transferências: passos cujo nome começa com "Artefato:" (convenção do ci.yml).
  const transfers = executions.flatMap((e) =>
    e.steps.filter((s) => s.name.startsWith("Artefato:")).map((s) => ({ job: e.name, attempt: e.attempt, step: s.name, duration_s: s.duration_s, conclusion: s.conclusion })),
  );

  return {
    schema: "cantina-ci-metrics/1",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    source: "GitHub Actions REST API (metadados de execução)",
    complete: completed,
    workflow: { name: run.name, path: run.path, id: run.workflow_id },
    run: {
      id: run.id,
      url: run.html_url,
      event: run.event,
      branch: run.head_branch,
      head_sha: run.head_sha,
      pull_requests: (run.pull_requests ?? []).map((p) => p.number),
      attempts: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
      created_at: run.created_at,
    },
    timing: {
      // Espera do desenvolvedor: do evento (criação do run) ao fim do último job executado; inclui intervalos entre tentativas.
      result_wait_s: completed ? seconds(run.created_at, lastEnd) : null,
      first_attempt_wait_s: seconds(run.created_at, firstAttemptEnd),
      attempts: attemptRows,
    },
    consumption: {
      runner_raw_s: rawS,
      runner_raw_min: Math.round((rawS / 60) * 10) / 10,
      rounded_estimate_min: roundedMin,
      rounded_estimate_note: "estimativa só dos jobs em runner HOSPEDADO: cada job arredondado ao minuto superior; não é cobrança. Máquina própria não entra",
      // Por origem do runner. A soma dos tempos da máquina própria mede ocupação (serial, uma instância), não cobrança.
      github_hosted: { jobs: hosted.length, raw_s: hosted.reduce((s, e) => s + e.duration_s, 0), rounded_estimate_min: hosted.reduce((s, e) => s + e.rounded_min, 0) },
      self_hosted: {
        jobs: own.length,
        raw_s: own.reduce((s, e) => s + e.duration_s, 0),
        queue_known: queueKnown,
        queue_sum_s: queueKnown ? queues.reduce((s: number, q) => s + (q ?? 0), 0) : null,
        queue_max_s: queueKnown ? Math.max(...queues.map((q) => q ?? 0)) : null,
        note: "tempo de máquina própria: ocupação do runner, não é minuto hospedado nem cobrança; fila exige o grafo needs do workflow",
      },
      official: { available: false, reason: "consumo/custo oficial não consultado: /timing devolve billable 0 e a API de cobrança exige escopo de conta não concedido" },
      reruns_raw_s: reruns.reduce((s, e) => s + e.duration_s, 0),
      without_runner_s: executions.reduce((s, e) => s + e.without_runner_s, 0),
      without_runner_note: "jobs sem runner atribuído (fila/incidente): fora do consumo",
      reruns_rounded_estimate_min: reruns.reduce((s, e) => s + e.rounded_min, 0),
    },
    counts: countBy(executions),
    jobs: executions,
    artifacts,
    transfers,
    vercel: input.vercel
      ? { available: true, state: input.vercel.state, status_at: input.vercel.updated_at, duration_s: null, note: "a Vercel publica só o status final no commit; duração indisponível pelo GitHub" }
      : { available: false, note: "sem status da Vercel para este commit" },
  };
}

/** Assinatura de equivalência para comparação histórica: evento + conjunto de jobs que executaram na 1ª tentativa. */
export function equivalenceKey(metrics: RunMetrics): string {
  const ran = metrics.jobs.filter((j) => j.attempt === 1 && j.duration_s > 0);
  const names = new Set(ran.map((j) => j.name));
  // Origem entra na chave: execução paralela hospedada e serial na máquina própria não são equivalentes (espera e soma diferem).
  const origins = new Set(ran.map((j) => j.runner_origin));
  return `${metrics.run.event}|${[...origins].sort((a, b) => a.localeCompare(b)).join("+")}|${[...names].sort((a, b) => a.localeCompare(b)).join(",")}`;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Mediana com n ≥ 5 e p95 com n ≥ 20; abaixo disso a estatística é omitida (amostra insuficiente). */
export function summarizeHistory(samples: RunMetrics[]) {
  const pick = (f: (m: RunMetrics) => number | null) => samples.map(f).filter((v): v is number => typeof v === "number");
  const stat = (values: number[]) => ({ n: values.length, median: values.length >= 5 ? median(values) : null, p95: values.length >= 20 ? percentile(values, 95) : null });
  return {
    n: samples.length,
    first_attempt_wait_s: stat(pick((m) => m.timing.first_attempt_wait_s)),
    result_wait_s: stat(pick((m) => m.timing.result_wait_s)),
    runner_raw_min: stat(pick((m) => m.consumption.runner_raw_min)),
    rounded_estimate_min: stat(pick((m) => m.consumption.rounded_estimate_min)),
    runs: samples.map((m) => m.run.id),
  };
}
