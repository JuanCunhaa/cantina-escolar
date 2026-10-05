import { z } from "zod";
import { PRICE_MAX_CENTS } from "@/modules/catalog/model";
import { destinationShape } from "./fulfillment-model";
import { MAX_LINES_PER_DATE, MAX_LINE_QUANTITY } from "./model";

/**
 * Reagendamento/antecipação e troca de produtos (F16, docs/domains/pos.md §13). Regras puras e tipos compartilhados por
 * servidor e tela. Os dois comandos são da EQUIPE (`orders.amend`), com motivo obrigatório e auditoria:
 *
 *  - REAGENDAR move o restante de um pedido ainda sem entrega para outra data/turno do aluno: libera a reserva/cota e o uso
 *    da origem e reserva/compromete no destino, numa só transação. O pagamento e os preços do pedido ficam como estão
 *    (nenhum lançamento novo no livro, nenhuma segunda cobrança).
 *  - TROCAR substitui unidades REMANESCENTES de uma linha por outro produto da mesma data/turno: o valor PAGO das unidades
 *    que saem vira crédito, o produto novo custa o preço ATUAL do servidor e só a DIFERENÇA movimenta a carteira (um
 *    lançamento `order_exchange`, ou nenhum se a diferença for zero). Entregas, cancelamentos e movimentos antigos ficam.
 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const reason = z.string().trim().min(5, "Informe o motivo (mínimo 5 caracteres).").max(300);
/** Linhas por pedido depois de trocas (o checkout cria até 10; cada troca acrescenta linhas novas). */
export const MAX_ORDER_LINES = MAX_LINES_PER_DATE * 5;
const lineNo = z.number().int().min(1).max(MAX_ORDER_LINES);

export const rescheduleSchema = z.object({ key: z.string().regex(KEY), orderId: z.string().regex(ID), reason, ...destinationShape }).strict();
export type RescheduleInput = z.infer<typeof rescheduleSchema>;

const removeLine = z.object({ lineNo, quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) }).strict();
const addLine = z
  .object({
    productId: z.string().regex(ID),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
    /** Preço que a equipe VIU na prévia: só detecta mudança (o servidor cobra o preço dele). */
    expectedPriceCents: z.number().int().min(1).max(PRICE_MAX_CENTS),
  })
  .strict();

const exchangeBase = {
  orderId: z.string().regex(ID),
  remove: z.array(removeLine).min(1).max(MAX_LINES_PER_DATE),
  add: z.array(addLine).min(1).max(MAX_LINES_PER_DATE),
  overrideCutoff: z.boolean().default(false),
  exceptionId: z.string().regex(ID).optional(),
};
const uniqueExchange = (v: { remove: { lineNo: number }[]; add: { productId: string }[] }) =>
  new Set(v.remove.map((l) => l.lineNo)).size === v.remove.length && new Set(v.add.map((l) => l.productId)).size === v.add.length;
const normalizeExchange = <T extends { remove: { lineNo: number }[]; add: { productId: string }[] }>(v: T): T => ({
  ...v,
  remove: [...v.remove].sort((a, b) => a.lineNo - b.lineNo),
  add: [...v.add].sort((a, b) => a.productId.localeCompare(b.productId)),
});

/** Prévia (só leitura): o que sai, o que entra, a diferença calculada no servidor e se carteira/política permitem. */
export const exchangeQuoteSchema = z.object(exchangeBase).strict().refine(uniqueExchange, "Linha ou produto repetido.").transform(normalizeExchange);
export type ExchangeQuoteInput = z.infer<typeof exchangeQuoteSchema>;

/**
 * Confirmação: repete a prévia + `expectedDifferenceCents` (a diferença que a equipe CONFIRMOU). Se o servidor calcular outra
 * (preço, pagamento ou restante mudou), nada é gravado e a recusa devolve a nova prévia.
 */
export const exchangeSchema = z
  .object({ key: z.string().regex(KEY), reason, expectedDifferenceCents: z.number().int().min(-PRICE_MAX_CENTS * 400).max(PRICE_MAX_CENTS * 400), ...exchangeBase })
  .strict()
  .refine(uniqueExchange, "Linha ou produto repetido.")
  .transform(normalizeExchange);
export type ExchangeInput = z.infer<typeof exchangeSchema>;

/** Diferença da troca: + cobra da carteira, − devolve à carteira original, 0 não gera lançamento. */
export const exchangeDifference = (creditCents: number, chargeCents: number): number => chargeCents - creditCents;

export type ExchangeQuote = {
  orderId: string;
  version: number;
  consumptionDate: string;
  shiftId: string;
  removed: { lineNo: number; productId: string; name: string; quantity: number; creditCents: number }[];
  added: { productId: string; name: string; quantity: number; unitPriceCents: number; subtotalCents: number }[];
  creditCents: number;
  chargeCents: number;
  /** + cobra, − devolve, 0 sem lançamento. Calculada SEMPRE no servidor. */
  differenceCents: number;
  wallet: { balanceCents: number; sufficient: boolean };
  /** Política do aluno no destino (bloqueios e limites da data/semana): a equipe não supera sem exceção registrada. */
  policy: { allowed: boolean; violations: { kind: string }[] };
  /** Horário de compra da data já encerrado: a confirmação exige a exceção operacional explícita (`overrideCutoff`). */
  cutoffPassed: boolean;
};

/** Opções para a tela da equipe: datas de destino (turno ATUAL do aluno) e produtos do cardápio da data/turno do pedido. */
export type AmendOptions = {
  orderId: string;
  version: number;
  studentId: string;
  studentName: string;
  studentActive: boolean;
  consumptionDate: string;
  shiftId: string;
  today: string;
  /** Turno ATUAL do aluno (destino do reagendamento). */
  studentShiftId: string | null;
  destinations: { date: string; operating: boolean; allowed: boolean; cutoffPassed: boolean; reason: string | null }[];
  products: { id: string; name: string; priceCents: number; photoPath: string | null; categoryName: string }[];
  /** O que o pedido permite agora (o comando revalida tudo). */
  canReschedule: boolean;
  canExchange: boolean;
  blockedReason: string | null;
};
