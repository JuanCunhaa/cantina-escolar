import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as classifyMain } from "../../../scripts/ci/classify-changes.ts";
import { main as e2eMain, groupCommand } from "../../../scripts/ci/e2e-groups.ts";
import { main as gateMain } from "../../../scripts/ci/gate.ts";
import { bin, npmVersion } from "../../../scripts/ci/lib/bin.ts";
import { main as lcovMain } from "../../../scripts/ci/lcov-merge.ts";
import { main as collectMain } from "../../../scripts/ci/metrics/collect.ts";
import { assertApiPath, ghCliFetcher, paginate, tokenFetcher, type Fetcher } from "../../../scripts/ci/metrics/github.ts";
import { main as referenceMain } from "../../../scripts/ci/reference-sha.ts";
import { main as requireMain } from "../../../scripts/ci/require-config.ts";
import { main as reportMain } from "../../../scripts/ci/test-report.ts";
import { main as validateMain } from "../../../scripts/ci/validate-structured.ts";
import { main as veracodeMain } from "../../../scripts/ci/veracode-report.ts";
import { decide } from "../../../scripts/ci/vercel-ignore.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const R = "o/r";

/** Fetcher falso: responde a API a partir das fixtures reais (paginação de 1 página). */
function fixtureFetcher(extra: Record<string, unknown> = {}): Fetcher & { calls: string[] } {
  const runs = [37552886769, 37551157123, 37541547598].map((id) => fixture(`run-${id}.json`));
  const calls: string[] = [];
  const fetcher = (async (path: string) => {
    calls.push(path);
    const clean = path.split("?")[0]!;
    for (const [prefix, body] of Object.entries(extra)) if (clean === prefix) return body;
    for (const f of runs) {
      const base = `repos/${R}/actions/runs/${f.run.id}`;
      if (clean === base) return f.run;
      if (clean === `${base}/artifacts`) return { artifacts: f.artifacts, total_count: f.artifacts.length };
      const m = clean.match(new RegExp(`^${base}/attempts/(\\d+)(/jobs)?$`));
      if (m) {
        const n = Number(m[1]);
        return m[2] ? { jobs: f.jobsByAttempt[n - 1], total_count: f.jobsByAttempt[n - 1].length } : f.attempts[n - 1];
      }
    }
    throw new Error(`sem fixture para ${path}`);
  }) as Fetcher & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("coletor FinOps (CLI em processo)", () => {
  it("grava JSON + Markdown com histórico, Vercel e consumo do coletor (parcial e anteriores)", async () => {
    const f = fixture("run-37552886769.json");
    const fetcher = fixtureFetcher({
      [`repos/${R}/commits/${f.run.head_sha}/status`]: { statuses: [{ context: "Vercel", state: "success", created_at: "2026-10-07T00:37:35Z", updated_at: "2026-10-07T00:37:35Z" }] },
      [`repos/${R}/actions/workflows/${f.run.workflow_id}/runs`]: { workflow_runs: [{ id: 37551157123 }, { id: 37541547598 }], total_count: 2 },
      [`repos/${R}/actions/runs/999`]: { id: 999, workflow_id: 77, run_attempt: 1 },
      [`repos/${R}/actions/runs/999/jobs`]: { jobs: [{ started_at: new Date(Date.now() - 30_000).toISOString() }], total_count: 1 },
      [`repos/${R}/actions/workflows/77/runs`]: { workflow_runs: [{ id: 999 }, { id: 37541547598 }], total_count: 2 },
    });
    const out = join(dir, "m");
    const code = await collectMain(["--repo", R, "--run", String(f.run.id), "--out", out, "--history", "5", "--collector-run", "999"], { GITHUB_STEP_SUMMARY: join(dir, "summary.md") }, { fetcher });
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(out, "ci-metrics.json"), "utf8"));
    expect(report.vercel).toMatchObject({ available: true, state: "success", duration_s: null });
    expect(report.history.n).toBeGreaterThanOrEqual(1);
    expect(report.collector.partial_duration_s).toBeGreaterThanOrEqual(29);
    expect(report.collector.previous_runs_final.n).toBe(1);
    expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("Histórico de execuções equivalentes");
    expect(readFileSync(join(out, "ci-metrics.md"), "utf8")).toContain("Coletor:");
  });

  it("argumentos inválidos (2) e falha da API (1) não geram relatório", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await collectMain(["--repo", "x", "--run", "abc"], {})).toBe(2);
    expect(await collectMain(["--repo", R, "--run", "1", "--out", join(dir, "z")], {}, { fetcher: async () => Promise.reject(new Error("503")) })).toBe(1);
    expect(existsSync(join(dir, "z"))).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("acesso à API do GitHub", () => {
  it("destino fixo, caminho validado e paginação completa", async () => {
    expect(assertApiPath("/repos/o/r/actions/runs/1/attempts/2/jobs?per_page=100&page=1")).toBe("repos/o/r/actions/runs/1/attempts/2/jobs?per_page=100&page=1");
    expect(() => assertApiPath("https://evil.example/x")).toThrow("caminho de API recusado");
    expect(() => assertApiPath("repos/o/r/../../x")).toThrow();
    const seen: string[] = [];
    const fake = (async (url: string | URL) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ ok: 1 }) } as Response;
    }) as typeof fetch;
    await tokenFetcher("t", fake)("repos/o/r");
    expect(seen).toEqual(["https://api.github.com/repos/o/r"]);
    const failing = (async () => ({ ok: false, status: 403 }) as Response) as typeof fetch;
    await expect(tokenFetcher("t", failing)("repos/o/r")).rejects.toThrow("GitHub API 403 em repos/o/r");
    expect(await ghCliFetcher((args) => JSON.stringify({ args }))("repos/o/r")).toEqual({ args: ["api", "repos/o/r"] });
    const pages = await paginate<number>(async (p) => ({ items: p.endsWith("page=1") ? Array(100).fill(1) : [2], total_count: 101 }), "repos/o/r/x", "items");
    expect(pages).toHaveLength(101);
    await expect(paginate(async () => ({ items: Array(100).fill(1) }), "repos/o/r/x", "items", 2)).rejects.toThrow("Paginação excedeu 2 páginas");
  });

  it("executáveis por caminho fixo no Linux e versão do npm lida do pacote", () => {
    expect(bin("git", "linux", (p) => p === "/usr/bin/git")).toBe("/usr/bin/git");
    expect(bin("gh", "linux", (p) => p === "/usr/local/bin/gh")).toBe("/usr/local/bin/gh");
    expect(bin("tar", "win32")).toBe("tar");
    expect(() => bin("tar", "linux", () => false)).toThrow("tar não encontrado");
    expect(npmVersion("/x/bin/node", "linux", () => false)).toBeNull();
    expect(typeof npmVersion()).toMatch(/string|object/);
  });
});

