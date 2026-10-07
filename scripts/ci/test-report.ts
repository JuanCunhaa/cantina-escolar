// Resumo estruturado de uma suíte (Playwright ou Vitest JSON) para o Step Summary, para a IA e para o gate final.
// Relatório ausente/ilegível, suíte vazia, skip, contagem diferente da esperada ou falha => ok:false e saída 1.
// Uso: node scripts/ci/test-report.ts <playwright|vitest> <arquivo.json> --suite <nome> [--expected N] [--expected-total N] [--log-url URL]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Failure = { file: string; line: number | null; title: string; error: string; attachments: string[] };
export type SuiteSummary = {
  schema: "cantina-ci-suite/1";
  suite: string;
  kind: "playwright" | "vitest";
  ok: boolean;
  problems: string[];
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  expected: number | null;
  /** Testes da suíte inteira listados pelo mesmo job (e2e): o gate confere g1 + g2 = total. */
  expected_total: number | null;
  duration_s: number | null;
  failures: Failure[];
  attempt: number | null;
  sha: string | null;
  log_url: string | null;
};

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
/** Erro principal: primeiras linhas significativas, sem cores; o log completo continua no job/artefato. */
export const mainError = (message: string, maxLines = 6) =>
  stripAnsi(message)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, maxLines)
    .join("\n");

type PwResult = { status: string; error?: { message?: string; location?: { file: string; line: number } }; errors?: { message?: string }[]; attachments?: { name: string; path?: string }[] };
type PwSpec = { title: string; file: string; line: number; tests: { status: string; results: PwResult[] }[] };
type PwSuite = { title?: string; specs?: PwSpec[]; suites?: PwSuite[] };
type PwReport = { suites?: PwSuite[]; errors?: { message?: string }[]; stats?: { duration?: number; expected?: number; unexpected?: number; flaky?: number; skipped?: number } };

export function summarizePlaywright(report: PwReport, suite: string): Omit<SuiteSummary, "expected" | "expected_total" | "attempt" | "sha" | "log_url" | "ok" | "problems"> & { globalErrors: string[] } {
  const failures: Failure[] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let flaky = 0;
  const walk = (s: PwSuite, path: string[]) => {
    for (const spec of s.specs ?? []) {
      for (const test of spec.tests) {
        total++;
        if (test.status === "expected") passed++;
        else if (test.status === "skipped") skipped++;
        else if (test.status === "flaky") flaky++;
        else {
          failed++;
          const last = test.results[test.results.length - 1];
          const message = last?.error?.message ?? last?.errors?.map((e) => e.message ?? "").join("\n") ?? test.status;
          failures.push({
            file: spec.file,
            line: spec.line,
            title: [...path, spec.title].join(" › "),
            error: mainError(message),
            attachments: (last?.attachments ?? []).map((a) => a.path ?? a.name).filter(Boolean).slice(0, 5),
          });
        }
      }
    }
    for (const child of s.suites ?? []) walk(child, child.title && !/\.spec\.ts$/.test(child.title) ? [...path, child.title] : path);
  };
  for (const s of report.suites ?? []) walk(s, []);
  return {
    schema: "cantina-ci-suite/1",
    suite,
    kind: "playwright",
    total,
    passed,
    failed,
    skipped,
    flaky,
    duration_s: report.stats?.duration !== undefined ? Math.round(report.stats.duration / 1000) : null,
    failures,
    globalErrors: (report.errors ?? []).map((e) => mainError(e.message ?? "erro global")),
  };
}

type VtAssertion = { fullName: string; status: string; failureMessages?: string[]; location?: { line: number } | null };
type VtFile = { name: string; status: string; message?: string; assertionResults: VtAssertion[]; startTime?: number; endTime?: number };
type VtReport = { numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number; testResults: VtFile[]; startTime?: number };

export function summarizeVitest(report: VtReport, suite: string, cwd = process.cwd()): ReturnType<typeof summarizePlaywright> {
  const rel = (p: string) => p.replace(/\\/g, "/").replace(`${cwd.replace(/\\/g, "/")}/`, "");
  const failures: Failure[] = [];
  const globalErrors: string[] = [];
  for (const file of report.testResults) {
    for (const a of file.assertionResults) {
      if (a.status === "failed") failures.push({ file: rel(file.name), line: a.location?.line ?? null, title: a.fullName, error: mainError((a.failureMessages ?? []).join("\n")), attachments: [] });
    }
    // Arquivo que nem carregou (erro de import/hook) não tem asserções: falha do arquivo inteiro.
    if (file.status === "failed" && !file.assertionResults.some((a) => a.status === "failed")) globalErrors.push(`${rel(file.name)}: ${mainError(file.message ?? "falha no arquivo")}`);
  }
  const ends = report.testResults.map((f) => f.endTime ?? 0);
  return {
    schema: "cantina-ci-suite/1",
    suite,
    kind: "vitest",
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests + report.numTodoTests,
    flaky: 0,
    duration_s: report.startTime && ends.length ? Math.round((Math.max(...ends) - report.startTime) / 1000) : null,
    failures,
    globalErrors,
  };
}

