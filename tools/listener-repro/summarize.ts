// Agrega tools/listener-repro/results/*.json em tabela Markdown: rodadas, lentas (> 5 s ou não entregues em 60 s),
// mediana das rápidas e valores das lentas. Uso: node tools/listener-repro/summarize.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "results");
type Run = Record<string, unknown>;
const rows = new Map<string, { file: string; runs: Run[]; browser: string }[]>();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as { scenario: string; browser?: string; runs: Run[] };
  // Séries intercaladas: agrupa por condição (sem o ciclo).
  const where = file.includes("-local.") ? " (app local, next dev)" : file.includes("-publicada.") ? " (URL publicada)" : "";
  const key = where ? `${data.scenario}${where}` : data.scenario.replace(/^INT-([A-Z]+)-c\d+-/, "INT-$1-").replace(/^INT-(A|B)-/, "INT-navegadores-").replace(/^INT-(IPA|IPB)-/, "INT-ip-");
  rows.set(key, [...(rows.get(key) ?? []), { file, runs: data.runs, browser: data.browser ?? "" }]);
}
const delayOf = (r: Run): number | null => {
  for (const k of ["commitToSnapshotMs", "commitConfirmedToRowMs", "confirmedToImageMs"]) if (k in r) return (r[k] as number | null) ?? null;
  return null;
};
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : NaN);
console.log("| Cenário | Rodadas | Lentas (> 5 s) | Mediana das rápidas (ms) | Lentas (ms) |\n|---|---:|---:|---:|---|");
let totalRuns = 0;
for (const [scenario, groups] of rows) {
  const runs = groups.flatMap((g) => g.runs);
  const values = runs.map(delayOf);
  const slow = values.filter((v) => v === null || v > 5000);
  const fast = values.filter((v): v is number => v !== null && v <= 5000);
  totalRuns += runs.length;
  console.log(`| ${scenario} | ${runs.length} | ${slow.length} | ${Math.round(median(fast))} | ${slow.map((v) => (v === null ? "não entregue" : v)).join(", ") || "—"} |`);
}
console.log(`\nTotal: ${totalRuns} rodadas em ${rows.size} cenários.`);
