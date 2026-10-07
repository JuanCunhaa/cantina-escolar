// Referência da classificação documental: o que já foi VALIDADO, não apenas o push anterior.
//   pull_request: base do PR (a árvore de merge testada inclui todos os commits e merges do PR).
//   push: head do último run CONCLUÍDO COM SUCESSO deste workflow neste ref. Usar `before` deixaria sem validação o código
//   de um push cujo run foi cancelado (concorrência) quando o push seguinte fosse só documental (medido no probe P3).
// Sem referência confiável => saída vazia => classificação "full".
// Uso no CI: GITHUB_TOKEN=... node scripts/ci/reference-sha.ts   (escreve base=<sha|vazio> em $GITHUB_OUTPUT)
import { appendFileSync } from "node:fs";
import { tokenFetcher, type Fetcher } from "./metrics/github.ts";

type Run = { id: number; head_sha: string; conclusion: string | null; status: string };
const SHA = /^[0-9a-f]{40}$/;

export async function referenceSha(input: { event: string; prBase?: string; repo: string; workflowRef: string; branch: string; runId: number; fetcher: Fetcher }): Promise<{ sha: string; reason: string }> {
  if (input.event === "pull_request") {
    return SHA.test(input.prBase ?? "") ? { sha: input.prBase!, reason: "base do PR" } : { sha: "", reason: "base do PR ausente" };
  }
  if (input.event !== "push") return { sha: "", reason: "evento sem referência" };
  // GITHUB_WORKFLOW_REF = dono/repo/.github/workflows/ci.yml@refs/heads/main
  const file = input.workflowRef.split("@")[0]?.split("/").pop();
  if (!file || !/^[\w.-]+\.ya?ml$/.test(file)) return { sha: "", reason: "workflow não identificado" };
  const body = (await input.fetcher(
    `repos/${input.repo}/actions/workflows/${file}/runs?branch=${encodeURIComponent(input.branch)}&event=push&status=success&per_page=10`,
  )) as { workflow_runs?: Run[] };
  const last = (body.workflow_runs ?? []).find((r) => r.id !== input.runId && r.conclusion === "success" && SHA.test(r.head_sha));
  return last ? { sha: last.head_sha, reason: `último run verde ${last.id}` } : { sha: "", reason: "nenhum run verde anterior neste ref" };
}

/** Mensagens fixas por desfecho: o log não reproduz conteúdo vindo de entrada externa. */
export function describeReference(reason: string): string {
  if (reason === "base do PR") return "base do PR";
  if (reason.startsWith("último run verde ")) return `último run verde ${Number(reason.slice("último run verde ".length)) || "?"}`;
  if (reason === "nenhum run verde anterior neste ref") return "nenhum run verde anterior neste ref";
  return "sem referência validada";
}

/** CLI testável. Falha de consulta => sem referência (fluxo completo), nunca aprovação documental. */
export async function main(env: Record<string, string | undefined>, deps: { fetcher?: Fetcher; log?: (text: string) => void } = {}): Promise<number> {
  const log = deps.log ?? console.log;
  let result: { sha: string; reason: string };
  try {
    result = await referenceSha({
      event: env.GITHUB_EVENT_NAME ?? "",
      prBase: env.PR_BASE,
      repo: env.GITHUB_REPOSITORY ?? "",
      workflowRef: env.GITHUB_WORKFLOW_REF ?? "",
      branch: env.GITHUB_REF_NAME ?? "",
      runId: Number(env.GITHUB_RUN_ID),
      fetcher: deps.fetcher ?? tokenFetcher(env.GITHUB_TOKEN ?? ""),
    });
  } catch {
    result = { sha: "", reason: "falha" };
  }
  const sha = SHA.test(result.sha) ? result.sha : "";
  const message = sha ? `referência validada: ${sha} (${describeReference(result.reason)})` : `sem referência validada (${describeReference(result.reason)}): fluxo completo`;
  log(message.replace(/[\r\n]/g, ""));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `base=${sha}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.env);