describe("gate (CLI em processo)", () => {
  const needsDocs = { changes: { result: "success", outputs: { mode: "docs" } }, fast: { result: "success" }, security: { result: "success" }, backend: { result: "skipped" }, build: { result: "skipped" }, e2e: { result: "skipped" }, "semgrep-appsec": { result: "skipped" }, quality: { result: "skipped" } };
  const silent = () => {};

  it("aprova o modo docs e grava o resultado", async () => {
    expect(await gateMain(["--summaries", "nada"], { NEEDS: JSON.stringify(needsDocs) }, { root: dir, stdout: silent })).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "ci-results/gate.json"), "utf8"))).toMatchObject({ ok: true, mode: "docs" });
  });

  it("reprova e lista etapas com falha pela API; NEEDS ausente reprova", async () => {
    let text = "";
    const fetcher: Fetcher = async () => ({ jobs: [{ name: "e2e (g1)", conclusion: "failure", html_url: "u", steps: [{ name: "e2e g1", conclusion: "failure" }] }, { name: "build", conclusion: "cancelled", html_url: null, steps: [] }], total_count: 2 });
    const failing = { ...needsDocs, e2e: { result: "failure" } };
    expect(await gateMain(["--repo", R, "--run", "1", "--attempt", "1"], { NEEDS: JSON.stringify(failing), GITHUB_STEP_SUMMARY: join(dir, "s.md") }, { root: dir, fetcher, stdout: (t) => (text += t) })).toBe(1);
    expect(text).toContain("**e2e (g1)** › e2e g1 — [log](u)");
    expect(text).toContain("**build** › (job cancelled)");
    const broken: Fetcher = async () => Promise.reject(new Error("api fora"));
    expect(await gateMain(["--repo", R, "--run", "1", "--attempt", "1"], { NEEDS: JSON.stringify(failing) }, { root: dir, fetcher: broken, stdout: silent })).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "ci-results/gate.json"), "utf8")).problems.join(" ")).toContain("não foi possível listar as etapas");
    expect(await gateMain([], {}, { root: dir, stdout: silent })).toBe(1);
  });
});

