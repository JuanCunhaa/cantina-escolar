import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPartition } from "../../../scripts/ci/e2e-groups.ts";
import { loadIntegrationGroups, main, requiredFiles } from "../../../scripts/ci/integration-groups.ts";

describe("partição da suíte de integração em grupos", () => {
  it("a partição versionada cobre exatamente os arquivos atuais e o Rules está num grupo existente", () => {
    const config = loadIntegrationGroups();
    expect(verifyPartition({ groups: config.groups }, requiredFiles())).toEqual([]);
    expect(Object.keys(config.groups)).toEqual(["g1", "g2"]);
    expect(config.groups[config.rules]).toBeDefined();
  });

  it("verify --list: união exata por teste, contagens e grupo do Rules no GITHUB_OUTPUT; divergência reprova sem gravar", () => {
    const { groups, rules } = loadIntegrationGroups();
    const dir = mkdtempSync(join(tmpdir(), "integration-groups-"));
    try {
      const output = join(dir, "out");
      const list = (g?: string) => (g ? groups[g]!.map((f) => `tests/integration/${f}:1 › t#0`) : Object.values(groups).flat().map((f) => `tests/integration/${f}:1 › t#0`));
      expect(main(["verify", "--list"], { GITHUB_OUTPUT: output }, { list, log: () => {} })).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`expected_total=${Object.values(groups).flat().length}\nexpected_g1=${groups.g1!.length}\nexpected_g2=${groups.g2!.length}\nrules_group=${rules}\n`);
      const logs: string[] = [];
      const missing = join(dir, "missing");
      expect(main(["verify", "--list"], { GITHUB_OUTPUT: missing }, { list: (g?: string) => (g === "g1" ? ["a"] : g ? [] : ["a", "b"]), log: (t) => logs.push(t) })).toBe(1);
      expect(logs.join("\n")).toContain("teste da suíte fora dos grupos: b");
      expect(() => readFileSync(missing)).toThrow();
      expect(main(["outro"], {}, { log: () => {} })).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
