import { z } from "zod";
import { PRICE_MAX_CENTS } from "@/modules/catalog/model";
import { PAYMENT_METHODS } from "@/modules/payments/methods";
import { isSafeLabel } from "@/modules/students/normalize";
import type { OrderItem } from "@/modules/orders/model";

/**
 * PDV de balcão (F15, docs/domains/pos.md §13). Regras puras: entrada validada do operador, snapshots e formas de
 * pagamento da venda direta. As transações (`commands.ts`) leem preço, cardápio, política, estoque e carteira NO SERVIDOR;
 * o cliente só informa o que viu (`expectedPriceCents`) para detectar mudança, nunca o valor cobrado.
 *
 * Tamanhos: cabem folgados nas 500 gravações/transação (≈ 4 por linha de estoque + pedido/lançamento/uso/auditoria).
 */
export const MAX_POS_LINES = 20; // produtos distintos por venda
export const MAX_POS_QUANTITY = 50; // unidades por linha (ex.: 10 balas)

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;

const lineSchema = z
  .object({
    productId: z.string().regex(ID),
    quantity: z.number().int().min(1).max(MAX_POS_QUANTITY),
    /** Preço que o operador VIU: só detecta mudança. O valor cobrado é sempre o atual do servidor. */
    expectedPriceCents: z.number().int().min(1).max(PRICE_MAX_CENTS),
  })
  .strict();

const linesSchema = z
  .array(lineSchema)
  .min(1)
  .max(MAX_POS_LINES)
  .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, "Produto repetido na venda.")
  // Ordem normalizada: o mesmo carrinho gera o mesmo hash de payload e a mesma numeração de linhas.
  .transform((lines) => [...lines].sort((a, b) => a.productId.localeCompare(b.productId)));

/** Venda com saldo da carteira do aluno. Campos desconhecidos (total, saldo, preço cobrado) são recusados. */
export const counterSaleSchema = z
  .object({
    key: z.string().regex(KEY),
    studentId: z.string().regex(ID),
    /** Turno que a tela exibiu; se o cadastro do aluno mudou, o operador precisa rever. */
    expectedShiftId: z.string().regex(ID),
    lines: linesSchema,
    /** Exceção de uso único registrada (autorização do responsável ou administrativa) para superar bloqueio/limite. */
    exceptionId: z.string().regex(ID).optional(),
  })
  .strict();
export type CounterSaleInput = z.infer<typeof counterSaleSchema>;

export { PAYMENT_LABEL, PAYMENT_METHODS, feeRecordOf, type FeeRecord, type PaymentMethod } from "@/modules/payments/methods";

export const BUYER_KINDS = ["teacher", "staff", "other"] as const;
export type BuyerKind = (typeof BUYER_KINDS)[number];
export const BUYER_LABEL: Record<BuyerKind, string> = { teacher: "Professor(a)", staff: "Funcionário(a)", other: "Outro" };

/**
 * Venda direta SEM aluno (professor, funcionário…), registrada só depois de o recebimento local ser confirmado
 * (`receivedConfirmed: true`). Não toca carteira, livro nem uso do responsável. A taxa do meio de pagamento, quando
 * conhecida, é informada pelo operador (centavos); sem cadastro de taxas ainda (tarefa de pagamentos), ela fica como
 * `informed` (valor dado) ou `pending` (cartão/Pix sem valor: a conferência vem depois), nunca inventada.
 */
export const directSaleSchema = z
  .object({
    key: z.string().regex(KEY),
    shiftId: z.string().regex(ID),
    lines: linesSchema,
    paymentMethod: z.enum(PAYMENT_METHODS),
    receivedConfirmed: z.literal(true),
    feeCents: z.number().int().min(0).max(PRICE_MAX_CENTS * MAX_POS_QUANTITY * MAX_POS_LINES).optional(),
    /** Maquininha cadastrada (F20); ausente = fonte padrão do meio. */
    sourceId: z.string().regex(/^term_[a-z0-9]{2,24}$/).optional(),
    buyerKind: z.enum(BUYER_KINDS).default("other"),
    buyerNote: z
      .string()
      .trim()
      .max(60)
      .refine(isSafeLabel, "Texto inválido.")
      .optional(),
  })
  .strict();
export type DirectSaleInput = z.infer<typeof directSaleSchema>;

/** Item de venda de balcão: snapshot do item pago e entregue na hora (sem reserva). */
export type CounterItem = Omit<OrderItem, "reservationId">;

export const counterReason = (date: string): string => `Compra no balcão em ${date}`;

