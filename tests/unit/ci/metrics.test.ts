import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeRunMetrics, dedupeExecutions, median, percentile, roundedMinutes, summarizeHistory, type ApiArtifact, type ApiAttempt, type ApiJob, type ApiRun } from "../../../scripts/ci/metrics/compute.ts";
import { renderMarkdown } from "../../../scripts/ci/metrics/render.ts";

// Fixtures: metadados reais da API (07/10/2026), reduzidos aos campos usados.
type Fixture = { run: ApiRun; attempts: ApiAttempt[]; jobsByAttempt: ApiJob[][]; artifacts: ApiArtifact[] };
const load = (id: number) => JSON.parse(readFileSync(new URL(`./fixtures/run-${id}.json`, import.meta.url), "utf8")) as Fixture;

describe("métricas FinOps a partir da API do Actions", () => {
  it("reexecução parcial: jobs não reexecutados voltam com ID novo e não contam de novo", () => {
    const fx = load(37552886769);
    const ids2 = fx.jobsByAttempt[1]!.map((j) => j.id);
    expect(ids2.some((id) => fx.jobsByAttempt[0]!.some((j) => j.id === id))).toBe(false); // IDs diferentes: o ID sozinho duplicaria
    const m = computeRunMetrics({ ...fx, generatedAt: "x" });
    expect(m.jobs.map((j) => `${j.name}@${j.attempt}`)).toEqual(["security@1", "check@1", "semgrep-appsec@1", "check@2"]);
    expect(m.jobs.find((j) => j.name === "security")!.job_ids).toHaveLength(2);
    expect(m.consumption.runner_raw_s).toBe(47 + 1121 + 296 + 988);
    expect(m.consumption.rounded_estimate_min).toBe(1 + 19 + 5 + 17);
    expect(m.consumption.reruns_raw_s).toBe(988);
    expect(m.consumption.official.available).toBe(false);
    expect(m.timing.attempts.map((a) => a.jobs_executed)).toEqual([["security", "check", "semgrep-appsec"], ["check"]]);
    // Intervalo humano entre as tentativas é registrado à parte e não entra no consumo.
    expect(m.timing.attempts[1]!.idle_before_s).toBe(46);
    expect(m.timing.first_attempt_wait_s).toBe(18 * 60 + 43);
    expect(m.timing.result_wait_s).toBe(36 * 60 + 1);
    expect(m.counts).toEqual({ success: 2, failure: 2 });
  });

  it("execução cancelada: o tempo consumido até o cancelamento conta e a conclusão é preservada", () => {
    const m = computeRunMetrics({ ...load(37541547598) });
    expect(m.run.conclusion).toBe("cancelled");
    expect(m.counts.cancelled).toBe(1);
    expect(m.jobs.find((j) => j.name === "check")!.duration_s).toBe(13 * 60 + 8);
  });

  it("sucesso em uma tentativa: sem reexecução e etapas com duração", () => {
    const m = computeRunMetrics({ ...load(37551157123) });
    expect(m.run.attempts).toBe(1);
    expect(m.consumption.reruns_raw_s).toBe(0);
    expect(m.jobs.find((j) => j.name === "check")!.steps.find((s) => s.name === "Run npm run test:integration")!.duration_s).toBe(422);
    expect(renderMarkdown(m)).toContain("Consumo/custo oficial | indisponível");
  });

  it("job copiado sem o original na listagem é atribuído à tentativa anterior e não tem espera de início", () => {
    const fx = load(37552886769);
    const only2 = dedupeExecutions([[], fx.jobsByAttempt[1]!]);
    const security = only2.find((j) => j.name === "security")!;
    expect(security.attempt).toBe(1);
    expect(security.start_delay_s).toBeNull();
  });

  it("job cancelado sem runner (incidente do Actions) não é consumo; o tempo fica à parte", () => {
    // Forma real do run 37371742988, tentativa 1 (05/10/2026): 0 etapas, runner vazio, cancelado após 15 min na fila.
    const queued = { id: 9, name: "check", run_attempt: 1, status: "completed", conclusion: "cancelled", created_at: "2026-10-05T20:45:45Z", started_at: "2026-10-05T20:45:45Z", completed_at: "2026-10-05T21:00:46Z", runner_name: "", labels: ["ubuntu-latest"] };
    const [e] = dedupeExecutions([[queued]]);
    expect(e).toMatchObject({ duration_s: 0, rounded_min: 0, without_runner_s: 901 });
  });

  it("job pulado ou em andamento não soma minutos", () => {
    const base = { labels: [], runner_name: null, created_at: "2026-10-07T00:00:00Z" };
    const execs = dedupeExecutions([
      [
        { ...base, id: 1, name: "a", run_attempt: 1, status: "completed", conclusion: "skipped", started_at: "2026-10-07T00:00:00Z", completed_at: "2026-10-07T00:00:00Z" },
        { ...base, id: 2, name: "b", run_attempt: 1, status: "in_progress", conclusion: null, started_at: "2026-10-07T00:00:05Z", completed_at: null },
      ],
    ]);
    expect(execs.map((e) => e.duration_s)).toEqual([0, 0]);
  });

  it("arredondamento, mediana e p95 respeitam a amostra mínima", () => {
    expect([0, 1, 60, 61].map(roundedMinutes)).toEqual([0, 1, 1, 2]);
    expect(median([3, 1, 2])).toBe(2);
    expect(percentile([...Array(20).keys()].map((n) => n + 1), 95)).toBe(19);
    const m = computeRunMetrics({ ...load(37551157123) });
    const small = summarizeHistory([m, m, m, m]);
    expect(small.result_wait_s.median).toBeNull();
    const five = summarizeHistory([m, m, m, m, m]);
    expect(five.result_wait_s.median).toBe(m.timing.result_wait_s);
    expect(five.result_wait_s.p95).toBeNull();
  });
});
