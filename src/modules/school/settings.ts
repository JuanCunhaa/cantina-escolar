import { FieldPath, FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction } from "firebase-admin/firestore";
import { z } from "zod";
import { addDays, isClockTime, isLocalDate, localDateOf, SCHOOL_TIMEZONE, type LocalDate } from "@/lib/dates/school-time";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { auditInTransaction } from "@/modules/audit/log";
import { isSafeLabel } from "@/modules/students/normalize";
import {
  DEFAULT_WEEKDAYS,
  evaluatePurchase,
  isOperatingDay,
  resolveCutoffs,
  snapshotPolicy,
  windowDates,
  type CalendarConfig,
  type CalendarDayKind,
  type PurchaseDecision,
  type PolicySnapshot,
  type PurchaseDenial,
  type ShiftCutoffs,
} from "./calendar";

/**
 * Identidade, dias de funcionamento e horários por turno (`settings/school`) e exceções por data (`calendarDays/{data}`).
 * Escrita só pelo servidor (administração). Alterações valem para NOVOS pedidos: pedidos existentes guardam o
 * snapshot de política (docs/domains/calendar.md); afetá-los exige ação explícita, prévia e auditoria (F11).
 */
export type SchoolSettings = {
  schoolName: string;
  weekdays: number[];
  shiftPolicies: Record<string, ShiftCutoffs>;
  version: number;
};

export const DEFAULT_SETTINGS: SchoolSettings = { schoolName: "", weekdays: [...DEFAULT_WEEKDAYS], shiftPolicies: {}, version: 0 };

const SETTINGS_PATH = "settings/school";
const MAX_FUTURE_DAYS = 400;

const key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const shiftId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const clock = z.string().refine(isClockTime, "Horário HH:MM inválido.");

export const settingsSchema = z.object({
  key,
  expectedVersion: z.number().int().min(0),
  schoolName: z.string().trim().min(1).max(80).refine(isSafeLabel, "Nome inválido."),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  shiftPolicies: z
    .record(shiftId, z.object({ purchaseCutoff: clock, cancelCutoff: clock }).strict())
    .refine((policies) => Object.keys(policies).length <= 50, "Turnos demais."),
});

export const calendarDaySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), key, date: z.string().refine(isLocalDate, "Data inválida."), kind: z.enum(["extra", "closed"]), reason: z.string().trim().max(120).refine(isSafeLabel, "Motivo inválido.") }),
  z.object({ action: z.literal("clear"), key, date: z.string().refine(isLocalDate, "Data inválida.") }),
]);

export function parseSettings(data: Record<string, unknown> | undefined): SchoolSettings {
  if (!data) return { ...DEFAULT_SETTINGS, weekdays: [...DEFAULT_WEEKDAYS], shiftPolicies: {} };
  return {
    schoolName: typeof data.schoolName === "string" ? data.schoolName : "",
    weekdays: Array.isArray(data.weekdays) ? data.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : [...DEFAULT_WEEKDAYS],
    shiftPolicies: (data.shiftPolicies as Record<string, ShiftCutoffs> | undefined) ?? {},
    version: typeof data.version === "number" ? data.version : 0,
  };
}

type Read = (ref: DocumentReference) => Promise<DocumentSnapshot>;
const readerFor = (tx?: Transaction): Read => (ref) => (tx ? tx.get(ref) : ref.get());

export async function updateSchoolSettings(db: Firestore, actor: Actor, raw: unknown): Promise<{ version: number; changed: boolean; replayed: boolean }> {
  authorize(actor, "students.manage");
  const input = settingsSchema.parse(raw);
  const weekdays = [...new Set(input.weekdays)].sort((a, b) => a - b);
  const { key: idemKey, expectedVersion, ...payload } = input;
  const next = { schoolName: input.schoolName, weekdays, shiftPolicies: input.shiftPolicies };
  return runIdempotentCommand(
    db,
    actor,
    { scope: "school.settings", key: idemKey, payload: { expectedVersion, ...payload, weekdays }, allow: (p) => p.role === "admin" },
    async ({ tx, actor: current, auditId }) => {
      const ref = db.doc(SETTINGS_PATH);
      const ids = Object.keys(input.shiftPolicies);
      const [settingsSnap, ...shifts] = await tx.getAll(ref, ...ids.map((id) => db.doc(`shifts/${id}`)));
      const before = parseSettings(settingsSnap?.data());
      if (before.version !== expectedVersion) throw conflict("stale_settings", "Configurações alteradas por outra pessoa.");
      if (shifts.some((s) => !s.exists)) throw notFound("shift_not_found", "Turno inexistente.");
      const version = before.version + 1;
      tx.set(ref, { ...next, version, updatedAt: FieldValue.serverTimestamp() });
      auditInTransaction(db, tx, auditId, {
        action: "school.settings.update",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        target: { type: "settings", id: "school" },
        before: { schoolName: before.schoolName, weekdays: before.weekdays, shiftPolicies: before.shiftPolicies, version: before.version },
        after: { ...next, version, appliesTo: "new_orders_only" },
      });
      return { version, changed: true };
    },
  );
}

