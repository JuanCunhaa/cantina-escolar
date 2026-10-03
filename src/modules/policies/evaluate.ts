import { weekEndOf, weekStartOf, type LocalDate } from "@/lib/dates/school-time";
import type { PolicyException, StudentPolicy } from "./model";

/**
 * Avaliador ÚNICO de política de compra, compartilhado por checkout (site) e PDV (balcão). Puro: quem chama lê
 * política, uso e exceção DENTRO da transação do comando (ver `purchase-guard.ts`) e decide com este resultado.
 *
 * Regras (docs/domains/policies.md §9):
 * - permissão de canal é o interruptor do aluno (`allowSitePurchase`/`allowCounterPurchase`); não é contornada por exceção;
 * - bloqueios por produto/categoria e limites diário/semanal por DATA DO CONSUMO controlam a AUTONOMIA do aluno;
 * - o responsável pode superar as próprias restrições com confirmação explícita (efeito no orçamento mostrado) e a
 *   compra continua contando como consumo; aluno e funcionário só com exceção de uso único registrada
 *   (autorização do responsável ou exceção administrativa auditada).
 */
export type PurchaseChannel = "advance" | "counter";
export type ActorKind = "guardian" | "student" | "staff";

export type PurchaseLine = { consumptionDate: LocalDate; productId: string; categoryId: string; amountCents: number };

/** Comprometimento já registrado por data/semana (ativos + entregues + balcão, menos reembolsos). */
export type UsageView = { days: Readonly<Record<LocalDate, number>>; weeks: Readonly<Record<LocalDate, number>> };

export type Violation =
  | { kind: "channel_not_allowed"; channel: PurchaseChannel }
  | { kind: "product_blocked"; productId: string }
  | { kind: "category_blocked"; categoryId: string }
  | { kind: "daily_limit_exceeded"; date: LocalDate; limitCents: number; committedCents: number; requestedCents: number }
  | { kind: "weekly_limit_exceeded"; weekStart: LocalDate; weekEnd: LocalDate; limitCents: number; committedCents: number; requestedCents: number };

/** Efeito no orçamento por data/semana, para exibir ao usuário antes de confirmar. */
export type BudgetEffect = {
  key: LocalDate;
  /** Só semanas: último dia (domingo) do intervalo informado ao usuário. */
  weekEnd?: LocalDate;
  committedCents: number;
  requestedCents: number;
  afterCents: number;
  limitCents: number | null;
  /** Quanto ainda cabe ANTES desta compra (null = sem teto); nunca negativo. */
  remainingBeforeCents: number | null;
  exceeds: boolean;
};

export type PurchaseEvaluation = {
  allowed: boolean;
  /** Responsável com restrição a superar: a interface deve pedir a confirmação explícita e reenviar. */
  needsConfirmation: boolean;
  violations: Violation[];
  days: BudgetEffect[];
  weeks: BudgetEffect[];
  /** Como as restrições foram superadas, quando foram. */
  override: { via: "guardian_confirmation" } | { via: "exception"; exceptionId: string; kind: "guardian" | "admin" } | null;
  totalCents: number;
};

export type EvaluateInput = {
  channel: PurchaseChannel;
  actorKind: ActorKind;
  /** Decisão canônica de autorização do aluno (vínculo/papel/permissão/aluno ativo) — `decideStudentAction`. */
  permitted: boolean;
  policy: StudentPolicy;
  lines: readonly PurchaseLine[];
  usage: UsageView;
  /** Confirmação explícita do responsável na interface. Ignorada para aluno/funcionário. */
  confirmed?: boolean;
  exception?: PolicyException | null;
};

function groupBy(lines: readonly PurchaseLine[], key: (line: PurchaseLine) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(key(l), (out.get(key(l)) ?? 0) + l.amountCents);
  return out;
}

function effect(key: LocalDate, committed: number, requested: number, limit: number | null, weekEnd?: LocalDate): BudgetEffect {
  const after = committed + requested;
  return {
    key,
    ...(weekEnd ? { weekEnd } : {}),
    committedCents: committed,
    requestedCents: requested,
    afterCents: after,
    limitCents: limit,
    remainingBeforeCents: limit === null ? null : Math.max(0, limit - committed),
    exceeds: limit !== null && after > limit,
  };
}

/** Teto exato: R$ 8 comprometidos e teto R$ 10 deixam R$ 2; R$ 3 excedem; exatamente R$ 2 cabem. */
export function evaluatePurchasePolicy(input: EvaluateInput): PurchaseEvaluation {
  const { policy, lines, usage } = input;
  const totalCents = lines.reduce((acc, l) => acc + l.amountCents, 0);
  const perDay = groupBy(lines, (l) => l.consumptionDate);
  const perWeek = groupBy(lines, (l) => weekStartOf(l.consumptionDate));
  const days = [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([d, v]) => effect(d, usage.days[d] ?? 0, v, policy.dailyLimitCents));
  const weeks = [...perWeek]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([w, v]) => effect(w, usage.weeks[w] ?? 0, v, policy.weeklyLimitCents, weekEndOf(w)));

  const result = (violations: Violation[], allowed: boolean, needsConfirmation: boolean, override: PurchaseEvaluation["override"]): PurchaseEvaluation => ({
    allowed,
    needsConfirmation,
    violations,
    days,
    weeks,
    override,
    totalCents,
  });

  if (!input.permitted || lines.length === 0 || lines.some((l) => !Number.isSafeInteger(l.amountCents) || l.amountCents <= 0)) {
    return result([{ kind: "channel_not_allowed", channel: input.channel }], false, false, null);
  }

  const soft: Violation[] = [];
  const blockedProducts = new Set(policy.blockedProductIds);
  const blockedCategories = new Set(policy.blockedCategoryIds);
  for (const id of new Set(lines.map((l) => l.productId))) if (blockedProducts.has(id)) soft.push({ kind: "product_blocked", productId: id });
  for (const id of new Set(lines.map((l) => l.categoryId))) if (blockedCategories.has(id)) soft.push({ kind: "category_blocked", categoryId: id });
  for (const d of days) {
    if (d.exceeds) soft.push({ kind: "daily_limit_exceeded", date: d.key, limitCents: d.limitCents!, committedCents: d.committedCents, requestedCents: d.requestedCents });
  }
  for (const w of weeks) {
    if (w.exceeds) {
      soft.push({ kind: "weekly_limit_exceeded", weekStart: w.key, weekEnd: w.weekEnd!, limitCents: w.limitCents!, committedCents: w.committedCents, requestedCents: w.requestedCents });
    }
  }
  if (soft.length === 0) return result([], true, false, null);

  if (input.actorKind === "guardian") {
    return input.confirmed === true ? result(soft, true, false, { via: "guardian_confirmation" }) : result(soft, false, true, null);
  }
  const ex = input.exception;
  const covers = ex && ex.status === "active" && [...perDay.keys()].every((d) => d === ex.consumptionDate) && totalCents <= ex.maxCents;
  return covers ? result(soft, true, false, { via: "exception", exceptionId: ex.id, kind: ex.kind }) : result(soft, false, false, null);
}
