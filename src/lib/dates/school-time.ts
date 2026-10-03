/**
 * Datas locais da escola (America/Sao_Paulo) sobre instantes UTC. Instantes são `Date` (UTC); datas de consumo são
 * strings `YYYY-MM-DD` locais. Nada aqui depende do fuso do servidor ou do navegador.
 */
export const SCHOOL_TIMEZONE = "America/Sao_Paulo";

export type LocalDate = string;

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SCHOOL_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function parts(instant: Date): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const map: Record<string, number> = {};
  for (const p of formatter.formatToParts(instant)) if (p.type !== "literal") map[p.type] = Number(p.value);
  return { y: map.year!, m: map.month!, d: map.day!, h: map.hour!, mi: map.minute!, s: map.second! };
}

const pad = (n: number, size = 2) => String(n).padStart(size, "0");

/** Data local (YYYY-MM-DD) do instante. */
export function localDateOf(instant: Date): LocalDate {
  if (Number.isNaN(instant.getTime())) throw new RangeError("Instante inválido.");
  const p = parts(instant);
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

/** YYYY-MM-DD existente no calendário (rejeita 2026-02-30). */
export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function utcMidnight(date: LocalDate): Date {
  if (!isLocalDate(date)) throw new RangeError("Data local inválida.");
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** Soma dias corridos ao calendário (sem fuso envolvido). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const next = utcMidnight(date);
  next.setUTCDate(next.getUTCDate() + days);
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Dia da semana: 0 = domingo … 6 = sábado. */
export function weekdayOf(date: LocalDate): number {
  return utcMidnight(date).getUTCDay();
}

export const isClockTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** Instante UTC em que o relógio de São Paulo marca `time` (HH:MM) na data local `date`. */
export function localInstant(date: LocalDate, time: string): Date {
  if (!isClockTime(time)) throw new RangeError("Horário inválido.");
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offsetAt = (instantMs: number) => {
    const p = parts(new Date(instantMs));
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - instantMs;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess);
}

/** Segunda-feira (início da semana padrão, segunda a domingo) da semana que contém `date`. */
export function weekStartOf(date: LocalDate): LocalDate {
  const offset = (weekdayOf(date) + 6) % 7;
  return addDays(date, -offset);
}

/** Domingo (último dia) da semana que começa em `weekStart`. */
export function weekEndOf(weekStart: LocalDate): LocalDate {
  return addDays(weekStart, 6);
}
