// Gate final obrigatório do CI (job `check`). Roda sempre (if: always()) e só aprova quando, para o modo classificado:
// - cada job exigido terminou em success e cada job dispensado terminou em skipped (falha, cancelamento ou skip indevido reprovam);
// - todo job em `needs` tem regra aqui (job novo sem regra reprova);
// - cada suíte obrigatória tem resumo ok (relatório ausente, skip, contagem ≠ listada reprovam) e a soma dos grupos e2e
//   é igual à suíte listada no job fast. Mudanças nestas regras são mudança de gate (classificação: fluxo completo).
// Uso: NEEDS='${{ toJSON(needs) }}' node scripts/ci/gate.ts --summaries <dir> [--repo dono/repo --run <id> --attempt <n>]
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteSummary } from "./test-report.ts";
import { paginate, tokenFetcher, type Fetcher } from "./metrics/github.ts";

export type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

export const RULES = {
  full: {
    success: ["changes", "fast", "backend", "build", "e2e", "security", "quality"],
    skipped: [] as string[],
    suites: ["unit", "rules", "integration", "e2e-g1", "e2e-g2"],
  },
  docs: {
    success: ["changes", "fast", "security"],
    skipped: ["backend", "build", "e2e", "quality"],
    suites: [] as string[],
  },
} as const;

export type GateResult = { ok: boolean; mode: string; problems: string[]; rows: { job: string; result: string; expected: string }[]; suites: Record<string, SuiteSummary | null> };

/** Último resumo por suíte: em reexecução parcial vale o da tentativa mais recente; grupos aprovados antes continuam válidos. */
export function latestSummaries(entries: { attempt: number; summary: SuiteSummary }[]): Record<string, SuiteSummary> {
  const latest: Record<string, { attempt: number; summary: SuiteSummary }> = {};
  for (const e of entries) {
    const current = latest[e.summary.suite];
    if (!current || e.attempt > current.attempt) latest[e.summary.suite] = e;
  }
  return Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v.summary]));
}

export function evaluateGate(needs: Needs, summaries: Record<string, SuiteSummary>, sha?: string): GateResult {
  const problems: string[] = [];
  const mode = needs.changes?.outputs?.mode ?? "";
  const rows: GateResult["rows"] = [];
  if (needs.changes?.result !== "success") problems.push(`classificação não concluiu (changes: ${needs.changes?.result ?? "ausente"})`);
  if (mode !== "full" && mode !== "docs") {
    problems.push(`modo de execução desconhecido: "${mode}"`);
    return { ok: false, mode, problems, rows, suites: {} };
  }
  const rule = RULES[mode];
  const known = new Set<string>([...RULES.full.success, ...RULES.full.skipped, ...RULES.docs.success, ...RULES.docs.skipped]);
  for (const job of Object.keys(needs)) if (!known.has(job)) problems.push(`job ${job} sem regra no gate`);
  for (const job of [...rule.success, ...rule.skipped]) {
    const expected = (rule.success as readonly string[]).includes(job) ? "success" : "skipped";
    const result = needs[job]?.result ?? "ausente";
    rows.push({ job, result, expected });
    if (result !== expected) problems.push(`${job}: ${result} (esperado ${expected})`);
  }
  const suites: Record<string, SuiteSummary | null> = {};
  for (const suite of rule.suites) {
    const s = summaries[suite] ?? null;
    suites[suite] = s;
    if (!s) problems.push(`resumo da suíte ${suite} ausente`);
    else {
      if (!s.ok) problems.push(`suíte ${suite} reprovada: ${s.problems.join("; ")}`);
      if (sha && s.sha && s.sha !== sha) problems.push(`resumo da suíte ${suite} é de outro commit (${s.sha})`);
    }
  }
  if (mode === "full") {
    // União dos grupos e2e = suíte listada. Cada grupo lista a suíte inteira no próprio job (sem depender de outro job).
    const g1 = summaries["e2e-g1"];
    const g2 = summaries["e2e-g2"];
    if (g1 && g2) {
      const total = g1.expected_total;
      if (!Number.isInteger(total) || !total || total !== g2.expected_total) problems.push(`contagem da suíte e2e listada ausente ou divergente entre os grupos (${g1.expected_total} / ${g2.expected_total})`);
      else if (g1.total + g2.total !== total) problems.push(`e2e: g1 ${g1.total} + g2 ${g2.total} ≠ suíte listada ${total}`);
    }
  }
  return { ok: problems.length === 0, mode, problems, rows, suites };
}

