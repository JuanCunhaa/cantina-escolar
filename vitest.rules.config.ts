import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.ts";

export default defineConfig({
  resolve: { alias },
  test: { include: ["tests/rules/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false },
});
