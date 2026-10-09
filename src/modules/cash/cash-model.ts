import { z } from "zod";
import { addDays, isLocalDate, type LocalDate } from "@/lib/dates/school-time";
import { PAYMENT_METHODS, type PaymentMethod } from "@/modules/payments/methods";
import type { Point } from "@/modules/fees/receipt-labels";
import { isSafeLabel } from "@/modules/students/normalize";

/**
 * Fechamento de caixa por operador, ponto de recebimento e data local da escola (F20, docs/domains/reports-cash.md §16.4).
 * Regras puras, sem Firebase.
 *
 * Decisões de negócio (dono, 09/10/2026):
 *  - cada operador autorizado fecha SÓ o próprio caixa (a chave da sessão contém o UID de quem age); a administração consulta tudo,
 *    revisa divergências e é a única a reabrir (com motivo), preservando as versões anteriores;
 *  - saldo inicial informado E confirmado na abertura; contagem do dinheiro físico pelo TOTAL (sem cédulas/moedas); secretaria e
 *    balcão são caixas separados;
 *  - tolerância inicial de divergência: ZERO centavos — qualquer diferença fica pendente de revisão; registrar ou aprovar a diferença
 *    NÃO cria ajuste em carteira, recebimento, estoque nem livro;
 *  - dinheiro físico, Pix, cartão, liquidação e consumo com carteira são SEPARADOS: compra com saldo não é dinheiro novo no caixa.
 */
export const CASH_TOLERANCE_CENTS = 0;
export const MAX_CASH_CENTS = 100_000_00; // R$ 100.000,00 (teto de sanidade para saldo inicial/contagem)
export const MAX_RECEIPTS_PER_SESSION = 500;
/** Janela retroativa para abrir/fechar o caixa de um dia que ficou sem fechamento. */
export const MAX_BACKFILL_DAYS = 7;
export const ALERT_WINDOW_DAYS = 14;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const note = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || isSafeLabel(v), "Texto inválido.");
const reasonText = z
  .string()
  .trim()
  .min(10)
  .max(200)
  .refine(isSafeLabel, "Texto inválido.");
const cents = z.number().int().min(0).max(MAX_CASH_CENTS);

export const CASH_POINTS = ["secretaria", "counter"] as const;
export type CashPoint = Extract<Point, (typeof CASH_POINTS)[number]>;

export const openSchema = z
  .object({
    key: z.string().regex(KEY),
    point: z.enum(CASH_POINTS),
    /** Data do caixa (padrão: hoje no servidor); só até 7 dias para trás, para fechar um dia esquecido. */
    date: z.string().refine(isLocalDate, "Data inválida.").optional(),
    openingCents: cents,
    /** O operador confirma o valor contado na gaveta ao abrir. Sem confirmação não abre. */
    openingConfirmed: z.literal(true),
  })
  .strict();
export type OpenInput = z.infer<typeof openSchema>;

export const closeSchema = z
  .object({
    key: z.string().regex(KEY),
    sessionId: z.string().regex(ID),
    /** Dinheiro físico contado, pelo TOTAL (sem cédulas e moedas). */
    countedCashCents: cents,
    /** Conferência opcional do que o operador viu na conta Pix e na(s) maquininha(s); ausente = não conferido no caixa. */
    declared: z
      .object({ pixCents: cents.optional(), cardDebitCents: cents.optional(), cardCreditCents: cents.optional() })
      .strict()
      .optional(),
    note: note.optional(),
    /** Revisão da tela: se algo foi lançado depois que o operador viu o resumo, o fechamento é recusado (`stale_summary`). */
    expectedReceiptCount: z.number().int().min(0).max(MAX_RECEIPTS_PER_SESSION).optional(),
  })
  .strict();
export type CloseInput = z.infer<typeof closeSchema>;