export async function changeCalendarDay(db: Firestore, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ date: string; changed: boolean; replayed: boolean }> {
  authorize(actor, "students.manage");
  const input = calendarDaySchema.parse(raw);
  const today = localDateOf(now);
  if (input.date < today) throw invalid("past_date", "Não é possível alterar data passada.");
  if (input.date > addDays(today, MAX_FUTURE_DAYS)) throw invalid("too_far", "Data distante demais.");
  return runIdempotentCommand(
    db,
    actor,
    { scope: `school.calendar.${input.action}`, key: input.key, payload: input, allow: (p) => p.role === "admin" },
    async ({ tx, actor: current, auditId }) => {
      const ref = db.doc(`calendarDays/${input.date}`);
      const snap = await tx.get(ref);
      const before = snap.exists ? (snap.data() as { kind: CalendarDayKind; reason: string }) : null;
      let changed = true;
      if (input.action === "set") {
        changed = !before || before.kind !== input.kind || before.reason !== input.reason;
        if (changed) tx.set(ref, { date: input.date, kind: input.kind, reason: input.reason, updatedAt: FieldValue.serverTimestamp() });
      } else {
        changed = Boolean(before);
        if (changed) tx.delete(ref);
      }
      if (changed) {
        auditInTransaction(db, tx, auditId, {
          action: `school.calendar.${input.action}`,
          actorUid: current.uid,
          actorRole: current.role ?? null,
          target: { type: "calendarDay", id: input.date },
          before: before && { kind: before.kind, reason: before.reason },
          after: input.action === "set" ? { kind: input.kind, reason: input.reason, appliesTo: "new_orders_only" } : null,
        });
      }
      return { date: input.date, changed };
    },
  );
}

export async function loadSettings(db: Firestore, tx?: Transaction): Promise<SchoolSettings> {
  return parseSettings((await readerFor(tx)(db.doc(SETTINGS_PATH))).data());
}

async function loadCalendar(db: Firestore, settings: SchoolSettings, from: LocalDate, to: LocalDate): Promise<CalendarConfig> {
  const snap = await db.collection("calendarDays").where(FieldPath.documentId(), ">=", from).where(FieldPath.documentId(), "<=", to).get();
  const days: Record<LocalDate, CalendarDayKind> = {};
  for (const doc of snap.docs) {
    const kind = (doc.data() as { kind?: string }).kind;
    if (kind === "extra" || kind === "closed") days[doc.id] = kind;
  }
  return { weekdays: settings.weekdays, days };
}

export type PurchaseCheck = PurchaseDecision | { allowed: false; reason: "shift_unavailable" | "shift_not_configured" };

/**
 * Valida compra antecipada (calendário, janela e horário) com o relógio do servidor. Checkout/PDV (F11/F15) chamam isto
 * dentro da própria transação (`tx`): a decisão é refeita no momento da compra, e o snapshot devolvido vai no pedido.
 */
export async function checkPurchase(
  db: Firestore,
  input: { shiftId: string; date: string; now?: Date },
  tx?: Transaction,
): Promise<PurchaseCheck> {
  const now = input.now ?? new Date();
  const context = await purchaseContext(db, input, tx);
  if ("reason" in context) return context;
  return evaluatePurchase({ now, date: input.date, shiftId: input.shiftId, ...context });
}

type PurchaseContext = { cutoffs: ShiftCutoffs; calendar: CalendarConfig; settingsVersion: number } | { allowed: false; reason: "shift_unavailable" | "shift_not_configured" };

/** Leituras comuns da compra antecipada e do destino de reagendamento: turno, horários e calendário da data. */
async function purchaseContext(db: Firestore, input: { shiftId: string; date: string }, tx?: Transaction): Promise<PurchaseContext> {
  const read = readerFor(tx);
  const dateOk = isLocalDate(input.date);
  const [shiftSnap, settingsSnap, daySnap] = await Promise.all([
    read(db.doc(`shifts/${input.shiftId}`)),
    read(db.doc(SETTINGS_PATH)),
    dateOk ? read(db.doc(`calendarDays/${input.date}`)) : Promise.resolve(null),
  ]);
  const shift = shiftSnap.data() as { status?: string; nameSlug?: string } | undefined;
  if (!shift || shift.status !== "active") return { allowed: false, reason: "shift_unavailable" };
  const settings = parseSettings(settingsSnap.data());
  const resolved = resolveCutoffs(shift, settings.shiftPolicies, input.shiftId);
  if (!resolved) return { allowed: false, reason: "shift_not_configured" };
  const kind = (daySnap?.data() as { kind?: string } | undefined)?.kind;
  const days: Record<LocalDate, CalendarDayKind> = dateOk && (kind === "extra" || kind === "closed") ? { [input.date]: kind } : {};
  return { cutoffs: resolved.cutoffs, calendar: { weekdays: settings.weekdays, days }, settingsVersion: settings.version };
}

