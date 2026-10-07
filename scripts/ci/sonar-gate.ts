// Confere o resultado EFETIVO do Quality Gate no SonarQube Cloud depois do processamento (não basta o envio do relatório).
// Lê report-task.txt, espera a tarefa de processamento e consulta o status do gate DA ANÁLISE. Status diferente de OK
// (inclusive NONE, quando não há condição avaliada) reprova: análise sem gate efetivo não vira aprovação.
// Uso: SONAR_TOKEN=... node scripts/ci/sonar-gate.ts .scannerwork/report-task.txt
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

/** Destino fixo: só SonarQube Cloud. O serverUrl do relatório é conferido, nunca usado como destino. */
export const SONAR_URL = "https://sonarcloud.io";

export function parseReportTask(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

/** Aceita só um report-task.txt dentro do diretório de trabalho. */
export function safeReportPath(file: string, cwd = process.cwd()): string {
  const full = resolve(cwd, file);
  const rel = relative(cwd, full);
  if (basename(full) !== "report-task.txt" || rel.startsWith("..") || resolve(rel) === rel) throw new Error("caminho do relatório recusado");
  return full;
}

type Deps = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; cwd?: string; log?: (text: string) => void; attempts?: number };

export async function checkGate(file: string, token: string, env: Record<string, string | undefined>, deps: Deps = {}): Promise<{ status: string; markdown: string }> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const path = safeReportPath(file, deps.cwd);
  if (!existsSync(path)) throw new Error("report-task.txt ausente: a análise não foi enviada");
  const task = parseReportTask(readFileSync(path, "utf8"));
  if (task.serverUrl !== SONAR_URL) throw new Error("serverUrl do relatório não é o SonarQube Cloud");
  const taskId = task.ceTaskId ?? "";
  if (!/^[\w-]+$/.test(taskId)) throw new Error("ceTaskId inválido");
  const get = async (endpoint: string, query: Record<string, string>) => {
    const url = new URL(endpoint, SONAR_URL);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const response = await doFetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`SonarQube Cloud ${response.status} em ${endpoint}`);
    return (await response.json()) as Record<string, unknown>;
  };
  let analysisId: string | undefined;
  for (let i = 0; i < (deps.attempts ?? 60); i++) {
    const body = (await get("/api/ce/task", { id: taskId })) as { task?: { status?: string; analysisId?: string; errorMessage?: string } };
    const status = body.task?.status;
    if (status === "SUCCESS") {
      analysisId = body.task?.analysisId;
      break;
    }
    if (status === "FAILED" || status === "CANCELED") throw new Error(`processamento da análise ${status}: ${body.task?.errorMessage ?? ""}`);
    await sleep(5000);
  }
  if (!analysisId) throw new Error("processamento da análise não terminou no prazo");
  const gate = (await get("/api/qualitygates/project_status", { analysisId })) as {
    projectStatus?: { status?: string; conditions?: { status: string; metricKey: string; actualValue?: string; comparator?: string; errorThreshold?: string }[] };
  };
  const status = gate.projectStatus?.status ?? "AUSENTE";
  const conditions = gate.projectStatus?.conditions ?? [];
  const note = status === "NONE" ? "\n\nNenhuma condição avaliada (ex.: 1ª análise sem código novo): não conta como aprovação.\n" : "";
  const markdown = `### ${status === "OK" ? "✅" : "❌"} SonarQube Cloud — Quality Gate: ${status}\n\n${conditions.map((c) => `- ${c.status} ${c.metricKey}: ${c.actualValue ?? "—"} (${c.comparator ?? ""} ${c.errorThreshold ?? ""})`).join("\n")}${note}\n\nPainel: ${task.dashboardUrl ?? "—"}\n`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  return { status, markdown };
}

export async function main(argv: string[], env: Record<string, string | undefined>, deps: Deps = {}): Promise<number> {
  const log = deps.log ?? ((text: string) => process.stdout.write(text));
  try {
    if (!env.SONAR_TOKEN) throw new Error("SONAR_TOKEN ausente");
    const { status, markdown } = await checkGate(argv[0] ?? ".scannerwork/report-task.txt", env.SONAR_TOKEN, env, deps);
    log(markdown);
    return status === "OK" ? 0 : 1;
  } catch (error) {
    log(`Quality Gate não confirmado: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
