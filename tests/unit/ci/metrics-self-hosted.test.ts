import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeRunMetrics, equivalenceKey, runnerOrigin, type ApiAttempt, type ApiJob, type ApiRun } from "../../../scripts/ci/metrics/compute.ts";
import { jobIdOf, parseNeeds } from "../../../scripts/ci/metrics/graph.ts";
import { renderMarkdown } from "../../../scripts/ci/metrics/render.ts";

const OWN = ["self-hosted", "linux", "x64", "cantina-ci"];
const ciYaml = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");

const run: ApiRun = {
  id: 1,
  name: "ci",
  path: ".github/workflows/ci.yml",
  workflow_id: 7,
  event: "pull_request",
  head_branch: "ci/runner-proprio",
  head_sha: "abcdef0123456789",
  html_url: "https://example.test/run/1",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  created_at: "2026-10-10T00:00:00Z",
  run_started_at: "2026-10-10T00:00:00Z",
};
const attempt: ApiAttempt = { run_attempt: 1, run_started_at: "2026-10-10T00:00:00Z", created_at: "2026-10-10T00:00:00Z", status: "completed", conclusion: "success" };

const job = (id: number, name: string, startS: number, endS: number, labels: string[], runner: string): ApiJob => ({
  id,
  name,
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  created_at: "2026-10-10T00:00:00Z",
  started_at: new Date(Date.parse("2026-10-10T00:00:00Z") + startS * 1000).toISOString(),
  completed_at: new Date(Date.parse("2026-10-10T00:00:00Z") + endS * 1000).toISOString(),
  runner_name: runner,
  labels,
});

// Execução serial na máquina própria (uma instância): changes → fast → build → e2e (g1), mais um job hospedado de 90 s.
const mixedJobs = (): ApiJob[] => [
  job(1, "changes", 5, 20, OWN, "cantina-vps-01"),
  job(2, "fast", 20, 200, OWN, "cantina-vps-01"),
  job(3, "build", 200, 380, OWN, "cantina-vps-01"),
  job(4, "e2e (g1)", 380, 620, OWN, "cantina-vps-01"),
  job(5, "security", 0, 90, ["ubuntu-24.04"], "GitHub Actions 1000000001"),
];

describe("grafo needs do workflow", () => {
  it("lê as dependências reais do ci.yml (formas: valor único e lista em colchetes)", () => {
    const graph = parseNeeds(ciYaml);
    expect(graph.changes).toEqual([]);
    expect(graph.fast).toEqual(["changes"]);
    expect(graph.e2e).toEqual(["changes", "build"]);
    expect(graph.quality).toEqual(["changes", "fast", "backend"]);
    expect(graph.check).toEqual(["changes", "fast", "backend", "build", "e2e", "security", "quality"]);
  });

  it("lê a lista em linhas e ignora comentários e outras seções", () => {
    const yaml = ["name: x", "jobs:", "  a:", "    runs-on: x", "  b:", "    needs:", "      - a  # primeiro", "      - c", "    runs-on: x", "  c:", "    needs: [a]", "other:", "  d:", "    needs: [z]"].join("\n");
    expect(parseNeeds(yaml)).toEqual({ a: [], b: ["a", "c"], c: ["a"] });
    expect(parseNeeds("name: sem jobs")).toEqual({});
  });

  it("associa o nome exibido (matriz) ao identificador do job", () => {
    const graph = parseNeeds(ciYaml);
    expect(jobIdOf("e2e (g1)", graph)).toBe("e2e");
    expect(jobIdOf("backend (g2)", graph)).toBe("backend");
    expect(jobIdOf("fast", graph)).toBe("fast");
    expect(jobIdOf("job-desconhecido", graph)).toBeNull();
  });
});

describe("origem do runner", () => {
  it("rótulo self-hosted é máquina própria; os demais são hospedados", () => {
    expect(runnerOrigin({ labels: OWN, runner_name: "cantina-vps-01" })).toBe("self-hosted");
    expect(runnerOrigin({ labels: ["Self-Hosted"], runner_name: "x" })).toBe("self-hosted");
    expect(runnerOrigin({ labels: ["ubuntu-24.04"], runner_name: "GitHub Actions 1000000001" })).toBe("github-hosted");
  });

  it("sem rótulos, o nome do runner decide", () => {
    expect(runnerOrigin({ labels: [], runner_name: "cantina-vps-01" })).toBe("self-hosted");
    expect(runnerOrigin({ labels: [], runner_name: "GitHub Actions 7" })).toBe("github-hosted");
    expect(runnerOrigin({ labels: [], runner_name: null })).toBe("github-hosted");
  });
});

