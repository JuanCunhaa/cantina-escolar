import { formatBRL } from "@/lib/money/format";
import { dayMonth } from "@/modules/menu/format";
import type { Settlement } from "../topup-model";
import type { TopupView } from "../topup-queries";

export function statusText(t: Pick<TopupView, "status" | "reversedCents">): string {
  if (t.status === "reversed") return "Estornada";
  if (t.status === "partially_reversed") return `Estornada em parte (${formatBRL(t.reversedCents)})`;
  return "Confirmada";
}

/** Aprovação de cartão não é dinheiro no banco: a liquidação aparece separada. */
export function settlementText(s: Settlement): string {
  if (s.status === "cash_on_hand") return "Dinheiro no caixa";
  if (s.status === "settled") return `Na conta${s.settledOn ? ` em ${dayMonth(s.settledOn)}` : ""}`;
  return `Cartão aprovado · liquidação pendente${s.expectedOn ? ` (prevista ${dayMonth(s.expectedOn)})` : ""}`;
}