export function readSummaries(dir: string): { attempt: number; summary: SuiteSummary }[] {
  if (!existsSync(dir)) return [];
  const out: { attempt: number; summary: SuiteSummary }[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^summary-[\w.-]+\.json$/.test(entry.name)) {
        try {
          const summary = JSON.parse(readFileSync(full, "utf8")) as SuiteSummary;
          if (summary.schema === "cantina-ci-suite/1" && typeof summary.suite === "string") out.push({ attempt: Number(summary.attempt ?? 0), summary });
        } catch {
          /* resumo ilegível = ausente; a suíte é reprovada pela regra de ausência */
        }
      }
    }
  };
  walk(dir);
  return out;
}

export type FailedStep = { job: string; step: string; url: string | null };

export async function failedSteps(fetcher: Fetcher, repo: string, run: string, attempt: string): Promise<FailedStep[]> {
  const jobs = await paginate<{ name: string; conclusion: string | null; html_url: string | null; steps?: { name: string; conclusion: string | null }[] }>(
    fetcher,
    `repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs`,
    "jobs",
  );
  return jobs
    .filter((j) => j.conclusion === "failure" || j.conclusion === "cancelled")
    .flatMap((j) => {
      const steps = (j.steps ?? []).filter((s) => s.conclusion === "failure" || s.conclusion === "cancelled");
      return steps.length ? steps.map((s) => ({ job: j.name, step: s.name, url: j.html_url })) : [{ job: j.name, step: `(job ${j.conclusion})`, url: j.html_url }];
    });
}

export function renderGate(result: GateResult, steps: FailedStep[]): string {
  const lines = [`## ${result.ok ? "✅ check aprovado" : "❌ check reprovado"} — modo \`${result.mode || "?"}\``, "", "| Job | Resultado | Esperado |", "|---|---|---|"];
  for (const r of result.rows) lines.push(`| ${r.job} | ${r.result === r.expected ? "" : "**"}${r.result}${r.result === r.expected ? "" : "**"} | ${r.expected} |`);
  if (result.problems.length) lines.push("", "### Motivos", ...result.problems.map((p) => `- ${p}`));
  if (steps.length) lines.push("", "### Jobs/etapas com falha", ...steps.map((s) => `- **${s.job}** › ${s.step}${s.url ? ` — [log](${s.url})` : ""}`));
  const failing = Object.values(result.suites).filter((s): s is SuiteSummary => Boolean(s && s.failures.length));
  if (failing.length) {
    lines.push("", "### Testes com falha (erro principal; log e evidências completos nos links)");
    for (const s of failing) for (const f of s.failures.slice(0, 5)) lines.push(`- \`${s.suite}\` **${f.file}${f.line ? `:${f.line}` : ""}** — ${f.title}: ${f.error.split("\n")[0]}${s.log_url ? ` ([log](${s.log_url}))` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** CLI testável: devolve o código de saída (0 aprovado, 1 reprovado). */
export async function main(argv: string[], env: Record<string, string | undefined>, deps: { fetcher?: Fetcher; root?: string; stdout?: (text: string) => void } = {}): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = deps.root ?? ".";
  const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
  let needs: Needs;
  try {
    needs = JSON.parse(env.NEEDS ?? "") as Needs;
  } catch {
    out("NEEDS ausente ou ilegível: gate reprovado\n");
    return 1;
  }
  const result = evaluateGate(needs, latestSummaries(readSummaries(join(root, arg("summaries") ?? "ci-summaries"))), env.GITHUB_SHA);
  let steps: FailedStep[] = [];
  const repo = arg("repo");
  const run = arg("run");
  const attempt = arg("attempt");
  const fetcher = deps.fetcher ?? (env.GITHUB_TOKEN ? tokenFetcher(env.GITHUB_TOKEN) : undefined);
  if (!result.ok && repo && run && attempt && fetcher) {
    try {
      steps = await failedSteps(fetcher, repo, run, attempt);
    } catch (error) {
      result.problems.push(`(diagnóstico) não foi possível listar as etapas com falha: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const markdown = renderGate(result, steps);
  mkdirSync(join(root, "ci-results"), { recursive: true });
  writeFileSync(join(root, "ci-results/gate.json"), `${JSON.stringify({ ...result, failed_steps: steps }, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  out(markdown);
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
