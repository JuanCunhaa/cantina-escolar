import { z } from "zod";
import { addDays, isLocalDate, type LocalDate } from "@/lib/dates/school-time";
import { conflict } from "@/lib/domain-error";
import type { ExpectedSettlement, SettlementBasis } from "@/modules/fees/fee-model";
import { isSafeLabel } from "@/modules/students/normalize";
import { PAYMENT_LABEL, PAYMENT_METHODS, feeRecordOf, type FeeRecord, type PaymentMethod } from "./methods";

/**
 * Recarga manual da secretaria (F17, docs/domains/payments.md §6.1–6.2 e access.md §4.3). Regras puras, sem Firebase.
 *
 * - Só depois do recebimento CONFIRMADO (`receivedConfirmed: true`): dinheiro em mãos, Pix conferido na conta, cartão
 *   aprovado na maquininha. Sem integração com provedor nesta etapa (F18/F19).
 * - O valor BRUTO recebido é creditado integralmente; a taxa do meio de pagamento é despesa da cantina: crédito = bruto,
 *   líquido = bruto − taxa (R$ 50 − R$ 1,50 → crédito R$ 50, líquido R$ 48,50). A taxa nunca entra na carteira.
 * - Aprovação de cartão NÃO é liquidação: o cartão fica com liquidação bancária `pending` (data prevista opcional); a
 *   confirmação da liquidação é do fechamento (F20).
 * - Referência externa (ID da transação Pix/E2E, NSU + autorização do cartão, nº do recibo em dinheiro) normalizada e única
 *   por FAMÍLIA de meio (pix, card, cash) em toda a escola: o mesmo recebimento não é lançado duas vezes, nem em outro aluno.
 */
export const MIN_TOPUP_CENTS = 100; // R$ 1,00
export const MAX_TOPUP_CENTS = 200_000; // R$ 2.000,00 por recebimento (teto de sanidade contra erro de digitação)
export const MAX_SETTLEMENT_DAYS = 90;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** Família do meio para a unicidade da referência: débito e crédito compartilham o NSU da maquininha. */
export type ReferenceFamily = "cash" | "pix" | "card";
export const familyOf = (method: PaymentMethod): ReferenceFamily => (method === "cash" ? "cash" : method === "pix" ? "pix" : "card");

/** Pix e cartão sempre têm identificador no comprovante; em dinheiro a referência (nº do recibo) é opcional. */
export const referenceRequired = (method: PaymentMethod): boolean => method !== "cash";

/** Normalização da referência: maiúsculas, só letras e dígitos ("e2e 123-45" ≡ "E2E12345"). */
export function normalizeReference(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}


const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => v === "" || isSafeLabel(v), "Texto inválido.");

export const topupSchema = z
  .object({
    key: z.string().regex(KEY),
    studentId: z.string().regex(ID),
    amountCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS),
    method: z.enum(PAYMENT_METHODS),
    /** O operador declara que o recebimento foi conferido (dinheiro contado, Pix na conta, cartão aprovado). */
    receivedConfirmed: z.literal(true),
    reference: text(60).optional(),
    /** Taxa do meio em centavos, quando já conhecida; ausente em Pix/cartão = pendente de conferência. */
    feeCents: z.number().int().min(0).max(MAX_TOPUP_CENTS).optional(),
    /** Cartão: data prevista da liquidação bancária (opcional). */
    expectedSettlementOn: z.string().refine(isLocalDate).optional(),
    /** Maquininha cadastrada (F20) usada no recebimento por cartão/Pix; ausente = fonte padrão do meio. */
    sourceId: z.string().regex(/^term_[a-z0-9]{2,24}$/).optional(),
    payerName: text(80).optional(),
    note: text(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const normalized = v.reference ? normalizeReference(v.reference) : "";
    if (referenceRequired(v.method) && normalized.length < 4) ctx.addIssue({ code: "custom", path: ["reference"], message: "Referência obrigatória para Pix/cartão." });
    if (v.reference && v.reference.trim() !== "" && normalized.length < 4) ctx.addIssue({ code: "custom", path: ["reference"], message: "Referência curta demais." });
    if (v.method === "cash" && v.feeCents) ctx.addIssue({ code: "custom", path: ["feeCents"], message: "Dinheiro não tem taxa." });
    if (v.feeCents !== undefined && v.feeCents > v.amountCents) ctx.addIssue({ code: "custom", path: ["feeCents"], message: "Taxa acima do valor." });
    if (v.sourceId && v.method === "cash") ctx.addIssue({ code: "custom", path: ["sourceId"], message: "Dinheiro não usa maquininha." });
    if (v.expectedSettlementOn && v.method !== "card_debit" && v.method !== "card_credit") ctx.addIssue({ code: "custom", path: ["expectedSettlementOn"], message: "Só cartão tem liquidação prevista." });
  });
