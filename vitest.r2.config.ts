import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.ts";

// Carrega do .env local SOMENTE as variáveis R2_TEST_* (o resto do .env, com credenciais do Firebase, não entra no teste).
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = /^(R2_TEST_[A-Z_]+)=(.*)$/.exec(line);
    if (match?.[1] && match[2] && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}

// Integração opcional com um bucket R2 de HOMOLOGAÇÃO (precisa de R2_TEST_*; sem elas os testes são pulados).
export default defineConfig({
  resolve: { alias },
  test: { include: ["tests/r2/**/*.test.ts"], testTimeout: 60000, hookTimeout: 60000, fileParallelism: false },
});