export type DestinationCheck = { allowed: true; snapshot: PolicySnapshot; cutoffPassed: boolean } | { allowed: false; reason: PurchaseDenial | "shift_unavailable" | "shift_not_configured" };

/**
 * Destino de reagendamento/troca (F16): as MESMAS regras da compra antecipada (turno ativo e configurado, hoje…hoje+7, dia de
 * funcionamento). A única diferença: horário de compra já encerrado não é recusado aqui — volta `cutoffPassed` com o snapshot
 * para o comando da EQUIPE exigir a exceção operacional explícita e auditada (nunca disponível ao responsável).
 */
export async function checkDestination(db: Firestore, input: { shiftId: string; date: string; now: Date }, tx?: Transaction): Promise<DestinationCheck> {
  const context = await purchaseContext(db, input, tx);
  if ("reason" in context) return context;
  const decision = evaluatePurchase({ now: input.now, date: input.date, shiftId: input.shiftId, ...context });
  if (decision.allowed) return { allowed: true, snapshot: decision.snapshot, cutoffPassed: false };
  if (decision.reason !== "after_cutoff") return decision;
  return { allowed: true, snapshot: snapshotPolicy({ shiftId: input.shiftId, date: input.date, cutoffs: context.cutoffs, settingsVersion: context.settingsVersion }), cutoffPassed: true };
}

export type CounterCheck = { allowed: true } | { allowed: false; reason: "shift_unavailable" | "non_operating_day" };

/**
 * Funcionamento do BALCÃO (PDV, F15) em `date` (hoje): turno ativo e dia de funcionamento (calendário F05). NÃO aplica o horário de
 * fechamento da compra antecipada (docs/domains/calendar.md: o fechamento antecipado não bloqueia o PDV no próprio dia) nem a
 * janela de 7 dias; a data da venda é sempre a do servidor. Chamar dentro da transação da venda (`tx`).
 */
export async function checkCounterDay(db: Firestore, input: { shiftId: string; date: LocalDate }, tx?: Transaction): Promise<CounterCheck> {
  const read = readerFor(tx);
  const [shiftSnap, settingsSnap, daySnap] = await Promise.all([read(db.doc(`shifts/${input.shiftId}`)), read(db.doc(SETTINGS_PATH)), read(db.doc(`calendarDays/${input.date}`))]);
  if ((shiftSnap.data() as { status?: string } | undefined)?.status !== "active") return { allowed: false, reason: "shift_unavailable" };
  const settings = parseSettings(settingsSnap.data());
  const kind = (daySnap.data() as { kind?: string } | undefined)?.kind;
  const days: Record<LocalDate, CalendarDayKind> = kind === "extra" || kind === "closed" ? { [input.date]: kind } : {};
  return isOperatingDay({ weekdays: settings.weekdays, days }, input.date) ? { allowed: true } : { allowed: false, reason: "non_operating_day" };
}

export type WindowDay = { date: LocalDate; operating: boolean; allowed: boolean; reason: PurchaseDenial | null; purchaseCutoffAt: string | null; cancelCutoffAt: string | null };
export type PurchaseWindow = { timezone: string; serverNow: string; today: LocalDate; cutoffs: ShiftCutoffs; days: WindowDay[] };

/** Janela hoje…hoje+7 do turno, para a tela (decisão final continua no checkout). */
export async function purchaseWindow(db: Firestore, shiftIdValue: string, now: Date = new Date()): Promise<PurchaseWindow> {
  const [shiftSnap, settings] = await Promise.all([db.doc(`shifts/${shiftIdValue}`).get(), loadSettings(db)]);
  const shift = shiftSnap.data() as { status?: string; nameSlug?: string } | undefined;
  if (!shift || shift.status !== "active") throw notFound("shift_unavailable", "Turno inexistente ou arquivado.");
  const resolved = resolveCutoffs(shift, settings.shiftPolicies, shiftIdValue);
  if (!resolved) throw conflict("shift_not_configured", "Horários do turno não configurados.");
  const dates = windowDates(now);
  const calendar = await loadCalendar(db, settings, dates[0]!, dates[dates.length - 1]!);
  const days = dates.map((date): WindowDay => {
    const decision = evaluatePurchase({ now, date, shiftId: shiftIdValue, cutoffs: resolved.cutoffs, calendar, settingsVersion: settings.version });
    const operating = isOperatingDay(calendar, date);
    return decision.allowed
      ? { date, operating, allowed: true, reason: null, purchaseCutoffAt: decision.snapshot.purchaseCutoffAt.toISOString(), cancelCutoffAt: decision.snapshot.cancelCutoffAt.toISOString() }
      : { date, operating, allowed: false, reason: decision.reason, purchaseCutoffAt: null, cancelCutoffAt: null };
  });
  return { timezone: SCHOOL_TIMEZONE, serverNow: now.toISOString(), today: dates[0]!, cutoffs: resolved.cutoffs, days };
}
