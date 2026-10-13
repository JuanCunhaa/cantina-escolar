import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGate, latestSummaries, readSummaries, RULES, type Needs } from "../../../scripts/ci/gate.ts";
import type { SuiteSummary } from "../../../scripts/ci/test-report.ts";

const SHA = "f".repeat(40);
const suite = (name: string, over: Partial<SuiteSummary> = {}): SuiteSummary => ({
  schema: "cantina-ci-suite/1",
  suite: name,
  kind: name.startsWith("e2e") ? "playwright" : "vitest",
  ok: true,
  problems: [],
  total: 36,
  passed: 36,
  failed: 0,
  skipped: 0,
  flaky: 0,
  expected: /-g\d$/.test(name) ? 36 : null,
  expected_total: /-g\d$/.test(name) ? 72 : null,
  duration_s: 1,
  failures: [],
  attempt: 1,
  sha: SHA,
  log_url: null,
  ...over,
});
const allSuites = () => Object.fromEntries(RULES.full.suites.map((s) => [s, suite(s)]));
const fullNeeds = (over: Partial<Needs> = {}): Needs => ({
  changes: { result: "success", outputs: { mode: "full", trust: "trusted" } },
  fast: { result: "success" },
  backend: { result: "success" },
  build: { result: "success" },
  e2e: { result: "success" },
  security: { result: "success" },
  appsec: { result: "success" },
  quality: { result: "success" },
  ...over,
});

