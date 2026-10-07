// Confere o resultado EFETIVO do Quality Gate no SonarQube Cloud depois do processamento (não basta o envio do relatório).
// Lê .scannerwork/report-task.txt, espera a tarefa de processamento terminar e consulta o status do gate da análise.
// Uso: SONAR_TOKEN=... node scripts/ci/sonar-gate.ts .scannerwork/report-task.txt
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export function parseReportTask(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

async function main() {
  const file = process.argv[2] ?? ".scannerwork/report-task.txt";
  const token = process.env.SONAR_TOKEN;
  if (!token) throw new Error("SONAR_TOKEN ausente");
  if (!existsSync(file)) throw new Error(`${file} ausente: a análise não foi enviada`);
  const task = parseReportTask(readFileSync(file, "utf8"));
  const server = task.serverUrl;
  if (!server || !/^https:\/\/sonarcloud\.io$/.test(server)) throw new Error(`serverUrl inesperado: ${String(server)}`);
  const get = async (path: string) => {
    const response = await fetch(`${server}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`SonarQube Cloud ${response.status} em ${path.split("?")[0]}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  let analysisId: string | undefined;
  for (let i = 0; i < 60; i++) {
    const body = (await get(`/api/ce/task?id=${encodeURIComponent(task.ceTaskId ?? "")}`)) as { task?: { status?: string; analysisId?: string; errorMessage?: string } };
    const status = body.task?.status;
    if (status === "SUCCESS") {
      analysisId = body.task?.analysisId;
      break;
    }
    if (status === "FAILED" || status === "CANCELED") throw new Error(`processamento da análise ${status}: ${body.task?.errorMessage ?? ""}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!analysisId) throw new Error("processamento da análise não terminou em 5 minutos");
  const gate = (await get(`/api/qualitygates/project_status?analysisId=${encodeURIComponent(analysisId)}`)) as {
    projectStatus?: { status?: string; conditions?: { status: string; metricKey: string; actualValue?: string; comparator?: string; errorThreshold?: string }[] };
  };
  const status = gate.projectStatus?.status ?? "AUSENTE";
  const conditions = gate.projectStatus?.conditions ?? [];
  const md = `### ${status === "OK" ? "✅" : "❌"} SonarQube Cloud — Quality Gate: ${status}\n\n${conditions.map((c) => `- ${c.status} ${c.metricKey}: ${c.actualValue ?? "—"} (${c.comparator ?? ""} ${c.errorThreshold ?? ""})`).join("\n")}\n\nPainel: ${task.dashboardUrl ?? "—"}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.stdout.write(md);
  process.exit(status === "OK" ? 0 : 1);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`Quality Gate não confirmado: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
