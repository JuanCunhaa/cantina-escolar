import { defineConfig } from "vitest/config";
import { alias, coverage } from "./vitest.shared.ts";

export default defineConfig({
  resolve: { alias },
  test: { coverage: coverage("unit"), include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
