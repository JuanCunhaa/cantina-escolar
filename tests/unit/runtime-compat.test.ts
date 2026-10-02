import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Na Vercel o firebase-admin (serverExternalPackages) é carregado por require() sem interop ESM: jwks-rsa@4 faz
// require("jose") e o jose 6 é só ESM (firebase/firebase-admin-node#3181). O override `jwks-rsa>jose` (package.json)
// mantém uma versão dual CJS/ESM; este teste reproduz o runtime publicado desligando o require(esm) do Node.
describe("compatibilidade do runtime publicado", () => {
  it("firebase-admin/auth carrega por require() sem require(esm)", () => {
    const result = spawnSync(
      process.execPath,
      ["--no-experimental-require-module", "-e", "require('firebase-admin/auth'); require('firebase-admin/firestore');"],
      { encoding: "utf8", timeout: 60000 },
    );
    expect(result.stderr).not.toContain("ERR_REQUIRE_ESM");
    expect(result.status).toBe(0);
  });
});