export type TopupInput = z.infer<typeof topupSchema>;

export type Settlement = {
  /** cash_on_hand: dinheiro no caixa (depósito é do fechamento); settled: Pix conferido na conta; pending: cartão aprovado, a liquidar. */
  status: "cash_on_hand" | "settled" | "pending";
  expectedOn: LocalDate | null;
  settledOn: LocalDate | null;
  /** De onde veio a data prevista (F20): digitada pelo operador ou calculada pela regra de taxa/prazo em vigor. */
  expectedSource?: "operator" | "rule" | null;
  /** Base e prazo da previsão pela regra (F20): mostram de onde veio a data; nunca presumidos. Data digitada pelo operador não tem base. */
  expectedBasis?: SettlementBasis | null;
  expectedDays?: number | null;
  expectedRuleVersion?: number | null;
};

/** Liquidação pendente com a previsão pela regra (base, prazo e versão gravados) ou SEM data quando a regra não tem prazo configurado. */
export function pendingSettlement(rule: ExpectedSettlement | null): Settlement {
  return rule
    ? { status: "pending", expectedOn: rule.on, settledOn: null, expectedSource: "rule", expectedBasis: rule.basis, expectedDays: rule.days, expectedRuleVersion: rule.ruleVersion }
    : { status: "pending", expectedOn: null, settledOn: null, expectedSource: null };
}

/**
 * Liquidação ao registrar: dinheiro no caixa; Pix MANUAL conferido na conta = liquidado; cartão = pendente. A previsão digitada pelo
 * operador vale; sem ela, a da regra em vigor COM a base e o prazo usados (F20); sem prazo configurado, fica PENDENTE sem data (nunca inventada).
 */
export function settlementOf(method: PaymentMethod, receivedOn: LocalDate, expectedOn: LocalDate | undefined, rule: ExpectedSettlement | null = null): Settlement {
  if (method === "cash") return { status: "cash_on_hand", expectedOn: null, settledOn: null, expectedSource: null };
  if (method === "pix") return { status: "settled", expectedOn: null, settledOn: receivedOn, expectedSource: null };
  if (expectedOn) return { status: "pending", expectedOn, settledOn: null, expectedSource: "operator" };
  return pendingSettlement(rule);
}

/** Data prevista de liquidação: de hoje até +90 dias. */
export function checkSettlementDate(today: LocalDate, expectedOn: LocalDate | undefined): void {
  if (!expectedOn) return;
  if (expectedOn < today || expectedOn > addDays(today, MAX_SETTLEMENT_DAYS)) throw conflict("invalid_settlement_date", "Data prevista de liquidação fora do intervalo.", { min: today, max: addDays(today, MAX_SETTLEMENT_DAYS) });
}

export type TopupAmounts = { grossCents: number; creditedCents: number; fee: FeeRecord; netCents: number | null };

/** Crédito = bruto, sempre. Líquido só quando a taxa é conhecida. */
export function amountsOf(input: Pick<TopupInput, "amountCents" | "method" | "feeCents">): TopupAmounts {
  const fee = feeRecordOf(input.method, input.method === "cash" ? undefined : input.feeCents);
  return { grossCents: input.amountCents, creditedCents: input.amountCents, fee, netCents: fee.cents === null ? null : input.amountCents - fee.cents };
}

