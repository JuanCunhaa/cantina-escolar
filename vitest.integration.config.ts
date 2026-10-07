import { defineConfig } from "vitest/config";
import { alias, coverage } from "./vitest.shared.ts";

export default defineConfig({
  resolve: { alias },
  test: { coverage: coverage("integration"), include: ["tests/integration/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false },
});