describe("FinOps separa máquina própria de runner hospedado", () => {
  const needs = parseNeeds(ciYaml);

  it("minutos da máquina própria não viram minutos hospedados nem estimativa de cobrança", () => {
    const m = computeRunMetrics({ run, attempts: [attempt], jobsByAttempt: [mixedJobs()], needs });
    expect(m.consumption.self_hosted).toMatchObject({ jobs: 4, raw_s: 15 + 180 + 180 + 240 });
    expect(m.consumption.github_hosted).toEqual({ jobs: 1, raw_s: 90, rounded_estimate_min: 2 });
    expect(m.consumption.runner_raw_s).toBe(705 + 0 + 0);
    expect(m.consumption.rounded_estimate_min).toBe(2);
    expect(m.jobs.find((j) => j.name === "build")).toMatchObject({ runner_origin: "self-hosted", rounded_min: 0 });
    expect(m.jobs.find((j) => j.name === "security")).toMatchObject({ runner_origin: "github-hosted", rounded_min: 2 });
    expect(m.timing.attempts[0]?.rounded_estimate_min).toBe(2);
  });

  it("fila é do job pronto até o início, sem a espera por dependência", () => {
    const m = computeRunMetrics({ run, attempts: [attempt], jobsByAttempt: [mixedJobs()], needs });
    const queue = (name: string) => m.jobs.find((j) => j.name === name)?.queue_s;
    expect(queue("changes")).toBe(5); // sem dependência: criação→início
    expect(queue("fast")).toBe(0); // pronto quando changes terminou (20 s) e começou nesse instante
    expect(queue("build")).toBe(180); // pronto aos 20 s, esperou o runner livre até 200 s
    expect(queue("e2e (g1)")).toBe(0); // dependências terminaram aos 380 s e o runner já estava livre
    // A medida da API (criação→início) continua disponível e inclui a espera pelas dependências.
    expect(m.jobs.find((j) => j.name === "e2e (g1)")?.start_delay_s).toBe(380);
    expect(m.consumption.self_hosted).toMatchObject({ queue_known: true, queue_sum_s: 185, queue_max_s: 180 });
  });

  it("sem o grafo a fila fica indisponível, nunca zero", () => {
    const m = computeRunMetrics({ run, attempts: [attempt], jobsByAttempt: [mixedJobs()] });
    expect(m.jobs.every((j) => j.queue_s === null)).toBe(true);
    expect(m.consumption.self_hosted).toMatchObject({ queue_known: false, queue_sum_s: null, queue_max_s: null });
  });

  it("execuções equivalentes só se comparam dentro da mesma origem", () => {
    const own = computeRunMetrics({ run, attempts: [attempt], jobsByAttempt: [[job(1, "fast", 0, 60, OWN, "cantina-vps-01")]] });
    const hosted = computeRunMetrics({ run, attempts: [attempt], jobsByAttempt: [[job(1, "fast", 0, 60, ["ubuntu-24.04"], "GitHub Actions 1")]] });
    expect(equivalenceKey(own)).not.toBe(equivalenceKey(hosted));
    expect(equivalenceKey(own)).toContain("self-hosted");
  });

  it("o resumo mostra origem, tempo da máquina própria e fila sem chamar de cobrança", () => {
    const text = renderMarkdown(computeRunMetrics({ run, attempts: [attempt], jobsByAttempt: [mixedJobs()], needs }));
    expect(text).toContain("Máquina PRÓPRIA (self-hosted): 4 job(s)");
    expect(text).toContain("Runner HOSPEDADO (GitHub): 1 job(s)");
    expect(text).toContain("Fila na máquina própria (soma / maior) | 3m05s / 3m00s");
    expect(text).toContain("não é minuto hospedado nem cobrança");
    expect(text).toMatch(/\| build \| 1 \| success \| 3m20s \| 3m00s \| 3m00s \| própria \|/);
    expect(text).toMatch(/\| security \| 1 \| success \| 0m00s \| 0m00s \| 1m30s \| hospedado \|/);
  });

  it("sem job em máquina própria o resumo não mostra a linha de fila", () => {
    const text = renderMarkdown(computeRunMetrics({ run, attempts: [attempt], jobsByAttempt: [[job(1, "security", 0, 90, ["ubuntu-24.04"], "GitHub Actions 1")]], needs }));
    expect(text).not.toContain("Fila na máquina própria");
    expect(text).toContain("Máquina PRÓPRIA (self-hosted): 0 job(s)");
  });
});
