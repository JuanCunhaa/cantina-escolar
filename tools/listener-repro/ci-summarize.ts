// Resume as rodadas do experimento no CI (artefatos baixados) e compara com os registros locais já arquivados.
// Uso: node tools/listener-repro/ci-summarize.ts <diretório com rodada-*.json> [diretório de resultados locais]
// Só lê JSON sanitizado (tempos, nomes de parâmetros, IPs públicos do Google); nada com credencial.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type CiRound = {
  browser: string;
  firebaseSdk: string;
  playwright: string;
  runner: { imageOs: string | null; githubRunId: string | null };
  run: {
    round: number;
    writeAfterSubscribeTargetMs: number;
    writeAfterSubscribeMs: number;
    subscribeToFirstSnapshotMs: number | null;
    firstSnapshotFromCache: { afterSubscribeMs: number; fromCache: boolean | null }[];
    commitMs: number;
    commitToSnapshotMs: number | null;
    subscribeToDeliveryMs: number | null;
    newValueSnapshot: { afterSubscribeMs: number; fromCache: boolean | null } | null;
    requestStarts: { kind: string }[];
    failedRequests: unknown[];
    errors: string[];
    console: { text: string }[];
    pageErrors: unknown[];
    slow: boolean;
    delivered: boolean;
  };
};
type LocalFile = { scenario: string; browser: string; measure: string; delayMs: number; transport: string; writeMode: string; runs: { commitToSnapshotMs: number | null; subscribeToFirstSnapshotMs: number | null; writeAfterFirstSnapshotMs: number | null; channelOpenToDeliveryMs: number | null }[] };

const median = (values: number[]) => (values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]! : null);
const ciDir = process.argv[2];
const localDir = process.argv[3] ?? "tools/listener-repro/results";
if (!ciDir) throw new Error("informe o diretório dos resultados do CI");

const ci = readdirSync(ciDir)
  .filter((f) => /^rodada-.*\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(ciDir, f), "utf8")) as CiRound);
const local = readdirSync(localDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(localDir, f), "utf8")) as LocalFile)
  .filter((j) => Array.isArray(j.runs) && j.browser?.startsWith("chromium"));

console.log(`Ambiente do CI: ${[...new Set(ci.map((r) => `${r.browser}; firebase ${r.firebaseSdk}; playwright ${r.playwright}; ${r.runner.imageOs ?? "?"}`))].join(" | ")}`);
console.log(`Ambiente local (arquivos Chromium): ${[...new Set(local.map((j) => j.browser))].join(", ")}\n`);

console.log("| Escrita após a inscrição | Rodadas | Lentas (> 5 s) | Não entregues (60 s) | commit→snapshot (ms) | inscrição→entrega (ms) | 1º snapshot do servidor (ms) | requisições do canal | erros/avisos/falhas |");
console.log("|---:|---:|---:|---:|---|---|---|---|---|");
for (const delay of [2000, 10000, 35000]) {
  const rows = ci.filter((r) => r.run.writeAfterSubscribeTargetMs === delay).sort((a, b) => a.run.round - b.run.round);
  if (!rows.length) continue;
  const fmt = (pick: (r: CiRound) => number | null) => rows.map((r) => pick(r) ?? "—").join(" / ");
  const noise = rows.map((r) => r.run.errors.length + r.run.console.length + r.run.failedRequests.length + r.run.pageErrors.length).join(" / ");
  console.log(
    `| ${delay / 1000} s | ${rows.length} | ${rows.filter((r) => r.run.slow).length} | ${rows.filter((r) => !r.run.delivered).length} | ${fmt((r) => r.run.commitToSnapshotMs)} | ${fmt((r) => r.run.subscribeToDeliveryMs)} | ${fmt((r) => r.run.subscribeToFirstSnapshotMs)} | ${rows.map((r) => r.run.requestStarts.length).join(" / ")} | ${noise} |`,
  );
}

const cache = ci.map((r) => r.run.firstSnapshotFromCache.map((s) => `${s.fromCache}`).join(">")).reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
console.log(`\nSequência de fromCache dos snapshots por rodada do CI: ${JSON.stringify(cache)}`);
console.log(`Snapshot com o valor novo veio do servidor (fromCache=false) em ${ci.filter((r) => r.run.newValueSnapshot?.fromCache === false).length}/${ci.length} rodadas.`);

const flat = local.flatMap((j) => j.runs.map((r) => ({ ...r, delayMs: j.delayMs, scenario: j.scenario })));
const slowLocal = flat.filter((r) => r.commitToSnapshotMs === null || r.commitToSnapshotMs > 5000);
const fastLocal = flat.filter((r) => r.commitToSnapshotMs !== null && r.commitToSnapshotMs <= 5000);
console.log(`\nLocal (Chromium, todas as séries arquivadas; escrita ~2 s após o 1º snapshot; medida no calendário/sonda com a conta fixture de administração): ${flat.length} rodadas, ${slowLocal.length} lentas (${((100 * slowLocal.length) / Math.max(flat.length, 1)).toFixed(1)}%), mediana das rápidas ${median(fastLocal.map((r) => r.commitToSnapshotMs!))} ms; lentas: ${slowLocal.map((r) => r.commitToSnapshotMs ?? "NÃO ENTREGUE").join(", ") || "—"}; canal aberto→entrega nas lentas: ${slowLocal.map((r) => r.channelOpenToDeliveryMs).join(", ") || "—"} ms.`);