export function evaluate(base: ReturnType<typeof summarizePlaywright>, expected: number | null): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (base.total === 0) problems.push("nenhum teste executado");
  if (base.failed > 0) problems.push(`${base.failed} teste(s) falharam`);
  if (base.flaky > 0) problems.push(`${base.flaky} teste(s) instáveis (passaram só após nova tentativa)`);
  if (base.skipped > 0) problems.push(`${base.skipped} teste(s) pulados: suíte obrigatória não admite skip`);
  if (base.globalErrors.length) problems.push(...base.globalErrors.map((e) => `erro fora de teste: ${e}`));
  if (expected !== null && base.total !== expected) problems.push(`executados ${base.total} ≠ listados ${expected}`);
  return { ok: problems.length === 0, problems };
}

export function renderSummary(s: SuiteSummary): string {
  const lines = [`### ${s.ok ? "✅" : "❌"} ${s.suite}: ${s.passed}/${s.total} passaram${s.expected !== null ? ` (listados: ${s.expected})` : ""}${s.duration_s !== null ? ` em ${s.duration_s}s` : ""}`];
  for (const p of s.problems) lines.push(`- ${p}`);
  for (const f of s.failures.slice(0, 10)) {
    lines.push("", `**${f.file}${f.line ? `:${f.line}` : ""}** — ${f.title}`, "```", f.error, "```");
    if (f.attachments.length) lines.push(`Evidências: ${f.attachments.map((a) => `\`${a}\``).join(", ")}`);
  }
  if (s.failures.length > 10) lines.push(`… e mais ${s.failures.length - 10} falha(s) no relatório completo.`);
  if (s.log_url) lines.push("", `Log completo: ${s.log_url}`);
  return `${lines.join("\n")}\n`;
}

type Kind = "playwright" | "vitest";

const emptyBase = (suite: string, kind: Kind, problem: string): ReturnType<typeof summarizePlaywright> => ({
  schema: "cantina-ci-suite/1",
  suite,
  kind,
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  flaky: 0,
  duration_s: null,
  failures: [],
  globalErrors: [problem],
});

/** Lê o relatório e monta o resumo; relatório ausente ou ilegível vira problema (nunca sucesso). */
export function buildSummary(kind: Kind, file: string, opts: { suite: string; expected?: string; expectedTotal?: string; logUrl?: string; env: Record<string, string | undefined>; cwd?: string }): SuiteSummary {
  const { suite, env } = opts;
  let base: ReturnType<typeof summarizePlaywright>;
  if (!existsSync(file)) base = emptyBase(suite, kind, `relatório ausente: ${file}`);
  else {
    try {
      const report = JSON.parse(readFileSync(file, "utf8"));
      base = kind === "playwright" ? summarizePlaywright(report as PwReport, suite) : summarizeVitest(report as VtReport, suite, opts.cwd);
    } catch (error) {
      base = emptyBase(suite, kind, `relatório ilegível: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const expected = opts.expected === undefined || opts.expected === "" ? null : Number(opts.expected);
  const verdict = evaluate(base, expected === null ? null : Number.isFinite(expected) ? expected : Number.NaN);
  const { globalErrors: _ignored, ...rest } = base;
  void _ignored;
  return {
    ...rest,
    ...verdict,
    expected,
    expected_total: opts.expectedTotal ? Number(opts.expectedTotal) : null,
    attempt: env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : null,
    sha: env.GITHUB_SHA ?? null,
    log_url: opts.logUrl ?? null,
  };
}

/** CLI testável: grava ci-results/summary-<suíte>.json e devolve 0 (ok) ou 1. */
export function main(argv: string[], env: Record<string, string | undefined>, deps: { root?: string; stdout?: (text: string) => void } = {}): number {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const [kind, file] = argv;
  const suite = arg("suite");
  if ((kind !== "playwright" && kind !== "vitest") || !file || !suite || !/^[\w.-]+$/.test(suite)) {
    console.error("Uso: node scripts/ci/test-report.ts <playwright|vitest> <arquivo.json> --suite <nome> [--expected N] [--expected-total N] [--log-url URL]");
    return 2;
  }
  const root = deps.root ?? ".";
  const summary = buildSummary(kind, join(root, file), { suite, expected: arg("expected"), expectedTotal: arg("expected-total"), logUrl: arg("log-url"), env, cwd: root === "." ? process.cwd() : root });
  mkdirSync(join(root, "ci-results"), { recursive: true });
  writeFileSync(join(root, `ci-results/summary-${suite}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = renderSummary(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  (deps.stdout ?? ((text: string) => process.stdout.write(text)))(markdown);
  return summary.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
