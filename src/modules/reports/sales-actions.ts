import { errorText } from "@/lib/api-client";
import { addDays, type LocalDate } from "@/lib/dates/school-time";
import type { ExportDeps } from "@/modules/fees/finance-actions";
import type { Filters } from "./sales-model";
import type { SalesView } from "./sales-tables";

/** Ações da tela de relatórios de vendas como funções PURAS (testáveis sem navegador). */
export type SalesParams = { from: LocalDate; to: LocalDate; filters: Filters };

export function salesQuery(p: SalesParams): string {
  const parts = [`from=${p.from}`, `to=${p.to}`];
  for (const k of ["shiftId", "productId", "categoryId", "channel"] as const) {
    const v = p.filters[k];
    if (v) parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

export const PRESETS = [
  { id: "month", label: "Este mês" },
  { id: "last7", label: "Últimos 7 dias" },
  { id: "lastMonth", label: "Mês anterior" },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

/** Períodos prontos, sempre na data local da escola (informada por quem chama). */
export function presetRange(id: PresetId, today: LocalDate): { from: LocalDate; to: LocalDate } {
  if (id === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (id === "last7") return { from: addDays(today, -6), to: today };
  const firstThis = `${today.slice(0, 7)}-01`;
  const to = addDays(firstThis, -1);
  return { from: `${to.slice(0, 7)}-01`, to };
}

export const EXPORT_ERRORS: Record<string, string> = {
  export_truncated: "Há registros demais no período para uma exportação completa. Reduza o intervalo.",
  view_unavailable: "Esta exportação não existe com os filtros ativos. Limpe os filtros para exportá-la.",
  range_too_long: "O período máximo é de cerca de 3 meses.",
  invalid_range: "O período está invertido.",
};

/** Baixa o arquivo; devolve a mensagem de erro (ou `null` quando o arquivo foi salvo). Nunca salva arquivo parcial. */
export async function exportSalesAction(deps: ExportDeps, params: SalesParams, view: SalesView, format: "csv" | "xlsx"): Promise<string | null> {
  try {
    const response = await deps.fetchFn(`/api/reports/sales/export?${salesQuery(params)}&view=${view}&format=${format}`, { headers: { authorization: `Bearer ${await deps.token()}` } });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string } | null | undefined;
      const code = body?.error ?? "internal";
      return EXPORT_ERRORS[code] ?? errorText(code);
    }
    deps.save(await response.blob(), `relatorio-${view}-${params.from}_${params.to}.${format}`);
    return null;
  } catch {
    return errorText("network");
  }
}
