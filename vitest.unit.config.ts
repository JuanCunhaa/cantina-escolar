import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.ts";

export default defineConfig({
  resolve: { alias },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
