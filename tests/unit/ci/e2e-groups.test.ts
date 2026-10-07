import { describe, expect, it } from "vitest";
import { loadGroups, requiredSpecs, verifyPartition, verifyTestUnion } from "../../../scripts/ci/e2e-groups.ts";

describe("partição da suíte e2e em grupos", () => {
  it("a partição versionada cobre exatamente os specs obrigatórios atuais", () => {
    expect(verifyPartition(loadGroups(), requiredSpecs())).toEqual([]);
  });

  it("a propagação (diagnóstico) não entra na suíte obrigatória", () => {
    expect(requiredSpecs().some((f) => f.includes("propagation"))).toBe(false);
  });

  it("spec novo sem grupo, spec repetido ou inexistente reprova", () => {
    const specs = ["a.spec.ts", "b.spec.ts", "c.spec.ts"];
    expect(verifyPartition({ groups: { g1: ["a.spec.ts"], g2: ["b.spec.ts"] } }, specs)).toEqual(["c.spec.ts não pertence a nenhum grupo: todo spec obrigatório precisa de grupo"]);
    expect(verifyPartition({ groups: { g1: ["a.spec.ts", "b.spec.ts"], g2: ["b.spec.ts", "c.spec.ts"] } }, specs)).toEqual(["b.spec.ts está em g1 e em g2"]);
    expect(verifyPartition({ groups: { g1: ["a.spec.ts", "b.spec.ts", "c.spec.ts", "x.spec.ts"], g2: [] } }, specs).sort()).toEqual([
      "grupo g2 vazio",
      "x.spec.ts (grupo g1) não existe na suíte obrigatória",
    ]);
  });

  it("união por teste: falta, duplicidade e sobra são detectadas", () => {
    expect(verifyTestUnion(["t1", "t2"], { g1: ["t1"], g2: ["t2"] })).toEqual([]);
    expect(verifyTestUnion(["t1", "t2"], { g1: ["t1"], g2: [] })).toEqual(["teste da suíte fora dos grupos: t2"]);
    expect(verifyTestUnion(["t1"], { g1: ["t1"], g2: ["t1"] })).toEqual(["teste em dois grupos: t1"]);
    expect(verifyTestUnion(["t1"], { g1: ["t1", "t9"] })).toEqual(["teste de grupo fora da suíte: t9"]);
  });
});
