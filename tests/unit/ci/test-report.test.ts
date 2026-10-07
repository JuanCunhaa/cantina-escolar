import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, mainError, summarizePlaywright, summarizeVitest } from "../../../scripts/ci/test-report.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("resumo de suíte para a IA e para o gate", () => {
  it("Playwright: arquivo:linha, título e erro principal sem cores; skip e falha reprovam", () => {
    const s = summarizePlaywright(fixture("playwright-report.json"), "e2e-g1");
    expect({ total: s.total, passed: s.passed, failed: s.failed, skipped: s.skipped }).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(s.failures[0]).toMatchObject({ file: "sample.spec.ts", line: 4, title: "grupo › falha com erro principal" });
    expect(s.failures[0]!.error).toContain("Error: valor do saldo");
    expect(s.failures[0]!.error).toContain("Expected: 3");
    expect(s.failures[0]!.error).not.toMatch(/\u001b/);
    expect(s.failures[0]!.attachments[0]).toContain("error-context.md");
    expect(evaluate(s, 3).problems).toEqual(["1 teste(s) falharam", "1 teste(s) pulados: suíte obrigatória não admite skip"]);
  });

  it("contagem executada diferente da listada reprova mesmo com tudo verde", () => {
    const green = { ...summarizePlaywright({ suites: [] }, "x"), total: 35, passed: 35 };
    expect(evaluate(green, 36)).toEqual({ ok: false, problems: ["executados 35 ≠ listados 36"] });
    expect(evaluate(green, 35).ok).toBe(true);
  });

  it("suíte vazia e erro global (fora de teste) reprovam", () => {
    expect(evaluate(summarizePlaywright({ suites: [] }, "x"), null).problems).toEqual(["nenhum teste executado"]);
    const withError = summarizePlaywright({ ...fixture("playwright-report.json"), errors: [{ message: "Error: Timed out waiting 120000ms from config.webServer." }] }, "x");
    expect(evaluate(withError, null).problems).toContain("erro fora de teste: Error: Timed out waiting 120000ms from config.webServer.");
  });

  it("Vitest: falha de asserção e arquivo que não carregou", () => {
    const s = summarizeVitest(
      {
        numTotalTests: 2,
        numPassedTests: 1,
        numFailedTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
        startTime: 1000,
        testResults: [
          { name: "/w/tests/integration/a.test.ts", status: "failed", endTime: 5000, assertionResults: [{ fullName: "a falha", status: "failed", failureMessages: ["AssertionError: x\n    at y"] }, { fullName: "a ok", status: "passed" }] },
          { name: "/w/tests/integration/b.test.ts", status: "failed", message: "Error: Cannot find module", assertionResults: [] },
        ],
      },
      "integration",
      "/w",
    );
    expect(s.failures).toEqual([{ file: "tests/integration/a.test.ts", line: null, title: "a falha", error: "AssertionError: x\n    at y", attachments: [] }]);
    expect(evaluate(s, null).problems).toEqual(["1 teste(s) falharam", "erro fora de teste: tests/integration/b.test.ts: Error: Cannot find module"]);
    expect(s.duration_s).toBe(4);
  });

  it("CLI: relatório ausente nunca vira sucesso", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    try {
      let status = 0;
      try {
        execFileSync(process.execPath, [join(process.cwd(), "scripts/ci/test-report.ts"), "playwright", "nao-existe.json", "--suite", "e2e-g2", "--expected", "36"], { cwd: dir, stdio: "pipe", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
      } catch (error) {
        status = (error as { status: number }).status;
      }
      expect(status).toBe(1);
      const summary = JSON.parse(readFileSync(join(dir, "ci-results/summary-e2e-g2.json"), "utf8"));
      expect(summary.ok).toBe(false);
      expect(summary.problems).toContain("erro fora de teste: relatório ausente: nao-existe.json");
      writeFileSync(join(dir, "ruim.json"), "{");
      expect(() => execFileSync(process.execPath, [join(process.cwd(), "scripts/ci/test-report.ts"), "vitest", "ruim.json", "--suite", "unit"], { cwd: dir, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("erro principal limita linhas sem esconder a primeira causa", () => {
    expect(mainError("\n\nTimeoutError: x\n1\n2\n3\n4\n5\n6\n7")).toBe("TimeoutError: x\n1\n2\n3\n4\n5");
  });
});
