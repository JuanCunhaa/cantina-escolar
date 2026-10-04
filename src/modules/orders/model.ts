import { z } from "zod";
import { isLocalDate, type LocalDate } from "@/lib/dates/school-time";
import { PRICE_MAX_CENTS } from "@/modules/catalog/model";

/**
 * Pedido antecipado (F11, docs/domains/checkout.md): um pedido por aluno + data + turno, criado pelo checkout do site.
 * Aqui ficam só as regras puras: limites do lote, validação/normalização da entrada, IDs estáveis e revisão de preço.
 * A transação (autorização, calendário, cardápio, política, estoque, carteira) está em `commands.ts`.
 *
 * LOTE: confirmação única com várias datas é TUDO-OU-NADA — se qualquer data/linha for recusada nada é cobrado nem
 * reservado — e gera pedidos SEPARADOS por data (cada um com o próprio lançamento no livro, o que permite
 * cancelar/reembolsar uma data sem tocar nas outras). Tamanho máximo suportado e testado (cabe folgado nas 500
 * gravações/transação do Firestore: ≈ 4 gravações por linha + pedido/lançamento/uso por data):
 */
export const MAX_BATCH_DATES = 8; // = janela inteira hoje … hoje+7 (docs/domains/calendar.md)
export const MAX_LINES_PER_DATE = 10; // produtos distintos por pedido
export const MAX_BATCH_LINES = 40; // linhas somadas de todas as datas do lote
export const MAX_LINE_QUANTITY = 20; // unidades por linha (a tela usa o mesmo teto)

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;

const lineSchema = z
  .object({
    productId: z.string().regex(ID),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
    /** Preço que o cliente VIU: só detecta mudança (nunca é o valor cobrado). */
    expectedPriceCents: z.number().int().min(1).max(PRICE_MAX_CENTS),
  })
  .strict();

const daySchema = z
  .object({
    date: z.string().refine(isLocalDate, "Data inválida."),
    lines: z.array(lineSchema).min(1).max(MAX_LINES_PER_DATE),
  })
  .strict()
  .refine((d) => new Set(d.lines.map((l) => l.productId)).size === d.lines.length, "Produto repetido na mesma data.");

/**
 * Campos desconhecidos (total, preço cobrado, saldo…) são recusados: o cliente não tem como "informar" valores do
 * servidor. A ordem de datas/linhas é normalizada, de modo que o mesmo carrinho produz o mesmo hash de payload.
 */
export const checkoutSchema = z
  .object({
    key: z.string().regex(KEY),
    studentId: z.string().regex(ID),
    /** Turno que a tela exibiu; se o cadastro do aluno mudou, o carrinho precisa ser revisado. */
    expectedShiftId: z.string().regex(ID),
    days: z.array(daySchema).min(1).max(MAX_BATCH_DATES),
    /** Confirmação explícita do RESPONSÁVEL para superar limite/bloqueio (docs/domains/policies.md §9). */
    confirmed: z.boolean().default(false),
    /** Exceção de uso único registrada (aluno/funcionário); responsável usa `confirmed`. */
    exceptionId: z.string().regex(ID).optional(),
  })
  .strict()
  .refine((v) => new Set(v.days.map((d) => d.date)).size === v.days.length, "Data repetida no lote.")
  .refine((v) => v.days.reduce((n, d) => n + d.lines.length, 0) <= MAX_BATCH_LINES, `No máximo ${MAX_BATCH_LINES} linhas por confirmação.`)
  .transform((v) => ({
    ...v,
    days: [...v.days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ date: d.date, lines: [...d.lines].sort((a, b) => a.productId.localeCompare(b.productId)) })),
  }));
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Snapshot do item pago (nome/preço/quantidade do momento da compra; mudar o cadastro depois não altera o pedido). */
export type OrderItem = {
  lineNo: number;
  productId: string;
  name: string;
  categoryId: string;
  unit: "un";
  quantity: number;
  unitPriceCents: number;
  priceVersion: number;
  /** Desconto efetivo por linha (centavos); 0 enquanto a escola não tiver desconto. */
  discountCents: number;
  subtotalCents: number;
  source: "default" | "extra";
  reservationId: string;
  /** Progresso operacional (F13): unidades já entregues; ausente em pedidos anteriores = 0. A baixa de estoque é só destas. */
  deliveredQty?: number;
  /** Unidades canceladas/reembolsadas (F14 grava; ausente = 0). Já entram no cálculo de "restante". */
  canceledQty?: number;
};

export const ORDER_STATUSES = ["paid"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Texto do lançamento no livro (usado pelo servidor e pelo extrato local reconciliado). */
export const purchaseReason = (date: LocalDate): string => `Compra antecipada para ${date}`;

export const subtotalOf = (unitPriceCents: number, quantity: number): number => unitPriceCents * quantity;
export const totalOf = (items: readonly Pick<OrderItem, "subtotalCents">[]): number => items.reduce((sum, i) => sum + i.subtotalCents, 0);

export type PriceChange = { date: LocalDate; productId: string; name: string; expectedPriceCents: number; currentPriceCents: number };
export type ReviewedCart = {
  totalCents: number;
  days: { date: LocalDate; totalCents: number; lines: { productId: string; name: string; quantity: number; unitPriceCents: number; subtotalCents: number }[] }[];
};

/** Linhas do carrinho já resolvidas pelo servidor (preço ATUAL), na ordem das datas/produtos. */
export type ResolvedLine = { date: LocalDate; productId: string; name: string; quantity: number; expectedPriceCents: number; currentPriceCents: number };

/** Mudanças entre o preço que o cliente viu e o atual do servidor (qualquer diferença exige nova confirmação). */
export function priceChanges(lines: readonly ResolvedLine[]): PriceChange[] {
  return lines
    .filter((l) => l.expectedPriceCents !== l.currentPriceCents)
    .map((l) => ({ date: l.date, productId: l.productId, name: l.name, expectedPriceCents: l.expectedPriceCents, currentPriceCents: l.currentPriceCents }));
}

/** Carrinho com os preços do servidor, devolvido na recusa por mudança de preço para a tela mostrar o novo total. */
export function reviewedCart(lines: readonly ResolvedLine[]): ReviewedCart {
  const byDate = new Map<LocalDate, ReviewedCart["days"][number]>();
  for (const l of lines) {
    const day = byDate.get(l.date) ?? { date: l.date, totalCents: 0, lines: [] };
    const subtotalCents = subtotalOf(l.currentPriceCents, l.quantity);
    day.lines.push({ productId: l.productId, name: l.name, quantity: l.quantity, unitPriceCents: l.currentPriceCents, subtotalCents });
    day.totalCents += subtotalCents;
    byDate.set(l.date, day);
  }
  const days = [...byDate.values()];
  return { totalCents: days.reduce((sum, d) => sum + d.totalCents, 0), days };
}
