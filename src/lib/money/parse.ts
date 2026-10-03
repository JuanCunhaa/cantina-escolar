/**
 * Converte o texto digitado em reais (pt-BR) para centavos inteiros, sem ponto flutuante. Aceita "12", "12,5",
 * "12,50", "1.234,50" e prefixo "R$". Devolve null quando o texto não é um valor monetário válido (ou é zero).
 */
export function parseBRLToCents(text: string): number | null {
  const match = /^(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number((match[1] ?? "").replaceAll(".", ""));
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = whole * 100 + cents;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}
