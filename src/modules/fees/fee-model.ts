import { z } from "zod";
import { addDays, isLocalDate, type LocalDate } from "@/lib/dates/school-time";
import { isSafeLabel } from "@/modules/students/normalize";
import type { FeeRecord, PaymentMethod } from "@/modules/payments/methods";

/**
 * Cadastro de meios/provedores/maquininhas e regras de taxa VERSIONADAS (F20, docs/domains/payments.md §6.5). Regras puras,
 * sem Firebase. Nenhum percentual ou prazo é assumido: tudo vem de cadastro; o que for exemplo é marcado FICTÍCIO e é
 * recusado/ignorado em produção.
 *
 * - Uma SÉRIE por (fonte, meio): `feeSeries/{sourceId}__{method}` guarda as versões em ordem, só acrescentando. Uma versão
 *   nunca é editada: mudar a regra = nova versão com vigência estritamente posterior e nunca retroativa (≥ hoje).
 * - Estimativa = percentual (pontos-base, arredondado MEIO PARA CIMA em centavos) + fixo, calculada UMA vez no recebimento e
 *   gravada no lançamento com a versão aplicada (`feeEstimate`). Mudar o cadastro depois não reescreve o lançamento.
 * - Estimativa × real: o relatório usa a taxa conferida, senão a informada, senão a estimada — nunca duas para o mesmo recebimento.
 */
export const FEE_METHODS = ["pix", "card_debit", "card_credit"] as const;
export type FeeMethod = (typeof FEE_METHODS)[number];
export const isFeeMethod = (m: PaymentMethod): m is FeeMethod => m !== "cash";

/** Fonte sem maquininha/provedor cadastrado: regra "padrão" por meio. Sempre existe, nunca precisa de cadastro. */
export const DEFAULT_SOURCE_ID = "default";
export const SOURCE_KINDS = ["provider", "terminal"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_LABEL: Record<SourceKind, string> = { provider: "Provedor online", terminal: "Maquininha" };

export const MAX_PERCENT_BP = 3000; // 30,00% (teto de sanidade contra erro de digitação)
export const MAX_FIXED_CENTS = 10_000; // R$ 100,00
export const MAX_SETTLEMENT_DAYS = 90;
/**
 * Base do prazo de liquidação. NUNCA assumida: toda regra que tem prazo grava a base escolhida pela administração, e a previsão mostra
 * qual foi. Hoje só `calendar_days` (dias corridos) tem cálculo; `business_days` (dias úteis) depende de decisão do dono e de um
 * calendário bancário que não existe — não é aceito até lá. Sem prazo configurado, a previsão fica PENDENTE (sem data).
 */
export const SETTLEMENT_BASES = ["calendar_days"] as const;
export type SettlementBasis = (typeof SETTLEMENT_BASES)[number];
export const SETTLEMENT_BASIS_LABEL: Record<SettlementBasis, string> = { calendar_days: "dias corridos" };
export const MAX_VERSIONS_PER_SERIES = 100;
export const FICTITIOUS_PREFIX = "[FICTÍCIA] ";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const CODE = /^[a-z0-9]{2,24}$/;

const label = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine(isSafeLabel, "Texto inválido.");

/** ID da fonte: provedor `prov_<codigo>`, maquininha `term_<codigo>`; `default` é reservado. */
export const sourceIdOf = (kind: SourceKind, code: string): string => `${kind === "provider" ? "prov" : "term"}_${code}`;
/** O provedor online do Mercado Pago (F18/F19) tem fonte determinística: a confirmação do crédito lê a regra dela. */
export const ONLINE_SOURCE_ID = sourceIdOf("provider", "mercadopago");
export const seriesIdOf = (sourceId: string, method: FeeMethod): string => `${sourceId}__${method}`;

export const sourceSchema = z
  .object({
    key: z.string().regex(KEY),
    kind: z.enum(SOURCE_KINDS),
    code: z.string().regex(CODE, "Use 2 a 24 letras minúsculas ou números."),
    name: label(2, 60),
    methods: z.array(z.enum(FEE_METHODS)).min(1).max(3),
    fictitious: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.methods).size !== v.methods.length) ctx.addIssue({ code: "custom", path: ["methods"], message: "Meios repetidos." });
    if (v.kind === "provider" && v.methods.some((m) => m === "card_debit")) ctx.addIssue({ code: "custom", path: ["methods"], message: "Recarga online é Pix ou cartão de crédito 1x." });
  });
export type SourceInput = z.infer<typeof sourceSchema>;

export const sourceActiveSchema = z
  .object({ key: z.string().regex(KEY), sourceId: z.string().regex(ID), active: z.boolean(), reason: label(10, 200) })
  .strict();

