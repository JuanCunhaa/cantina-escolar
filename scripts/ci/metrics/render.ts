// Resumo legível (Markdown) das métricas para o Step Summary do Actions e para o terminal.
import type { RunMetrics, summarizeHistory } from "./compute.ts";

const cell = (value: unknown) => String(value ?? "—").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const fmt = (s: number | null | undefined) => (typeof s === "number" ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : "—");
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

export function renderMarkdown(m: RunMetrics, extra?: { history?: ReturnType<typeof summarizeHistory> | null; collector?: Record<string, unknown> | null }): string {
  const lines: string[] = [];
  lines.push(`## FinOps — ${cell(m.workflow.name)} run ${m.run.id} (${m.run.event}, ${m.run.head_sha.slice(0, 7)})`);
  lines.push("");
  lines.push(`Conclusão: **${cell(m.run.conclusion ?? m.run.status)}** · tentativas: ${m.run.attempts}${m.run.pull_requests.length ? ` · PR #${m.run.pull_requests.join(", #")}` : ""}${m.complete ? "" : " · **execução incompleta: valores parciais**"}`);
  lines.push("");
  lines.push("| Medida | Valor | Natureza |");
  lines.push("|---|---|---|");
  lines.push(`| Espera até o resultado da 1ª tentativa | ${fmt(m.timing.first_attempt_wait_s)} | tempo de parede |`);
  lines.push(`| Espera até o resultado final (inclui intervalos entre tentativas) | ${fmt(m.timing.result_wait_s)} | tempo de parede |`);
  const own = m.consumption.self_hosted;
  const host = m.consumption.github_hosted;
  lines.push(`| Soma dos tempos de todos os runners | ${m.consumption.runner_raw_min} min | medido (soma das durações; em máquina própria roda em série) |`);
  lines.push(`| Runner HOSPEDADO (GitHub): ${host.jobs} job(s) | ${fmt(host.raw_s)} brutos / ${host.rounded_estimate_min} min arred. | medido / estimativa, não é cobrança |`);
  lines.push(`| Máquina PRÓPRIA (self-hosted): ${own.jobs} job(s) | ${fmt(own.raw_s)} | ocupação do runner; não é minuto hospedado nem cobrança |`);
  if (own.jobs) lines.push(`| Fila na máquina própria (soma / maior) | ${own.queue_known ? `${fmt(own.queue_sum_s)} / ${fmt(own.queue_max_s)}` : "indisponível"} | job pronto → início (exclui espera por dependência; exige o grafo needs) |`);
  lines.push(`| Consumo das reexecuções | ${fmt(m.consumption.reruns_raw_s)} brutos / ${m.consumption.reruns_rounded_estimate_min} min arred. | medido |`);
  if (m.consumption.without_runner_s) lines.push(`| Jobs sem runner (fila/incidente; fora do consumo) | ${fmt(m.consumption.without_runner_s)} | medido |`);
  lines.push(`| Consumo/custo oficial | indisponível | ${cell(m.consumption.official.reason)} |`);
  lines.push("");
  lines.push("### Tentativas");
  lines.push("| # | Conclusão | Duração | Intervalo antes (não é runner) | Jobs executados | Bruto | Arred. |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const a of m.timing.attempts) {
    lines.push(`| ${a.attempt} | ${cell(a.conclusion)} | ${fmt(a.duration_s)} | ${fmt(a.idle_before_s)} | ${cell(a.jobs_executed.join(", "))} | ${fmt(a.runner_raw_s)} | ${a.rounded_estimate_min} |`);
  }
  lines.push("");
  lines.push("### Jobs (cada execução contada uma vez)");
  lines.push("| Job | Tentativa | Conclusão | Criação→início | Fila do runner | Duração | Origem | Runner |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const j of m.jobs) lines.push(`| ${cell(j.name)} | ${j.attempt} | ${cell(j.conclusion ?? j.status)} | ${fmt(j.start_delay_s)} | ${fmt(j.queue_s)} | ${fmt(j.duration_s)} | ${j.runner_origin === "self-hosted" ? "própria" : "hospedado"} | ${cell(j.labels.join(","))} |`);
  const slow = m.jobs.flatMap((j) => j.steps.filter((s) => (s.duration_s ?? 0) >= 10).map((s) => ({ job: j.name, attempt: j.attempt, ...s })));
  if (slow.length) {
    lines.push("");
    lines.push("<details><summary>Etapas ≥ 10 s</summary>");
    lines.push("");
    lines.push("| Job | Tent. | Etapa | Conclusão | Duração |");
    lines.push("|---|---|---|---|---|");
    for (const s of slow) lines.push(`| ${cell(s.job)} | ${s.attempt} | ${cell(s.name)} | ${cell(s.conclusion)} | ${fmt(s.duration_s)} |`);
    lines.push("");
    lines.push("</details>");
  }
  if (m.artifacts.length || m.transfers.length) {
    lines.push("");
    lines.push("### Artefatos");
    for (const a of m.artifacts) lines.push(`- ${cell(a.name)}: ${mb(a.size_bytes)}, retenção ${a.retention_days ?? "—"} dia(s)${a.expired ? " (expirado)" : ""}`);
    for (const t of m.transfers) lines.push(`- ${cell(t.job)} (tent. ${t.attempt}) ${cell(t.step)}: ${fmt(t.duration_s)} (${cell(t.conclusion)})`);
  }
  lines.push("");
  lines.push(`Vercel: ${m.vercel.available ? `${cell((m.vercel as { state?: string }).state)} — ` : ""}${cell(m.vercel.note)} (separado do Actions).`);
  if (extra?.history) {
    const h = extra.history;
    lines.push("");
    lines.push(`### Histórico de execuções equivalentes (n=${h.n}; mediana com n≥5, p95 com n≥20)`);
    lines.push("| Medida | n | Mediana | p95 |");
    lines.push("|---|---|---|---|");
    lines.push(`| Espera 1ª tentativa | ${h.first_attempt_wait_s.n} | ${fmt(h.first_attempt_wait_s.median)} | ${fmt(h.first_attempt_wait_s.p95)} |`);
    lines.push(`| Espera até o resultado final | ${h.result_wait_s.n} | ${fmt(h.result_wait_s.median)} | ${fmt(h.result_wait_s.p95)} |`);
    lines.push(`| Minutos brutos | ${h.runner_raw_min.n} | ${h.runner_raw_min.median ?? "—"} | ${h.runner_raw_min.p95 ?? "—"} |`);
    lines.push(`| Estimativa arredondada | ${h.rounded_estimate_min.n} | ${h.rounded_estimate_min.median ?? "—"} | ${h.rounded_estimate_min.p95 ?? "—"} |`);
  }
  if (extra?.collector) {
    lines.push("");
    lines.push(`Coletor: ${cell(JSON.stringify(extra.collector))}`);
  }
  return `${lines.join("\n")}\n`;
}
