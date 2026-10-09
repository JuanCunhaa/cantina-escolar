import type { IntentStatus } from "./intent-model";
import type { ProviderOrder } from "./provider";

/**
 * Confirmação confiável do pagamento online (F19), regras PURAS. A entrada é sempre a order lida pelo servidor no provedor
 * (nunca o status da notificação) e a intenção local; a saída é UMA decisão. Quem aplica é `confirmation.ts`, numa transação.
 *
 * Princípios:
 * - crédito só com `paid` + identidade (referência = ID da intenção, order e conta) + moeda BRL + total = pago = valor da intenção;
 * - estados nunca regridem: notificação/consulta atrasada (ex.: "pendente" depois de "pago") é `noop`; só `confirmed` → reversão;
 * - nada é descartado por expiração LOCAL: pagamento confirmado depois de `failed`/`expired`/Pix vencido é creditado;
 * - divergência com dinheiro recebido NÃO é ignorada nem corrigida em silêncio: vai para `in_review` (administração);
 * - status desconhecido do provedor nunca credita nem muda a intenção.
 */

/** Estados em que um pagamento confirmado pode ser creditado (nenhum estado local de "falha" descarta um pagamento real). */
export const CREDITABLE: readonly IntentStatus[] = ["creating", "creation_uncertain", "awaiting_payment", "processing", "failed", "expired", "in_review"];
/** Estados ainda sem desfecho final no provedor: a notícia de falha/expiração pode encerrá-los. */
const OPEN_FOR_FAILURE: readonly IntentStatus[] = ["creating", "creation_uncertain", "awaiting_payment", "processing"];

export type ReviewReason = "account_mismatch" | "order_mismatch" | "currency_mismatch" | "amount_mismatch" | "environment_mismatch" | "balance_limit" | "reversal_before_credit";

export const REVIEW_LABEL: Record<ReviewReason, string> = {
  account_mismatch: "Pagamento em conta diferente da cadastrada",
  order_mismatch: "Pagamento de outra cobrança vinculada à mesma recarga",
  currency_mismatch: "Moeda diferente de BRL",
  amount_mismatch: "Valor pago diferente do valor da recarga",
  environment_mismatch: "Ambiente do pagamento diferente do ambiente da aplicação",
  balance_limit: "Crédito ultrapassaria o limite de saldo da carteira",
  reversal_before_credit: "Reembolso parcial ou contestação antes do crédito",
};

export type IntentFacts = {
  intentId: string;
  status: IntentStatus;
  amountCents: number;
  chargeId: string | null;
  providerId: string;
  /** Reversões já CONTABILIZADAS (recuperado + pendente), acumulado em centavos. */
  accountedReversalCents: number;
  /** Motivo de revisão já registrado (evita reescrever a mesma revisão). */
  reviewReason: ReviewReason | null;
  /** Sinal de contestação já registrado na intenção (F19). */
  dispute: DisputeStatus | null;
  /** Causa da última reversão contabilizada (reembolso × chargeback perdido). */
  reversalCause: "refund" | "chargeback" | null;
};

/**
 * Contestação (chargeback) no provedor: `open` = em andamento (`charged_back/in_process`), SEM débito; `lost` = perdida
 * (`settled`, valor debitado — vira reversão); `won` = ganha (`reimbursed`); `won_after_reversal` = o provedor informa que a
 * contestação foi ganha DEPOIS de já termos debitado a carteira: nenhuma devolução automática, vai para a administração.
 */
export type DisputeStatus = "open" | "lost" | "won" | "won_after_reversal";

/**
 * `accountId` (conta das credenciais) e `providerId` vêm da configuração do servidor. Nada vem do corpo da notificação: a
 * assinatura do Mercado Pago NÃO cobre o corpo, então `live_mode`/`user_id` do corpo só servem para IGNORAR uma entrega
 * (`confirmation.ts`), nunca para mudar o estado de uma recarga.
 */
export type DecisionContext = { accountId: string; providerId: string };

export type Decision =
  | { kind: "credit" }
  | { kind: "review"; reason: ReviewReason }
  | { kind: "fail"; code: string }
  | { kind: "expire" }
  | { kind: "reverse"; targetCents: number; cause: "refund" | "chargeback" }
  | { kind: "dispute"; status: DisputeStatus }
  | { kind: "noop"; reason: string };

const noop = (reason: string): Decision => ({ kind: "noop", reason });