export const ruleSchema = z
  .object({
    key: z.string().regex(KEY),
    sourceId: z.string().regex(ID),
    method: z.enum(FEE_METHODS),
    effectiveFrom: z.string().refine(isLocalDate, "Data inválida."),
    /** `enabled: false` encerra a regra a partir da vigência (sem taxa estimada depois dela). */
    enabled: z.boolean(),
    percentBp: z.number().int().min(0).max(MAX_PERCENT_BP),
    fixedCents: z.number().int().min(0).max(MAX_FIXED_CENTS),
    /** Prazo e base andam JUNTOS: os dois ausentes (null) = sem prazo configurado, a previsão de liquidação fica pendente. */
    settlementDays: z.number().int().min(0).max(MAX_SETTLEMENT_DAYS).nullable(),
    settlementBasis: z.enum(SETTLEMENT_BASES).nullable(),
    fictitious: z.boolean(),
    reason: label(10, 200),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.settlementDays === null) !== (v.settlementBasis === null)) ctx.addIssue({ code: "custom", path: ["settlementBasis"], message: "Prazo e base do prazo andam juntos: informe os dois ou nenhum." });
  });
export type RuleInput = z.infer<typeof ruleSchema>;

export const withdrawSchema = z
  .object({ key: z.string().regex(KEY), sourceId: z.string().regex(ID), method: z.enum(FEE_METHODS), version: z.number().int().min(1).max(MAX_VERSIONS_PER_SERIES), reason: label(10, 200) })
  .strict();

/** Versão guardada no array `versions` da série (só acrescenta; `withdrawn` só marca uma versão que ainda não passou a valer). */
export type RuleVersion = {
  n: number;
  effectiveFrom: LocalDate;
  enabled: boolean;
  percentBp: number;
  fixedCents: number;
  /** Versões antigas (sem base gravada) não têm prazo válido: a previsão fica pendente em vez de assumir dias corridos. */
  settlementDays?: number | null;
  settlementBasis?: SettlementBasis | null;
  fictitious: boolean;
  reason: string;
  createdByUid: string;
  createdOn: LocalDate;
  createdAtIso: string;
  withdrawn: { byUid: string; on: LocalDate; reason: string } | null;
};

export type FeeEstimate = {
  cents: number;
  seriesId: string;
  ruleVersion: number;
  effectiveFrom: LocalDate;
  percentBp: number;
  fixedCents: number;
  settlementDays: number | null;
  settlementBasis: SettlementBasis | null;
  fictitious: boolean;
  computedOn: LocalDate;
};

/* --------------------------------------------------------------------------------------------- cálculo */

/** Percentual em pontos-base (1 bp = 0,01%) sobre centavos, arredondado MEIO PARA CIMA (inteiro exato, sem ponto flutuante). */
export function percentFeeCents(grossCents: number, percentBp: number): number {
  return Math.floor((grossCents * percentBp + 5000) / 10_000);
}

export type EstimateOutcome = { ok: true; cents: number; percentCents: number; fixedCents: number } | { ok: false; issue: "exceeds_amount" };

/** Taxa estimada = percentual arredondado + fixo. Passar do valor recebido é inconsistência: não há estimativa (taxa fica pendente). */
export function estimateFee(grossCents: number, rule: Pick<RuleVersion, "percentBp" | "fixedCents">): EstimateOutcome {
  const percentCents = percentFeeCents(grossCents, rule.percentBp);
  const cents = percentCents + rule.fixedCents;
  if (cents > grossCents) return { ok: false, issue: "exceeds_amount" };
  return { ok: true, cents, percentCents, fixedCents: rule.fixedCents };
}

export type ResolveIssue = "no_rule" | "rule_disabled" | "fictitious_in_production";
export type Resolved = { rule: RuleVersion; issue: null } | { rule: null; issue: ResolveIssue };

/**
 * Versão em vigor na data do recebimento: a de maior `effectiveFrom` ≤ data entre as não retiradas. Desativada = sem regra.
 * Regra fictícia nunca vale em produção (nem para estimativa nem para previsão de liquidação).
 */
export function resolveRule(versions: readonly RuleVersion[], on: LocalDate, env: { production: boolean }): Resolved {
  let best: RuleVersion | null = null;
  for (const v of versions) {
    if (v.withdrawn || v.effectiveFrom > on) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom) best = v;
  }
  if (!best) return { rule: null, issue: "no_rule" };
  if (!best.enabled) return { rule: null, issue: "rule_disabled" };
  if (best.fictitious && env.production) return { rule: null, issue: "fictitious_in_production" };
  return { rule: best, issue: null };
}

