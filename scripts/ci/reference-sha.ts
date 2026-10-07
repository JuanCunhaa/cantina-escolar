// Referência da classificação documental: o que já foi VALIDADO, não apenas o push anterior.
//   pull_request: base do PR (a árvore de merge testada inclui todos os commits e merges do PR).
//   push: head do último run CONCLUÍDO COM SUCESSO deste workflow neste ref. Usar `before` deixaria sem validação o código
//   de um push cujo run foi cancelado (concorrência) quando o push seguinte fosse só documental (medido no probe P3).
// Sem referência confiável => saída vazia => classificação "full".
// Uso no CI: GITHUB_TOKEN=... node scripts/ci/reference-sha.ts   (escreve base=<sha|vazio> em $GITHUB_OUTPUT)
import { appendFileSync } from "node:fs";
import { tokenFetcher, type Fetcher } from "./metrics/github.ts";

type Run = { id: number; head_sha: string; conclusion: string | null; status: string };

export async function referenceSha(input: { event: string; prBase?: string; repo: string; workflowRef: string; branch: string; runId: number; fetcher: Fetcher }): Promise<{ sha: string; reason: string }> {
  if (input.event === "pull_request") {
    return /^[0-9a-f]{40}$/.test(input.prBase ?? "") ? { sha: input.prBase!, reason: "base do PR" } : { sha: "", reason: "base do PR ausente" };
  }
  if (input.event !== "push") return { sha: "", reason: `evento ${input.event} sem referência` };
  // GITHUB_WORKFLOW_REF = dono/repo/.github/workflows/ci.yml@refs/heads/main
  const file = input.workflowRef.split("@")[0]?.split("/").pop();
  if (!file || !/^[\w.-]+\.ya?ml$/.test(file)) return { sha: "", reason: "workflow não identificado" };
  const body = (await input.fetcher(
    `repos/${input.repo}/actions/workflows/${file}/runs?branch=${encodeURIComponent(input.branch)}&event=push&status=success&per_page=10`,
  )) as { workflow_runs?: Run[] };
  const last = (body.workflow_runs ?? []).find((r) => r.id !== input.runId && r.conclusion === "success" && /^[0-9a-f]{40}$/.test(r.head_sha));
  return last ? { sha: last.head_sha, reason: `último run verde ${last.id}` } : { sha: "", reason: "nenhum run verde anterior neste ref" };
}

if (import.meta.main) {
  const env = process.env;
  const fetcher = tokenFetcher(env.GITHUB_TOKEN ?? "", env.GITHUB_API_URL);
  referenceSha({ event: env.GITHUB_EVENT_NAME ?? "", prBase: env.PR_BASE, repo: env.GITHUB_REPOSITORY ?? "", workflowRef: env.GITHUB_WORKFLOW_REF ?? "", branch: env.GITHUB_REF_NAME ?? "", runId: Number(env.GITHUB_RUN_ID), fetcher })
    .catch((error: unknown) => ({ sha: "", reason: `falha ao consultar a referência: ${error instanceof Error ? error.message : String(error)}` }))
    .then((r) => {
      console.log(`referência: ${r.sha || "(nenhuma — fluxo completo)"} — ${r.reason}`);
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `base=${r.sha}\n`);
    });
}
