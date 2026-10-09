import { formatBRL } from "@/lib/money/format";
import { dayMonth } from "@/modules/menu/format";
import { forecastOriginText, type Settlement } from "../topup-model";
import type { TopupView } from "../topup-queries";

export function statusText(t: Pick<TopupView, "status" | "reversedCents">): string {
  if (t.status === "reversed") return "Estornada";
  if (t.status === "partially_reversed") return `Estornada em parte (${formatBRL(t.reversedCents)})`;
  return "Confirmada";
}

/** Previsão com a ORIGEM/base à vista: digitada pelo operador, pela regra (prazo e base) ou pendente por falta de prazo configurado. */
export function forecastText(s: Settlement): string {
  return s.expectedOn ? ` (prevista ${dayMonth(s.expectedOn)} · ${forecastOriginText(s)})` : " (previsão pendente: sem prazo configurado)";
}

/** Aprovação de cartão não é dinheiro no banco: a liquidação aparece separada. */
export function settlementText(s: Settlement): string {
  if (s.status === "cash_on_hand") return "Dinheiro no caixa";
  if (s.status === "settled") return `Na conta${s.settledOn ? ` em ${dayMonth(s.settledOn)}` : ""}`;
  return `Cartão aprovado · liquidação pendente${forecastText(s)}`;
}