/** Previsão de liquidação pela regra: a data E a base/prazo/versão usados (para mostrar de onde veio). */
export type ExpectedSettlement = { on: LocalDate; days: number; basis: SettlementBasis; ruleVersion: number };
export type RuleApplication = { estimate: FeeEstimate | null; expectedSettlement: ExpectedSettlement | null; issue: ResolveIssue | "exceeds_amount" | null };

/** Previsão pela regra: só com prazo E base gravados; dias corridos somam ao calendário. Sem prazo ou base = sem previsão (nada assumido). */
export function expectedSettlementOf(rule: RuleVersion, receivedOn: LocalDate): ExpectedSettlement | null {
  const days = rule.settlementDays ?? null;
  const basis = rule.settlementBasis ?? null;
  if (days === null || basis === null) return null;
  return { on: addDays(receivedOn, days), days, basis, ruleVersion: rule.n };
}

/** Aplica a regra em vigor ao recebimento: estimativa congelada com a versão usada e, se houver prazo configurado, a previsão de liquidação. */
export function applyRule(seriesId: string, versions: readonly RuleVersion[], input: { grossCents: number; receivedOn: LocalDate }, env: { production: boolean }): RuleApplication {
  const resolved = resolveRule(versions, input.receivedOn, env);
  if (!resolved.rule) return { estimate: null, expectedSettlement: null, issue: resolved.issue };
  const rule = resolved.rule;
  const expectedSettlement = expectedSettlementOf(rule, input.receivedOn);
  const out = estimateFee(input.grossCents, rule);
  if (!out.ok) return { estimate: null, expectedSettlement, issue: out.issue };
  return {
    estimate: { cents: out.cents, seriesId, ruleVersion: rule.n, effectiveFrom: rule.effectiveFrom, percentBp: rule.percentBp, fixedCents: rule.fixedCents, settlementDays: rule.settlementDays ?? null, settlementBasis: rule.settlementBasis ?? null, fictitious: rule.fictitious, computedOn: input.receivedOn },
    expectedSettlement,
    issue: null,
  };
}

/** Valida a publicação de uma versão contra as existentes e a data de hoje: nunca retroativa, sempre depois de todas as vigentes/futuras. */
export function checkNewVersion(versions: readonly RuleVersion[], input: Pick<RuleInput, "effectiveFrom">, today: LocalDate): { code: "effective_in_past" | "effective_not_after_last" | "too_many_versions"; details?: Record<string, unknown> } | null {
  if (versions.length >= MAX_VERSIONS_PER_SERIES) return { code: "too_many_versions" };
  if (input.effectiveFrom < today) return { code: "effective_in_past", details: { min: today } };
  const last = versions.filter((v) => !v.withdrawn).reduce<LocalDate | null>((max, v) => (max === null || v.effectiveFrom > max ? v.effectiveFrom : max), null);
  if (last !== null && input.effectiveFrom <= last) return { code: "effective_not_after_last", details: { lastEffectiveFrom: last } };
  return null;
}

/* ------------------------------------------------------------------------------- taxa efetiva do recebimento */

export type FeeBasis = "none" | "confirmed" | "informed" | "estimated" | "unknown";
export type EffectiveFee = { basis: FeeBasis; cents: number | null; estimatedCents: number | null; actualCents: number | null; differenceCents: number | null; fictitious: boolean };

/**
 * UMA taxa por recebimento: conferida > informada > estimada. A estimativa só vale enquanto não há valor real; quando há os dois,
 * a diferença (real − estimada) aparece, mas só o real entra nos totais. Dinheiro = sem taxa.
 */
export function effectiveFee(fee: FeeRecord | null | undefined, estimate: Pick<FeeEstimate, "cents" | "fictitious"> | null | undefined): EffectiveFee {
  const estimatedCents = estimate?.cents ?? null;
  const fictitious = estimate?.fictitious ?? false;
  if (!fee || fee.status === "pending") {
    return estimatedCents === null ? { basis: "unknown", cents: null, estimatedCents, actualCents: null, differenceCents: null, fictitious } : { basis: "estimated", cents: estimatedCents, estimatedCents, actualCents: null, differenceCents: null, fictitious };
  }
  if (fee.status === "none") return { basis: "none", cents: 0, estimatedCents, actualCents: 0, differenceCents: null, fictitious };
  const actualCents = fee.cents ?? 0;
  return { basis: fee.status === "confirmed" ? "confirmed" : "informed", cents: actualCents, estimatedCents, actualCents, differenceCents: estimatedCents === null ? null : actualCents - estimatedCents, fictitious };
}

export const FEE_BASIS_LABEL: Record<FeeBasis, string> = {
  none: "Sem taxa",
  confirmed: "Conferida",
  informed: "Informada no recebimento",
  estimated: "Estimada pela regra",
  unknown: "Sem valor (a conferir)",
};
