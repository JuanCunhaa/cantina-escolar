import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as buildMain } from "../../../scripts/ci/build-manifest.ts";
import { extractFailures, status } from "../../../scripts/ci/ci-status.ts";
import { checkGate, main as sonarMain, parseReportTask, safeReportPath, SONAR_URL } from "../../../scripts/ci/sonar-gate.ts";
import { serverArgs, startServer } from "../../../scripts/ci/timed-server.ts";
import { E2E_BUILD_ENV } from "../../helpers/e2e-env.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-extra-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("Quality Gate efetivo do SonarQube Cloud", () => {
  const writeTask = (serverUrl = SONAR_URL, ceTaskId = "AXy-1") => {
    mkdirSync(join(dir, ".scannerwork"), { recursive: true });
    writeFileSync(join(dir, ".scannerwork/report-task.txt"), `projectKey=k\nserverUrl=${serverUrl}\nceTaskId=${ceTaskId}\ndashboardUrl=${SONAR_URL}/dashboard?id=k\n`);
  };
  /** fetch falso: tarefa PENDING -> SUCCESS e depois o status do gate pedido. */
  const fakeFetch = (gate: string, taskStatuses = ["PENDING", "SUCCESS"]) => {
    const urls: string[] = [];
    let i = 0;
    const impl = (async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname === "/api/ce/task") return { ok: true, json: async () => ({ task: { status: taskStatuses[Math.min(i++, taskStatuses.length - 1)], analysisId: "an-1", errorMessage: "erro" } }) } as Response;
      return { ok: true, json: async () => ({ projectStatus: { status: gate, conditions: [{ status: "ERROR", metricKey: "new_coverage", actualValue: "43.6", comparator: "LT", errorThreshold: "80" }] } }) } as Response;
    }) as typeof fetch;
    return { impl, urls };
  };
  const deps = (impl: typeof fetch) => ({ fetch: impl, sleep: async () => {}, cwd: dir, log: () => {} });

  it("só OK aprova; ERROR e NONE reprovam; destino é sempre o SonarQube Cloud", async () => {
    writeTask();
    const ok = fakeFetch("OK");
    expect(await sonarMain([".scannerwork/report-task.txt"], { SONAR_TOKEN: "t" }, deps(ok.impl))).toBe(0);
    expect(ok.urls.every((u) => u.startsWith(`${SONAR_URL}/api/`))).toBe(true);
    expect(ok.urls[0]).toBe(`${SONAR_URL}/api/ce/task?id=AXy-1`);
    const err = fakeFetch("ERROR");
    const result = await checkGate(".scannerwork/report-task.txt", "t", { GITHUB_STEP_SUMMARY: join(dir, "s.md") }, deps(err.impl));
    expect(result.status).toBe("ERROR");
    expect(readFileSync(join(dir, "s.md"), "utf8")).toContain("- ERROR new_coverage: 43.6 (LT 80)");
    const none = fakeFetch("NONE");
    expect((await checkGate(".scannerwork/report-task.txt", "t", {}, deps(none.impl))).markdown).toContain("não conta como aprovação");
    expect(await sonarMain([".scannerwork/report-task.txt"], { SONAR_TOKEN: "t" }, deps(none.impl))).toBe(1);
  });

  it("recusa: token ausente, relatório ausente/fora do diretório, servidor estranho, processamento falho ou sem fim", async () => {
    const logs: string[] = [];
    const d = { ...deps(fakeFetch("OK").impl), log: (t: string) => logs.push(t) };
    expect(await sonarMain([], {}, d)).toBe(1);
    expect(await sonarMain([".scannerwork/report-task.txt"], { SONAR_TOKEN: "t" }, d)).toBe(1);
    expect(logs.join(" ")).toContain("report-task.txt ausente");
    expect(() => safeReportPath("../fora/report-task.txt", dir)).toThrow("caminho do relatório recusado");
    expect(() => safeReportPath("outro.txt", dir)).toThrow();
    writeTask("https://evil.example");
    await expect(checkGate(".scannerwork/report-task.txt", "t", {}, d)).rejects.toThrow("não é o SonarQube Cloud");
    writeTask(SONAR_URL, "id inválido");
    await expect(checkGate(".scannerwork/report-task.txt", "t", {}, d)).rejects.toThrow("ceTaskId inválido");
    writeTask();
    await expect(checkGate(".scannerwork/report-task.txt", "t", {}, deps(fakeFetch("OK", ["FAILED"]).impl))).rejects.toThrow("processamento da análise FAILED");
    await expect(checkGate(".scannerwork/report-task.txt", "t", {}, { ...deps(fakeFetch("OK", ["PENDING"]).impl), attempts: 2 })).rejects.toThrow("não terminou no prazo");
    const http = (async () => ({ ok: false, status: 401 }) as Response) as typeof fetch;
    await expect(checkGate(".scannerwork/report-task.txt", "t", {}, deps(http))).rejects.toThrow("SonarQube Cloud 401");
    expect(parseReportTask("a=1\nsem-igual\nb=x=y")).toEqual({ a: "1", b: "x=y" });
  });
});

