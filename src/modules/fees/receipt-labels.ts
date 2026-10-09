/** Rótulos e tipos puros dos recebimentos (F20): sem Firebase, seguros para importar em componentes do navegador. */
export const RECEIPT_KINDS = ["topup", "online_topup", "direct_sale"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];
export const RECEIPT_KIND_LABEL: Record<ReceiptKind, string> = { topup: "Recarga na secretaria", online_topup: "Recarga online", direct_sale: "Venda direta" };

/** Ponto de recebimento: mesa da secretaria, balcão da cantina ou online (sem operador, não entra em caixa físico). */
export const POINTS = ["secretaria", "counter", "online"] as const;
export type Point = (typeof POINTS)[number];
export const POINT_LABEL: Record<Point, string> = { secretaria: "Secretaria", counter: "Balcão da cantina", online: "Online" };
