import { describe, expect, it } from "vitest";
import { evaluateSast, evaluateSca, productionPackages } from "../../../scripts/ci/veracode-report.ts";

// Estruturas mínimas no formato documentado; o formato real será conferido no probe P4 (com credenciais).
describe("critérios Veracode (avaliação local, fail-closed)", () => {
  it("SAST: Very High/High reprova; Medium não; análise não concluída ou estrutura desconhecida reprova", () => {
    expect(evaluateSast({ scan_status: "SUCCESS", findings: [{ severity: 3 }, { severity: 2 }] })).toMatchObject({ ok: true, by_severity: { Medium: 1, Low: 1 } });
    expect(evaluateSast({ scan_status: "SUCCESS", findings: [{ severity: 4, cwe_id: "79", files: { source_file: { file: "src/a.ts", line: 3 } } }] })).toMatchObject({
      ok: false,
      problems: ["1 achado(s) SAST Very High/High"],
      blocking: [{ severity: "High", cwe: "79", file: "src/a.ts", line: 3 }],
    });
    expect(evaluateSast({ scan_status: "FAILURE", findings: [] }).ok).toBe(false);
    expect(evaluateSast({ scan_status: "SUCCESS" }).problems).toEqual(["estrutura de resultados SAST não reconhecida (findings ausente)"]);
  });

  it("SCA: CVSS ≥ 7 bloqueia só na árvore de produção; sem bibliotecas ou estrutura desconhecida reprova", () => {
    const prod = productionPackages({ dependencies: { next: { version: "16.3.8", dependencies: { "@swc/helpers": { version: "0.5.1" } } } } });
    expect([...prod]).toEqual(["next@16.3.8", "@swc/helpers@0.5.1"]);
    const report = {
      records: [
        {
          libraries: [
            { coordinate1: "@swc/helpers", versions: [{ version: "0.5.1" }] },
            { coordinate1: "braces", versions: [{ version: "3.0.2" }] },
          ],
          vulnerabilities: [
            { cve: "2026-1", cvss3Score: 7.5, libraries: [{ _links: { ref: "/records/0/libraries/0" } }] },
            { cve: "2026-2", cvss3Score: 8.1, libraries: [{ _links: { ref: "/records/0/libraries/1" } }] },
            { cve: "2026-3", cvssScore: 5, libraries: [{ _links: { ref: "/records/0/libraries/0" } }] },
          ],
        },
      ],
    };
    const r = evaluateSca(report, prod);
    expect(r.ok).toBe(false);
    expect(r.findings.filter((f) => f.blocking).map((f) => f.cve)).toEqual(["2026-1"]);
    expect(r.findings.find((f) => f.cve === "2026-2")).toMatchObject({ production: false, blocking: false });
    expect(evaluateSca({ records: [{ libraries: [], vulnerabilities: [] }] }, prod).problems).toEqual(["SCA não identificou nenhuma dependência: análise ineficaz"]);
    expect(evaluateSca({}, prod).ok).toBe(false);
  });
});