describe("resumo de suíte, LCOV, Veracode e configuração (CLIs em processo)", () => {
  const silent = () => {};

  it("test-report: suíte verde grava resumo ok; uso inválido devolve 2", () => {
    writeFileSync(join(dir, "v.json"), JSON.stringify({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [] }));
    expect(reportMain(["vitest", "v.json", "--suite", "unit", "--log-url", "L"], { GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "s", GITHUB_STEP_SUMMARY: join(dir, "s.md") }, { root: dir, stdout: silent })).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "ci-results/summary-unit.json"), "utf8"))).toMatchObject({ ok: true, attempt: 2, sha: "s", log_url: "L" });
    writeFileSync(join(dir, "p.json"), JSON.stringify(fixture("playwright-report.json")));
    expect(reportMain(["playwright", "p.json", "--suite", "e2e-g1", "--expected", "3", "--expected-total", "6"], {}, { root: dir, stdout: silent })).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "ci-results/summary-e2e-g1.json"), "utf8"))).toMatchObject({ expected: 3, expected_total: 6, ok: false });
    expect(reportMain(["playwright", "p.json", "--suite", "x", "--expected", "abc"], {}, { root: dir, stdout: silent })).toBe(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(reportMain(["junit", "p.json"], {}, { root: dir, stdout: silent })).toBe(2);
    vi.restoreAllMocks();
  });

  it("lcov-merge: mescla, grava resumo; ausente/vazio reprova; uso inválido devolve 2", () => {
    writeFileSync(join(dir, "a.info"), "SF:src/a.ts\nDA:1,1\nend_of_record\n");
    writeFileSync(join(dir, "b.info"), "SF:src/a.ts\nDA:1,2\nDA:2,0\nend_of_record\n");
    const out = join(dir, "merged/lcov.info");
    expect(lcovMain(["--out", out, `unit=${join(dir, "a.info")}`, `integration=${join(dir, "b.info")}`], { GITHUB_STEP_SUMMARY: join(dir, "s.md") }, silent)).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("DA:1,3\nDA:2,0\nLF:2\nLH:1");
    expect(JSON.parse(readFileSync(join(dir, "merged/coverage-summary.json"), "utf8")).merged).toEqual({ files: 1, lines: 2, lines_hit: 1, line_rate: 50 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(dir, "vazio.info"), "");
    expect(lcovMain(["--out", out, `unit=${join(dir, "nao.info")}`, `x=${join(dir, "vazio.info")}`], {}, silent)).toBe(1);
    expect(lcovMain(["--out", out], {}, silent)).toBe(2);
    vi.restoreAllMocks();
  });

  it("veracode-report: SAST e SCA avaliados localmente; relatório ausente reprova", () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      writeFileSync("r.json", JSON.stringify({ scan_status: "SUCCESS", findings: [{ severity: 3 }], modules: ["m"], message: "ok" }));
      expect(veracodeMain(["sast", "r.json"], { GITHUB_STEP_SUMMARY: join(dir, "s.md") }, silent)).toBe(0);
      writeFileSync("sca.json", JSON.stringify({ records: [{ libraries: [{ coordinate1: "a", versions: [{ version: "1" }] }], vulnerabilities: [] }] }));
      writeFileSync("ls.json", JSON.stringify({ dependencies: { a: { version: "1" } } }));
      expect(veracodeMain(["sca", "sca.json", "ls.json"], {}, silent)).toBe(0);
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(veracodeMain(["sast", "nao.json"], {}, silent)).toBe(1);
      expect(veracodeMain(["dast"], {}, silent)).toBe(2);
    } finally {
      process.chdir(cwd);
      vi.restoreAllMocks();
    }
  });

  it("require-config: recusa com mensagem e resumo; presente passa; uso inválido devolve 2", () => {
    let text = "";
    expect(requireMain(["Sonar", "SONAR_TOKEN"], { GITHUB_STEP_SUMMARY: join(dir, "s.md") }, (t) => (text += t))).toBe(1);
    expect(text).toContain("::error::Sonar: configuração externa ausente ou não suportada (SONAR_TOKEN ausente)");
    expect(readFileSync(join(dir, "s.md"), "utf8")).toContain("REPROVADO");
    expect(requireMain(["Sonar", "SONAR_TOKEN"], { SONAR_TOKEN: "x" }, silent)).toBe(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(requireMain(["Sonar", "minusculo"], {}, silent)).toBe(2);
    vi.restoreAllMocks();
  });
});