/** Identidade e ambiente: o que torna a order "esta" recarga. `null` = confere. */
export function identityProblem(intent: IntentFacts, order: ProviderOrder, ctx: DecisionContext): ReviewReason | null {
  if (order.accountId !== ctx.accountId) return "account_mismatch";
  if (intent.providerId !== ctx.providerId) return "environment_mismatch";
  if (intent.chargeId !== null && intent.chargeId !== order.orderId) return "order_mismatch";
  return null;
}

/** Valor e moeda de um pagamento: total = pago = valor da intenção, em BRL, em centavos inteiros. */
export function amountProblem(intent: IntentFacts, order: ProviderOrder): ReviewReason | null {
  if (order.currency !== "BRL") return "currency_mismatch";
  if (!Number.isSafeInteger(order.totalCents) || !Number.isSafeInteger(order.paidCents)) return "amount_mismatch";
  if (order.totalCents !== intent.amountCents || order.paidCents !== intent.amountCents) return "amount_mismatch";
  return null;
}

/**
 * Decisão única. A intenção foi achada pelo `external_reference` da order (conferido por quem chama); aqui conferem-se conta,
 * ambiente, order, moeda e valor.
 */
export function decide(intent: IntentFacts, order: ProviderOrder, ctx: DecisionContext): Decision {
  // Revertida: nada mais muda, EXCETO uma contestação ganha depois do débito (a administração precisa saber).
  if (intent.status === "reversed" && order.state !== "dispute_won") return noop("already_reversed");
  const problem = identityProblem(intent, order, ctx);

  switch (order.state) {
    case "paid": {
      if (intent.status === "confirmed") return noop("already_credited");
      if (!CREDITABLE.includes(intent.status)) return noop("not_creditable");
      const reason = problem ?? amountProblem(intent, order);
      if (reason) return intent.status === "in_review" && intent.reviewReason === reason ? noop("review_unchanged") : { kind: "review", reason };
      return { kind: "credit" };
    }
    case "pending":
      return noop("still_pending");
    case "unknown":
      return noop("unknown_status");
    case "failed":
    case "expired": {
      if (problem || !OPEN_FOR_FAILURE.includes(intent.status)) return noop("no_transition");
      return order.state === "expired" ? { kind: "expire" } : { kind: "fail", code: "provider_rejected" };
    }
    case "dispute_open":
    case "dispute_won": {
      if (problem) return noop("identity_mismatch");
      if (intent.status === "confirmed" || intent.status === "reversed") {
        if (order.state === "dispute_open") return intent.dispute === "open" || intent.dispute === "lost" || intent.accountedReversalCents > 0 ? noop("dispute_already_known") : { kind: "dispute", status: "open" };
        // ganha: se já debitamos por perda (chargeback), só a administração decide; senão limpa o sinal
        const status: DisputeStatus = intent.reversalCause === "chargeback" && intent.accountedReversalCents > 0 ? "won_after_reversal" : "won";
        return intent.dispute === status ? noop("dispute_already_known") : { kind: "dispute", status };
      }
      if (intent.status === "in_review") return noop("in_review");
      if (!CREDITABLE.includes(intent.status)) return noop("not_creditable");
      // Pagamento disputado e ainda sem crédito: nenhuma decisão automática (nem crédito nem devolução) — revisão humana.
      return { kind: "review", reason: "reversal_before_credit" };
    }
    case "refunded":
    case "partially_refunded":
    case "chargeback": {
      if (problem) return noop("identity_mismatch");
      const cause = order.state === "chargeback" ? "chargeback" : "refund";
      if (intent.status === "confirmed") {
        const target = Math.min(order.reversedCents, intent.amountCents);
        if (!Number.isSafeInteger(target) || target <= intent.accountedReversalCents) return noop("reversal_already_accounted");
        return { kind: "reverse", targetCents: target, cause };
      }
      if (intent.status === "in_review") return noop("in_review");
      if (!CREDITABLE.includes(intent.status)) return noop("not_creditable");
      // Nunca creditado: devolução total = dinheiro foi e voltou (sem crédito); parcial ou chargeback exigem decisão humana.
      if (order.state === "refunded" && order.reversedCents >= intent.amountCents) return { kind: "fail", code: "refunded_before_credit" };
      return { kind: "review", reason: "reversal_before_credit" };
    }
  }
}

/** Parte do estorno que a carteira cobre agora e parte que vira pendência (nunca saldo negativo). */
export function splitRecovery(addedCents: number, balanceCents: number): { recoveredCents: number; pendingCents: number } {
  const recoveredCents = Math.max(0, Math.min(addedCents, balanceCents));
  return { recoveredCents, pendingCents: addedCents - recoveredCents };
}
