import { describe, expect, it } from "vitest";
import { missingConfig } from "../../../scripts/ci/require-config.ts";

describe("recusa de configuração externa ausente", () => {
  it("ausente, vazio ou valor não suportado reprovam; presente passa", () => {
    expect(missingConfig(["SONAR_TOKEN", "SONAR_ORGANIZATION"], { SONAR_TOKEN: "x", SONAR_ORGANIZATION: "" })).toEqual(["SONAR_ORGANIZATION ausente"]);
    expect(missingConfig(["VERACODE_REGION=commercial"], { VERACODE_REGION: "eu" })).toEqual(["VERACODE_REGION com valor não suportado (exigido: commercial)"]);
    expect(missingConfig(["VERACODE_REGION=commercial"], {})).toEqual(["VERACODE_REGION ausente"]);
    expect(missingConfig(["A", "B=1"], { A: "x", B: "1" })).toEqual([]);
  });
});