describe("classificação, referência, Vercel e JSON estruturado (CLIs em processo)", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commit = (file: string, content: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), content);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", file);
    return git("rev-parse", "HEAD");
  };

  it("classify grava modo e resumo; vercel decide 0/1; validate aponta JSON inválido", () => {
    git("init", "-q");
    const base = commit("a.json", "{}");
    const docs = commit("PROGRESS.md", "x");
    const logs: string[] = [];
    const output = join(dir, "out.txt");
    expect(classifyMain(["--base", base, "--head", docs], { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, "s.md") }, { cwd: dir, log: (t) => logs.push(t) })).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("mode=docs");
    expect(logs[0]).toContain("modo=docs");
    expect(classifyMain(["--base", "--x", "--head", docs], {}, { cwd: dir, log: () => {} })).toBe(0);
    expect(decide({ VERCEL_GIT_PREVIOUS_SHA: base, VERCEL_GIT_COMMIT_SHA: docs }, { cwd: dir, log: () => {} })).toBe(0);
    expect(decide({ VERCEL_GIT_COMMIT_SHA: docs }, { cwd: dir, log: () => {} })).toBe(1);
    expect(validateMain({ cwd: dir, log: () => {} })).toBe(0);
    commit("b.json", "{quebrado");
    const out: string[] = [];
    expect(validateMain({ cwd: dir, log: (t) => out.push(t) })).toBe(1);
    expect(out[0]).toContain("b.json");
  });

  it("referência: grava base validada; falha da API vira fluxo completo", async () => {
    const output = join(dir, "o.txt");
    const sha = "c".repeat(40);
    const fetcher: Fetcher = async () => ({ workflow_runs: [{ id: 5, head_sha: sha, conclusion: "success", status: "completed" }] });
    await referenceMain({ GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: R, GITHUB_WORKFLOW_REF: "o/r/.github/workflows/ci.yml@refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_RUN_ID: "9", GITHUB_OUTPUT: output }, { fetcher, log: () => {} });
    expect(readFileSync(output, "utf8")).toBe(`base=${sha}\n`);
    const logs: string[] = [];
    await referenceMain({ GITHUB_EVENT_NAME: "push", GITHUB_REPOSITORY: R, GITHUB_WORKFLOW_REF: "o/r/.github/workflows/ci.yml@refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_OUTPUT: output }, { fetcher: async () => Promise.reject(new Error("x")), log: (t) => logs.push(t) });
    expect(readFileSync(output, "utf8")).toBe(`base=${sha}\nbase=\n`);
    expect(logs[0]).toContain("(nenhuma — fluxo completo)");
  });
});

describe("grupos e2e (CLI em processo)", () => {
  it("verify --list grava contagens e saídas; união divergente reprova; run repassa o grupo", () => {
    const output = join(dir, "o.txt");
    const logs: string[] = [];
    const list = (group?: string) => (group === "g1" ? ["a"] : group === "g2" ? ["b"] : ["a", "b"]);
    expect(e2eMain(["verify", "--list"], { GITHUB_OUTPUT: output }, { list, log: (t) => logs.push(t), root: "." })).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("expected_total=2\nexpected_g1=1\nexpected_g2=1\n");
    expect(e2eMain(["verify", "--list"], {}, { list: (g?: string) => (g ? ["a"] : ["a", "b"]), log: () => {} })).toBe(1);
    let received: { args: string[]; group?: string } | null = null;
    expect(e2eMain(["run", "g2"], {}, { run: (args, env) => ((received = { args, group: env.E2E_GROUP }), 7), log: () => {} })).toBe(7);
    expect(received).toEqual({ args: groupCommand(), group: "g2" });
    expect(e2eMain(["run", "g9"], {}, { log: () => {} })).toBe(2);
    rmSync("ci-results/e2e-expected.json", { force: true });
  });
});
