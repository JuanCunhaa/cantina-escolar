import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { alias, coverage } from "./vitest.shared.ts";

// CI: grupo da partição (scripts/ci/integration-groups.json). Sem INTEGRATION_GROUP roda a suíte inteira, como antes.
const group = process.env.INTEGRATION_GROUP;
const groupFiles = group ? (JSON.parse(readFileSync("scripts/ci/integration-groups.json", "utf8")) as { groups: Record<string, string[]> }).groups[group] : undefined;
if (group && !groupFiles) throw new Error(`INTEGRATION_GROUP desconhecido: ${group}`);

export default defineConfig({
  resolve: { alias },
  test: {
    coverage: coverage("integration"),
    include: groupFiles ? groupFiles.map((f) => `tests/integration/${f}`) : ["tests/integration/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
