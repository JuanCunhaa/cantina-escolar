import { addDays, isClockTime, isLocalDate, localDateOf, localInstant, SCHOOL_TIMEZONE, weekdayOf, type LocalDate } from "@/lib/dates/school-time";

/** Regras puras de calendário/horário (docs/domains/calendar.md). O servidor as aplica com o relógio do servidor. */
export const MAX_ADVANCE_DAYS = 7;
export const DEFAULT_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

export type ShiftCutoffs = { purchaseCutoff: string; cancelCutoff: string };
export type CalendarDayKind = "extra" | "closed";
export type CalendarConfig = {
  /** Dias da semana com funcionamento (0 = domingo … 6 = sábado). */
  weekdays: readonly number[];
  /** Exceções por data: `extra` habilita dia sem funcionamento regular; `closed` bloqueia dia regular. */
  days: Readonly<Record<LocalDate, CalendarDayKind>>;
};

/** Horários iniciais quando o turno ainda não foi configurado no painel (por nome normalizado do turno). */
export const DEFAULT_CUTOFFS: Readonly<Record<string, ShiftCutoffs>> = {
  manha: { purchaseCutoff: "07:00", cancelCutoff: "08:00" },
  tarde: { purchaseCutoff: "14:00", cancelCutoff: "15:00" },
};

export function isOperatingDay(config: CalendarConfig, date: LocalDate): boolean {
  const exception = config.days[date];
  if (exception === "closed") return false;
  if (exception === "extra") return true;
  return config.weekdays.includes(weekdayOf(date));
}

/** Política aplicada ao pedido: instantes UTC absolutos, estáveis mesmo que o painel mude depois. */
export type PolicySnapshot = {
  timezone: string;
  consumptionDate: LocalDate;
  shiftId: string;
  purchaseCutoff: string;
  cancelCutoff: string;
  purchaseCutoffAt: Date;
  cancelCutoffAt: Date;
  settingsVersion: number;
};

export function snapshotPolicy(input: { shiftId: string; date: LocalDate; cutoffs: ShiftCutoffs; settingsVersion: number }): PolicySnapshot {
  return {
    timezone: SCHOOL_TIMEZONE,
    consumptionDate: input.date,
    shiftId: input.shiftId,
    purchaseCutoff: input.cutoffs.purchaseCutoff,
    cancelCutoff: input.cutoffs.cancelCutoff,
    purchaseCutoffAt: localInstant(input.date, input.cutoffs.purchaseCutoff),
    cancelCutoffAt: localInstant(input.date, input.cutoffs.cancelCutoff),
    settingsVersion: input.settingsVersion,
  };
}

export type PurchaseDenial = "invalid_date" | "past_date" | "beyond_window" | "non_operating_day" | "after_cutoff";
export type PurchaseDecision = { allowed: true; snapshot: PolicySnapshot } | { allowed: false; reason: PurchaseDenial };

/**
 * Compra antecipada para `date` no turno: hoje até 7 dias corridos à frente (hoje+7 inclusive); dia sem
 * funcionamento é negado (não estende a janela); `agora >= limite` encerra a compra do próprio dia.
 */
export function evaluatePurchase(input: {
  now: Date;
  date: string;
  shiftId: string;
  cutoffs: ShiftCutoffs;
  calendar: CalendarConfig;
  settingsVersion?: number;
}): PurchaseDecision {
  if (!isLocalDate(input.date)) return { allowed: false, reason: "invalid_date" };
  const today = localDateOf(input.now);
  if (input.date < today) return { allowed: false, reason: "past_date" };
  if (input.date > addDays(today, MAX_ADVANCE_DAYS)) return { allowed: false, reason: "beyond_window" };
  if (!isOperatingDay(input.calendar, input.date)) return { allowed: false, reason: "non_operating_day" };
  const snapshot = snapshotPolicy({ shiftId: input.shiftId, date: input.date, cutoffs: input.cutoffs, settingsVersion: input.settingsVersion ?? 0 });
  if (input.now.getTime() >= snapshot.purchaseCutoffAt.getTime()) return { allowed: false, reason: "after_cutoff" };
  return { allowed: true, snapshot };
}

/** Cancelamento familiar: encerrado quando `agora >= limite` do snapshot do pedido (não do painel atual). */
export function isCancellationOpen(now: Date, snapshot: Pick<PolicySnapshot, "cancelCutoffAt">): boolean {
  return now.getTime() < snapshot.cancelCutoffAt.getTime();
}

/** As 8 datas da janela (hoje … hoje+7) em ordem. */
export function windowDates(now: Date): LocalDate[] {
  const today = localDateOf(now);
  return Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));
}

export function resolveCutoffs(
  shift: { nameSlug?: string },
  configured: Readonly<Record<string, ShiftCutoffs>>,
  shiftId: string,
): { cutoffs: ShiftCutoffs; source: "configured" | "default" } | null {
  const explicit = configured[shiftId];
  if (explicit && isClockTime(explicit.purchaseCutoff) && isClockTime(explicit.cancelCutoff)) return { cutoffs: explicit, source: "configured" };
  const fallback = shift.nameSlug ? DEFAULT_CUTOFFS[shift.nameSlug] : undefined;
  return fallback ? { cutoffs: fallback, source: "default" } : null;
}