describe("gate final (check)", () => {
  it("fluxo completo aprovado só com todos os jobs em success e suítes íntegras", () => {
    expect(evaluateGate(fullNeeds(), allSuites(), SHA)).toMatchObject({ ok: true, problems: [] });
  });

  it.each(["failure", "cancelled", "skipped"])("job exigido em %s reprova", (result) => {
    for (const job of RULES.full.success) {
      const r = evaluateGate(fullNeeds({ [job]: { result, outputs: job === "changes" ? { mode: "full", trust: "trusted" } : undefined } }), allSuites(), SHA);
      expect(r.ok, job).toBe(false);
      expect(r.problems.join(" "), job).toContain(`${job}: ${result} (esperado success)`);
    }
  });

  it("credencial ou relatório ausente nunca vira aprovação: suíte sem resumo reprova", () => {
    const suites = allSuites();
    delete suites["integration-g2"];
    expect(evaluateGate(fullNeeds(), suites, SHA).problems).toEqual(["resumo da suíte integration-g2 ausente"]);
  });

  it("resumo com skip, contagem divergente ou de outro commit reprova", () => {
    expect(evaluateGate(fullNeeds(), { ...allSuites(), unit: suite("unit", { ok: false, problems: ["2 teste(s) pulados"] }) }, SHA).ok).toBe(false);
    expect(evaluateGate(fullNeeds(), { ...allSuites(), "e2e-g2": suite("e2e-g2", { total: 35, passed: 35 }) }, SHA).problems).toEqual(["e2e: g1 36 + g2 35 ≠ suíte listada 72"]);
    expect(evaluateGate(fullNeeds(), { ...allSuites(), "integration-g1": suite("integration-g1", { total: 35, passed: 35 }) }, SHA).problems).toEqual(["integration: g1 35 + g2 36 ≠ suíte listada 72"]);
    expect(evaluateGate(fullNeeds(), { ...allSuites(), rules: suite("rules", { sha: "0".repeat(40) }) }, SHA).problems[0]).toContain("de outro commit");
  });

  it("contagem e2e listada ausente ou divergente entre os grupos reprova", () => {
    expect(evaluateGate(fullNeeds(), { ...allSuites(), "e2e-g1": suite("e2e-g1", { expected_total: null }) }, SHA).problems[0]).toContain("contagem da suíte e2e listada ausente ou divergente");
    expect(evaluateGate(fullNeeds(), { ...allSuites(), "e2e-g2": suite("e2e-g2", { expected_total: 73 }) }, SHA).problems[0]).toContain("(72 / 73)");
    expect(evaluateGate(fullNeeds(), { ...allSuites(), "integration-g2": suite("integration-g2", { expected_total: null }) }, SHA).problems[0]).toContain("contagem da suíte integration listada ausente ou divergente");
  });

  it("só documentação: exige skipped exatamente nos jobs da aplicação", () => {
    const docs: Needs = {
      changes: { result: "success", outputs: { mode: "docs", trust: "trusted" } },
      fast: { result: "success" },
      security: { result: "success" },
      backend: { result: "skipped" },
      build: { result: "skipped" },
      e2e: { result: "skipped" },
      appsec: { result: "skipped" },
      quality: { result: "skipped" },
    };
    expect(evaluateGate(docs, {}, SHA).ok).toBe(true);
    expect(evaluateGate({ ...docs, e2e: { result: "failure" } }, {}, SHA).problems).toEqual(["e2e: failure (esperado skipped)"]);
    expect(evaluateGate({ ...docs, security: { result: "skipped" } }, {}, SHA).problems).toEqual(["security: skipped (esperado success)"]);
  });

  const externalNeeds = (over: Partial<Needs> = {}): Needs =>
    fullNeeds({ changes: { result: "success", outputs: { mode: "full", trust: "external" } }, appsec: { result: "skipped" }, quality: { result: "skipped" }, ...over });

  it("PR externo: testes e scanners sem segredo obrigatórios; appsec e quality exigidos como skipped", () => {
    expect(evaluateGate(externalNeeds(), allSuites(), SHA)).toMatchObject({ ok: true, problems: [] });
    expect(evaluateGate(externalNeeds({ appsec: { result: "success" } }), allSuites(), SHA).problems).toEqual(["appsec: success (esperado skipped)"]);
    expect(evaluateGate(externalNeeds({ quality: { result: "success" } }), allSuites(), SHA).problems).toEqual(["quality: success (esperado skipped)"]);
    expect(evaluateGate(externalNeeds({ security: { result: "failure" } }), allSuites(), SHA).problems).toEqual(["security: failure (esperado success)"]);
    expect(evaluateGate(externalNeeds({ e2e: { result: "skipped" } }), allSuites(), SHA).problems).toEqual(["e2e: skipped (esperado success)"]);
    const suites = allSuites();
    delete suites["e2e-g1"];
    expect(evaluateGate(externalNeeds(), suites, SHA).problems).toEqual(["resumo da suíte e2e-g1 ausente"]);
  });

  it("evento confiável nunca aceita appsec ou quality dispensados; confiança ausente ou desconhecida reprova", () => {
    expect(evaluateGate(fullNeeds({ appsec: { result: "skipped" } }), allSuites(), SHA).problems).toEqual(["appsec: skipped (esperado success)"]);
    expect(evaluateGate(fullNeeds({ quality: { result: "skipped" } }), allSuites(), SHA).problems).toEqual(["quality: skipped (esperado success)"]);
    expect(evaluateGate(fullNeeds({ changes: { result: "success", outputs: { mode: "full" } } }), allSuites(), SHA).problems).toEqual(['confiança do evento desconhecida: ""']);
    expect(evaluateGate(fullNeeds({ changes: { result: "success", outputs: { mode: "full", trust: "admin" } } }), allSuites(), SHA).ok).toBe(false);
  });

  it("modo desconhecido, classificação falha e job sem regra reprovam", () => {
    expect(evaluateGate(fullNeeds({ changes: { result: "success", outputs: {} } }), allSuites(), SHA).problems).toEqual(['modo de execução desconhecido: ""']);
    expect(evaluateGate(fullNeeds({ changes: { result: "failure", outputs: { mode: "full", trust: "trusted" } } }), allSuites(), SHA).ok).toBe(false);
    expect(evaluateGate(fullNeeds({ deploy: { result: "success" } }), allSuites(), SHA).problems).toEqual(["job deploy sem regra no gate"]);
  });

  it("reexecução parcial: vale o resumo mais recente de cada suíte e os grupos já aprovados continuam válidos", () => {
    const latest = latestSummaries([
      { attempt: 1, summary: suite("e2e-g1") },
      { attempt: 1, summary: suite("e2e-g2", { ok: false, failed: 1, passed: 35, attempt: 1 }) },
      { attempt: 2, summary: suite("e2e-g2", { attempt: 2 }) },
    ]);
    expect(latest["e2e-g1"]!.attempt).toBe(1);
    expect(latest["e2e-g2"]).toMatchObject({ ok: true, attempt: 2 });
  });

  it("lê os resumos baixados por artefato e ignora arquivo ilegível", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    try {
      mkdirSync(join(dir, "ci-summary-unit-a1"));
      writeFileSync(join(dir, "ci-summary-unit-a1", "summary-unit.json"), JSON.stringify(suite("unit")));
      mkdirSync(join(dir, "ci-summary-rules-a1"));
      writeFileSync(join(dir, "ci-summary-rules-a1", "summary-rules.json"), "{");
      expect(readSummaries(dir).map((s) => s.summary.suite)).toEqual(["unit"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
