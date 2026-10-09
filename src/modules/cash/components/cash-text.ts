import { formatBRL } from "@/lib/money/format";
import { parseBRLToCents } from "@/lib/money/parse";
import { PAYMENT_LABEL, type PaymentMethod } from "@/modules/payments/methods";
import type { ReviewStatus } from "../cash-model";

/** Valor digitado em reais → centavos; ZERO é válido (gaveta vazia); vazio ou inválido = null. */
export function parseCents(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  if (/^(?:R\$\s*)?0+(?:,0{1,2})?$/.test(t)) return 0;
  return parseBRLToCents(t);
}

/** Diferença com sinal e palavra (cor nunca é o único sinal). */
export function differenceText(cents: number): string {
  if (cents === 0) return "Sem diferença";
  return cents < 0 ? `Falta ${formatBRL(-cents)}` : `Sobra ${formatBRL(cents)}`;
}

export const REVIEW_TEXT: Record<ReviewStatus, string> = {
  not_required: "Sem divergência",
  pending: "Divergência pendente de revisão da administração",
  approved: "Divergência aprovada pela administração (sem ajuste)",
  followup: "Divergência em apuração pela administração",
};

export const methodLabel = (m: PaymentMethod): string => PAYMENT_LABEL[m];

const dateTime = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const when = (iso: string | null): string => (iso ? dateTime.format(new Date(iso)) : "—");
export const brDate = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