describe("ci:status para a IA (gh falso)", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/run-37552886769.json", import.meta.url), "utf8"));
  const log = [
    "2026-10-07T01:12:07.7Z   ✘  59 tests/e2e/students.spec.ts:25:1 › administração (11.3s)",
    "2026-10-07T01:12:48.7Z     Error: expect(locator).toBeVisible() failed",
    "2026-10-07T01:12:48.7Z     Locator: getByTestId('units-class')",
    "2026-10-07T01:12:48.7Z     ##[group]Run bash x",
    "2026-10-07T01:12:48.7Z ##[error]Process completed with exit code 1.",
  ].join("\n");
  const gh = (...args: string[]) => {
    const key = args.join(" ");
    if (key.startsWith("repo view")) return "o/r\n";
    if (key.startsWith("pr view")) return JSON.stringify({ headRefName: "feat/x" });
    if (key.startsWith("run list")) return JSON.stringify([{ databaseId: fixture.run.id }]);
    if (args[0] === "api" && args[1] === "--allow-escape-sequences") {
      if (args[2]!.includes(String(fixture.jobsByAttempt[1].find((j: { name: string }) => j.name === "check").id))) return log;
      throw new Error("sem log");
    }
    const path = args[1]!.split("?")[0]!;
    const base = `repos/o/r/actions/runs/${fixture.run.id}`;
    if (path === base) return JSON.stringify(fixture.run);
    if (path === `${base}/artifacts`) return JSON.stringify({ artifacts: fixture.artifacts, total_count: fixture.artifacts.length });
    if (path === `repos/o/r/commits/${fixture.run.head_sha}/status`) return JSON.stringify({ statuses: [] });
    const m = path.match(/attempts\/(\d+)(\/jobs)?$/);
    if (m) return JSON.stringify(m[2] ? { jobs: fixture.jobsByAttempt[Number(m[1]) - 1], total_count: 3 } : fixture.attempts[Number(m[1]) - 1]);
    throw new Error(`gh inesperado: ${key}`);
  };

  it("mostra job/etapa, teste:linha, erro principal, log completo salvo, reprodução e reexecução do job falho", async () => {
    // Metadados pela API (fetcher com as fixtures); o gh falso só responde repositório, PR, runs e logs.
    const fetcher = async (path: string) => JSON.parse(gh("api", path));
    const text = await status(["--pr", "12"], { gh, logDir: join(dir, "logs"), fetcher });
    expect(text).toContain("tentativas 2");
    expect(text).toContain("- check [tentativa 2] failure 988s · etapa: npm run test:e2e");
    expect(text).toContain("✘  59 tests/e2e/students.spec.ts:25:1");
    expect(text).toContain("Error: expect(locator).toBeVisible() failed");
    expect(text).not.toContain("##[group]Run bash x");
    expect(text).toMatch(/reexecutar só este job \(mesmo commit\): gh run rerun 37552886769 --job \d+/);
    expect(text).toContain("gh run download 37552886769 -n e2e-evidencias-37552886769-2");
    expect(readdirSync(join(dir, "logs"))).toHaveLength(1);
    await expect(status(["--run", "abc"], { gh, logDir: dir, fetcher })).rejects.toThrow("id de run inválido");
  });

  it("extrai falhas sem cores e sem duplicar", () => {
    expect(extractFailures("\u001b[31m  ✘  1 tests/a.spec.ts:1:1 › x\u001b[39m\n  ✘  1 tests/a.spec.ts:1:1 › x\nFAIL  tests/unit/b.test.ts")).toEqual(["✘  1 tests/a.spec.ts:1:1 › x", "FAIL  tests/unit/b.test.ts"]);
  });
});

describe("servidor do e2e com tempo até ficar pronto", () => {
  it("modo dev/start usa o mesmo comando do Next e registra o tempo até 'Ready'", async () => {
    expect(serverArgs("dev")).toEqual(["dev", "--webpack", "-p", "3100"]);
    expect(serverArgs("start")).toEqual(["start", "-p", "3100"]);
    expect(serverArgs("outro")).toBeNull();
    const fakeNext = join(dir, "fake-next.mjs");
    writeFileSync(fakeNext, 'process.stderr.write("aviso\\n"); process.stdout.write("  ✓ Ready in 93ms\\n"); setTimeout(() => process.exit(0), 50);\n');
    const sink = { write: () => true } as unknown as NodeJS.WritableStream;
    const child = startServer("start", { nextBin: fakeNext, outDir: join(dir, "out"), stdout: sink, stderr: sink });
    await new Promise((resolve) => child.on("exit", resolve));
    const [file] = readdirSync(join(dir, "out"));
    expect(file).toMatch(/^server-ready-start-\d+\.json$/);
    expect(JSON.parse(readFileSync(join(dir, "out", file!), "utf8"))).toMatchObject({ mode: "start" });
  });
});

describe("build-manifest: comandos env e uso", () => {
  it("env imprime o ambiente hermético; uso inválido devolve 2; pack/verify sem argumentos reprovam", () => {
    const lines: string[] = [];
    expect(buildMain(["env"], { root: dir, env: {}, log: (t) => lines.push(t) })).toBe(0);
    expect(lines).toEqual(Object.entries(E2E_BUILD_ENV).map(([k, v]) => `${k}=${v}`));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(buildMain(["outro"], { root: dir, env: {} })).toBe(2);
    expect(buildMain(["pack"], { root: dir, env: {} })).toBe(1);
    expect(buildMain(["verify"], { root: dir, env: {} })).toBe(1);
    expect(buildMain(["verify", "--dir", "nada"], { root: dir, env: {} })).toBe(1);
  });
});

describe("saída de texto sem forjar linhas", () => {
  it("escreve cada linha isolada, sem CR embutido", async () => {
    const { writeLines } = await import("../../../scripts/ci/lib/output.ts");
    const lines: string[] = [];
    writeLines("a\r\nb\nc", (l) => lines.push(l));
    expect(lines).toEqual(["a\n", "b\n", "c\n"]);
  });
});
