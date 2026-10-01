import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.ts";

// Integração opcional com um bucket R2 de HOMOLOGAÇÃO (precisa de R2_TEST_*; sem elas os testes são pulados).
export default defineConfig({
  resolve: { alias },
  test: { include: ["tests/r2/**/*.test.ts"], testTimeout: 60000, hookTimeout: 60000, fileParallelism: false },
});
