// Confere o resultado EFETIVO do Quality Gate no SonarQube Cloud depois do processamento (não basta o envio do relatório).
// Lê report-task.txt, espera a tarefa de processamento e consulta o status do gate DA ANÁLISE. O Sonar NÃO é gate de
// segurança (decisão do dono; segurança é o job `security`): condições de segurança (vulnerabilidades, hotspots, ratings
// de segurança) são só informativas. Aprova quando há ao menos uma condição fora de segurança e todas estão OK; NONE,
// gate ausente ou só condições de segurança reprovam: análise sem gate efetivo não vira aprovação.
// Uso: SONAR_TOKEN=... node scripts/ci/sonar-gate.ts .scannerwork/report-task.txt
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

/** Destino fixo: só SonarQube Cloud. O serverUrl do relatório é conferido, nunca usado como destino. */
export const SONAR_URL = "https://sonarcloud.io";

/** Métricas de segurança do Sonar (modelos clássico e MQR): `security_rating`, `new_vulnerabilities`, `new_security_hotspots_reviewed`, `software_quality_security_rating`... */
export function isSecurityMetric(metricKey: string): boolean {
  return /(^|_)(security|vulnerabilities)(_|$)/.test(metricKey);
}

type Condition = { status: string; metricKey: string; actualValue?: string; comparator?: string; errorThreshold?: string };

/** Status efetivo do gate sem as condições de segurança. */
export function effectiveStatus(serviceStatus: string, conditions: Condition[]): string {
  if (serviceStatus === "NONE" || serviceStatus === "AUSENTE") return serviceStatus;
  const quality = conditions.filter((c) => !isSecurityMetric(c.metricKey));
  if (quality.length === 0) return "NONE";
  return quality.every((c) => c.status === "OK") ? "OK" : "ERROR";
}

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
    projectStatus?: { status?: string; conditions?: Condition[] };
  };
  const serviceStatus = gate.projectStatus?.status ?? "AUSENTE";
  const conditions = gate.projectStatus?.conditions ?? [];
  const status = effectiveStatus(serviceStatus, conditions);
  const note = status === "NONE" ? "\n\nNenhuma condição fora de segurança avaliada (ex.: 1ª análise sem código novo): não conta como aprovação.\n" : "";
  const line = (c: Condition) =>
    `- ${c.status} ${c.metricKey}: ${c.actualValue ?? "—"} (${c.comparator ?? ""} ${c.errorThreshold ?? ""})${isSecurityMetric(c.metricKey) ? " — informativo (segurança é o job security)" : ""}`;
  const markdown = `### ${status === "OK" ? "✅" : "❌"} SonarQube Cloud — Quality Gate sem segurança: ${status} (serviço: ${serviceStatus})\n\n${conditions.map(line).join("\n")}${note}\n\nPainel: ${task.dashboardUrl ?? "—"}\n`;
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
