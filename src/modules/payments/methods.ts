/**
 * Meios de pagamento recebidos presencialmente (balcão F15 e secretaria F17) e o registro da taxa. Sem cadastro de taxas
 * ainda (F20): a taxa, quando conhecida, é informada pelo operador em centavos e fica `informed`; Pix/cartão sem valor ficam
 * `pending` (conferência posterior), nunca inventada. Dinheiro não tem taxa de meio de pagamento.
 */
export const PAYMENT_METHODS = ["cash", "pix", "card_debit", "card_credit"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_LABEL: Record<PaymentMethod, string> = { cash: "Dinheiro", pix: "Pix", card_debit: "Cartão de débito", card_credit: "Cartão de crédito (1x)" };

export type FeeRecord = { status: "none" | "informed" | "pending"; cents: number | null; source: "operator" | "not_applicable" };

/** Taxa registrada: dinheiro não tem taxa de meio; Pix/cartão sem valor informado ficam pendentes de conferência. */
export function feeRecordOf(method: PaymentMethod, feeCents: number | undefined): FeeRecord {
  if (method === "cash") return { status: "none", cents: 0, source: "not_applicable" };
  if (feeCents === undefined) return { status: "pending", cents: null, source: "operator" };
  return { status: "informed", cents: feeCents, source: "operator" };
}
