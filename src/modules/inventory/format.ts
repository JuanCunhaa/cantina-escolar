import { microsToReaisText } from "./cost";

/** Rótulos e formatação de estoque para a interface (pt-BR). Custos chegam em micro-centavos inteiros. */
export function formatCost(micros: number): string {
  const [whole, fraction] = microsToReaisText(Math.abs(micros)).split(",");
  return `${micros < 0 ? "-" : ""}R$ ${new Intl.NumberFormat("pt-BR").format(Number(whole))},${fraction}`;
}

export const MODE_LABEL = { physical: "Estoque físico", planned: "Planejado por data" } as const;

export const MOVEMENT_LABEL: Record<string, string> = {
  receipt: "Entrada",
  receipt_reversal: "Estorno de entrada",
  sale_exit: "Saída (entrega/venda)",
  loss: "Perda",
  count_adjustment: "Contagem",
  adjustment: "Ajuste",
};

export const LOSS_REASON_LABEL: Record<string, string> = {
  expiry: "Vencimento",
  breakage: "Quebra",
  discard: "Descarte",
  internal_use: "Consumo interno",
};

export const RECEIPT_KIND_LABEL: Record<string, string> = {
  purchase: "Compra",
  production: "Produção",
  opening: "Estoque inicial",
};
