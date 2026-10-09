/** Rótulos pt-BR dos relatórios de vendas (F21), compartilhados pelas telas e pelas exportações. */
export const LOSS_REASON_LABEL: Record<string, string> = {
  expiry: "Vencimento",
  breakage: "Quebra",
  discard: "Descarte",
  internal_use: "Consumo interno",
  unknown: "Motivo não informado",
};
export const CANCELLATION_KIND_LABEL: Record<string, string> = {
  family: "Pela família",
  operational: "Pela equipe",
  not_picked_up: "Não retirado (reembolsado)",
  unknown: "Tipo não informado",
};
export const PURCHASE_KIND_LABEL: Record<string, string> = {
  purchase: "Compra",
  production: "Produção própria",
  opening: "Estoque inicial",
};
export const ADJUSTMENT_LABEL: Record<string, string> = {
  count_adjustment: "Contagem de inventário",
  adjustment: "Ajuste de estoque",
};
/** Tipos do livro das carteiras, separados por natureza (recarga ≠ venda ≠ reembolso ≠ transferência). */
export const LEDGER_TYPE_LABEL: Record<string, string> = {
  topup: "Crédito por recarga",
  topup_reversal: "Estorno de recarga",
  advance_purchase: "Compra antecipada (débito)",
  counter_purchase: "Compra no balcão (débito)",
  order_refund: "Reembolso de pedido",
  order_exchange: "Diferença de troca",
  transfer_out: "Transferência enviada",
  transfer_in: "Transferência recebida",
  adjustment: "Ajuste",
};
export const SALE_SITUATION_LABEL = {
  complete: "Completo",
  missing_cost: "Sem custo registrado",
  missing_revenue: "Sem receita registrada",
  missing_both: "Sem custo e sem receita",
} as const;
export const PENDENCY_LABEL: Record<string, string> = {
  cost_missing: "Vendas sem custo",
  revenue_missing: "Vendas sem receita",
  origin_missing: "Baixas sem origem",
  loss_cost_missing: "Perdas sem custo",
  fee_unknown: "Recebimentos sem taxa conhecida",
  pending_cost_unknown: "Pedidos a realizar sem custo médio",
  reversal_open: "Reversões externas pendentes",
  projection_building: "Dias em preparação",
  pending_older: "Pedidos em aberto antigos (fora da posição)",
};
export const labelOf = (map: Record<string, string>, key: string): string => map[key] ?? key;
/** Rótulo da pendência: fixos por código, e os dinâmicos (fonte truncada / documento ilegível) com o nome da fonte. */
export function pendencyLabel(code: string): string {
  if (code.startsWith("truncated_")) return `Leitura parcial: ${code.slice("truncated_".length)}`;
  if (code.startsWith("unreadable_")) return `Documentos ilegíveis: ${code.slice("unreadable_".length)}`;
  return labelOf(PENDENCY_LABEL, code);
}