export const reopenSchema = z.object({ key: z.string().regex(KEY), sessionId: z.string().regex(ID), reason: reasonText }).strict();
export const REVIEW_DECISIONS = ["approved", "followup"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export const REVIEW_DECISION_LABEL: Record<ReviewDecision, string> = { approved: "Diferença aprovada (sem ajuste)", followup: "Segue em apuração" };
export const reviewSchema = z.object({ key: z.string().regex(KEY), sessionId: z.string().regex(ID), closureNo: z.number().int().min(1).max(50), decision: z.enum(REVIEW_DECISIONS), note: reasonText }).strict();

export const sessionIdOf = (date: LocalDate, point: CashPoint, uid: string): string => `${date}__${point}__${uid}`;

/** O operador só escolhe o ponto do próprio papel: secretaria na mesa da secretaria, cantina no balcão; a administração em qualquer um. */
export function pointAllowed(role: string | null | undefined, point: CashPoint): boolean {
  if (role === "admin") return true;
  if (role === "secretaria") return point === "secretaria";
  if (role === "cantina") return point === "counter";
  return false;
}

export const backfillRange = (today: LocalDate): { min: LocalDate; max: LocalDate } => ({ min: addDays(today, -MAX_BACKFILL_DAYS), max: today });

/* ------------------------------------------------------------------------------------------- fechamento */

export type CashLineReceipt = { ref: string; kind: string; method: PaymentMethod; grossCents: number; reversedCents: number };

export type MethodTotals = { method: PaymentMethod; receiptCount: number; grossCents: number; reversedCents: number; netCents: number };

export type Closing = {
  byMethod: MethodTotals[];
  /** Saldo inicial + dinheiro recebido − estornado: o que DEVE haver na gaveta. */
  expectedCashCents: number;
  countedCashCents: number;
  /** contado − esperado (positivo = sobra; negativo = falta). */
  cashDifferenceCents: number;
  declared: Partial<Record<"pix" | "card_debit" | "card_credit", { declaredCents: number; expectedCents: number; differenceCents: number }>>;
  /** Maior diferença em módulo, entre dinheiro e conferências declaradas. */
  largestDifferenceCents: number;
  hasDivergence: boolean;
  receiptCount: number;
};

const DECLARED_KEY = { pixCents: "pix", cardDebitCents: "card_debit", cardCreditCents: "card_credit" } as const;

/**
 * Totais do fechamento a partir dos recebimentos EXTERNOS do operador no dia (dinheiro, Pix, cartão). Estorno é abatido do
 * recebimento a que pertence (líquido por meio). Compra com saldo da carteira não entra aqui: não é dinheiro novo.
 */
export function methodTotals(receipts: readonly CashLineReceipt[]): MethodTotals[] {
  const byMethod: MethodTotals[] = PAYMENT_METHODS.map((method) => ({ method, receiptCount: 0, grossCents: 0, reversedCents: 0, netCents: 0 }));
  for (const r of receipts) {
    const row = byMethod.find((m) => m.method === r.method)!;
    row.receiptCount += 1;
    row.grossCents += r.grossCents;
    row.reversedCents += r.reversedCents;
    row.netCents += r.grossCents - r.reversedCents;
  }
  return byMethod;
}

export const expectedCashOf = (openingCents: number, byMethod: readonly MethodTotals[]): number => openingCents + byMethod.find((m) => m.method === "cash")!.netCents;

export function computeClosing(input: { openingCents: number; receipts: readonly CashLineReceipt[]; countedCashCents: number; declared?: CloseInput["declared"] }): Closing {
  const byMethod = methodTotals(input.receipts);
  const expectedCashCents = expectedCashOf(input.openingCents, byMethod);
  const cashDifferenceCents = input.countedCashCents - expectedCashCents;
  const declared: Closing["declared"] = {};
  let largest = Math.abs(cashDifferenceCents);
  for (const [field, method] of Object.entries(DECLARED_KEY) as [keyof typeof DECLARED_KEY, "pix" | "card_debit" | "card_credit"][]) {
    const value = input.declared?.[field];
    if (value === undefined) continue;
    const expectedCents = byMethod.find((m) => m.method === method)!.netCents;
    const differenceCents = value - expectedCents;
    declared[method] = { declaredCents: value, expectedCents, differenceCents };
    largest = Math.max(largest, Math.abs(differenceCents));
  }
  return { byMethod, expectedCashCents, countedCashCents: input.countedCashCents, cashDifferenceCents, declared, largestDifferenceCents: largest, hasDivergence: largest > CASH_TOLERANCE_CENTS, receiptCount: input.receipts.length };
}

/* ----------------------------------------------------------------------------- movimentos posteriores */

export type AfterClose = { newReceipts: { ref: string; method: PaymentMethod; grossCents: number }[]; newReversals: { ref: string; method: PaymentMethod; addedCents: number }[]; count: number };

/**
 * Compara o que há HOJE para o operador/ponto/data com o que o fechamento viu: recebimento que não estava na lista e estorno que
 * cresceu depois. O fechamento nunca é reescrito; isto só IDENTIFICA o que veio depois (a administração decide reabrir).
 */
export function movementsAfterClose(closed: readonly CashLineReceipt[], current: readonly CashLineReceipt[]): AfterClose {
  const seen = new Map(closed.map((r) => [r.ref, r]));
  const newReceipts: AfterClose["newReceipts"] = [];
  const newReversals: AfterClose["newReversals"] = [];
  for (const r of current) {
    const before = seen.get(r.ref);
    if (!before) newReceipts.push({ ref: r.ref, method: r.method, grossCents: r.grossCents });
    else if (r.reversedCents > before.reversedCents) newReversals.push({ ref: r.ref, method: r.method, addedCents: r.reversedCents - before.reversedCents });
  }
  return { newReceipts, newReversals, count: newReceipts.length + newReversals.length };
}

/* --------------------------------------------------------------------------------------------- alertas */

export type CashAlertKind = "open_not_closed" | "receipts_without_session" | "divergence_pending" | "movements_after_close";
export const ALERT_LABEL: Record<CashAlertKind, string> = {
  open_not_closed: "Caixa aberto sem fechamento",
  receipts_without_session: "Recebimentos sem caixa aberto/fechado",
  divergence_pending: "Divergência pendente de revisão",
  movements_after_close: "Movimentos depois do fechamento",
};
export type CashAlert = { kind: CashAlertKind; date: LocalDate; point: CashPoint; operatorUid: string; operatorName: string | null; sessionId: string | null; detail: string | null };

export type SessionStatus = "open" | "closed" | "reopened";
export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = { open: "Aberto", closed: "Fechado", reopened: "Reaberto" };
export type ReviewStatus = "not_required" | "pending" | ReviewDecision;