export const topupEntryReason = (method: PaymentMethod): string => `Recarga na secretaria · ${PAYMENT_LABEL[method]}`;
export const reversalEntryReason = (receivedOn: LocalDate): string => `Estorno de recarga de ${receivedOn.slice(8, 10)}/${receivedOn.slice(5, 7)}/${receivedOn.slice(0, 4)}`;

/* -------------------------------------------------------------------------------------------- estorno */

/**
 * registration_error: lançamento errado (aluno/valor trocado) — o estorno TOTAL libera a referência para um novo registro;
 * payment_not_received: o dinheiro não entrou (Pix não confirmado, cartão desfeito); payment_returned: valor devolvido ao
 * pagador. Nos dois últimos a referência continua bloqueada.
 */
export const REVERSAL_REASONS = ["registration_error", "payment_not_received", "payment_returned"] as const;
export type ReversalReason = (typeof REVERSAL_REASONS)[number];
export const REVERSAL_LABEL: Record<ReversalReason, string> = {
  registration_error: "Lançamento incorreto (aluno ou valor errado)",
  payment_not_received: "Pagamento não confirmado / desfeito",
  payment_returned: "Valor devolvido ao pagador",
};

export const reversalSchema = z
  .object({
    key: z.string().regex(KEY),
    topupId: z.string().regex(ID),
    amountCents: z.number().int().min(1).max(MAX_TOPUP_CENTS),
    reasonCode: z.enum(REVERSAL_REASONS),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(200)
      .refine(isSafeLabel, "Texto inválido."),
    /** Estornado acumulado que a tela viu: outro estorno no meio = 409 `stale_topup` (evita estorno duplicado por duas telas). */
    expectedReversedCents: z.number().int().min(0).max(MAX_TOPUP_CENTS),
  })
  .strict();
export type ReversalInput = z.infer<typeof reversalSchema>;

export type TopupStatus = "confirmed" | "partially_reversed" | "reversed";

export type ReversalPlan = { reversedAfterCents: number; reversibleAfterCents: number; status: TopupStatus; releaseReference: boolean };

/**
 * Estorno = NOVO movimento negativo na carteira original, limitado ao restante estornável E ao saldo atual. Crédito já gasto
 * não é estornado à força: nada fica negativo; o operador pode estornar até o saldo disponível e o restante segue visível
 * como estornável (tratamento fora do sistema, sem bloqueio automático nesta etapa).
 */
export function planReversal(topup: { amountCents: number; reversedCents: number; hasReference: boolean }, balanceCents: number, input: Pick<ReversalInput, "amountCents" | "reasonCode" | "expectedReversedCents">): ReversalPlan {
  const reversible = topup.amountCents - topup.reversedCents;
  if (input.expectedReversedCents !== topup.reversedCents) throw conflict("stale_topup", "A recarga foi estornada por outra operação: confira o valor atual.", { reversedCents: topup.reversedCents, reversibleCents: reversible });
  if (reversible <= 0) throw conflict("already_reversed", "Esta recarga já foi estornada por completo.");
  if (input.amountCents > reversible) throw conflict("exceeds_reversible", "O valor passa do que ainda pode ser estornado.", { reversibleCents: reversible });
  if (input.amountCents > balanceCents) throw conflict("insufficient_balance", "O saldo atual do aluno não cobre o estorno (o crédito já foi usado).", { balanceCents, reversibleCents: reversible, maxNowCents: Math.min(balanceCents, reversible) });
  const reversedAfterCents = topup.reversedCents + input.amountCents;
  const full = reversedAfterCents === topup.amountCents;
  return { reversedAfterCents, reversibleAfterCents: topup.amountCents - reversedAfterCents, status: full ? "reversed" : "partially_reversed", releaseReference: full && topup.hasReference && input.reasonCode === "registration_error" };
}
