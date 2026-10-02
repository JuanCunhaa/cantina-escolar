import { SCHOOL_TIMEZONE } from "@/lib/dates/school-time";

/** Datas de consumo (YYYY-MM-DD locais) e instantes exibidos em pt-BR no fuso da escola. */
const shortDay = new Intl.DateTimeFormat("pt-BR", { timeZone: SCHOOL_TIMEZONE, weekday: "short", day: "2-digit", month: "2-digit" });
const weekdayOnly = new Intl.DateTimeFormat("pt-BR", { timeZone: SCHOOL_TIMEZONE, weekday: "short" });
const longDay = new Intl.DateTimeFormat("pt-BR", { timeZone: SCHOOL_TIMEZONE, weekday: "long", day: "2-digit", month: "2-digit" });
const clock = new Intl.DateTimeFormat("pt-BR", { timeZone: SCHOOL_TIMEZONE, hour: "2-digit", minute: "2-digit" });

/** Meio-dia local: a data de consumo nunca muda por causa do fuso de quem vê. */
const noon = (date: string) => new Date(`${date}T12:00:00-03:00`);

export const dayLabel = (date: string): string => shortDay.format(noon(date));
export const weekdayLabel = (date: string): string => weekdayOnly.format(noon(date)).replace(".", "");
export const longDayLabel = (date: string): string => longDay.format(noon(date));
export const dayMonth = (date: string): string => date.split("-").reverse().slice(0, 2).join("/");
export const clockLabel = (instant: string): string => clock.format(new Date(instant));
