import { fileURLToPath } from "node:url";

export const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
};

/**
 * Cobertura (V8) para o SonarQube Cloud: só liga com `--coverage` (CI); execução local sem a flag não muda.
 * Código da aplicação e scripts executados em processo; arquivos não carregados entram com 0% (não são omitidos).
 */
export const coverage = (suite: string) => ({
  provider: "v8" as const,
  include: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
  exclude: ["**/*.d.ts"],
  reporter: ["lcov", "json-summary"],
  reportsDirectory: `coverage/${suite}`,
});
