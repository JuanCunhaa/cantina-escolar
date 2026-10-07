import { describe, expect, it } from "vitest";
import { mergeCoverage, parseLcov, serializeLcov, stats } from "../../../scripts/ci/lcov-merge.ts";

const unit = `TN:
SF:/w/src/a.ts
FN:1,soma
FNDA:2,soma
FNF:1
FNH:1
BRDA:3,0,0,1
BRDA:3,0,1,0
DA:1,2
DA:2,2
DA:3,0
LF:3
LH:2
end_of_record
SF:/w/src/so-unit.ts
DA:1,1
end_of_record
`;
const integration = `SF:/w/src/a.ts
FN:1,soma
FN:5,outra
FNDA:1,soma
FNDA:0,outra
BRDA:3,0,0,-
BRDA:3,0,1,4
DA:1,1
DA:3,5
DA:5,0
end_of_record
SF:/w/src/so-integracao.ts
DA:1,0
end_of_record
`;

describe("mesclagem de LCOV para o Sonar", () => {
  const merged = mergeCoverage([parseLcov(unit, "/w"), parseLcov(integration, "/w")]);

  it("soma contagens por linha sem duplicar e preserva arquivos de cada suíte", () => {
    expect([...merged.keys()].sort()).toEqual(["src/a.ts", "src/so-integracao.ts", "src/so-unit.ts"]);
    expect([...merged.get("src/a.ts")!.lines.entries()]).toEqual([
      [1, 3],
      [2, 2],
      [3, 5],
      [5, 0],
    ]);
  });

  it("ramo e função cobertos por qualquer suíte ficam cobertos; '-' não apaga contagem", () => {
    const a = merged.get("src/a.ts")!;
    expect(a.branches.get("3,0,0")).toBe(1);
    expect(a.branches.get("3,0,1")).toBe(4);
    expect(a.functions.get("soma")).toEqual({ line: 1, hits: 3 });
    expect(a.functions.get("outra")).toEqual({ line: 5, hits: 0 });
  });

  it("serializa totais recalculados e é estável na releitura", () => {
    const text = serializeLcov(merged);
    expect(text).toContain("SF:src/a.ts\nFN:1,soma\nFN:5,outra\nFNDA:3,soma\nFNDA:0,outra\nFNF:2\nFNH:1\nBRDA:3,0,0,1\nBRDA:3,0,1,4\nBRF:2\nBRH:2\nDA:1,3\nDA:2,2\nDA:3,5\nDA:5,0\nLF:4\nLH:3\nend_of_record");
    expect(serializeLcov(parseLcov(text, "/w"))).toBe(text);
    expect(stats(merged)).toEqual({ files: 3, lines: 6, lines_hit: 4, line_rate: 66.7 });
  });

  it("caminho Windows é normalizado para relativo ao projeto", () => {
    expect([...parseLcov("SF:E:\\cantina\\src\\x.ts\nDA:1,1\nend_of_record\n", "E:\\cantina").keys()]).toEqual(["src/x.ts"]);
  });
});
