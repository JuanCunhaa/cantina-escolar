"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { addDays, localDateOf, weekStartOf } from "@/lib/dates/school-time";
import { getFirebaseClient } from "@/lib/firebase/client";
import { MAX_ADVANCE_DAYS } from "@/modules/school/calendar";
import { parseException, type PolicyException } from "./model";

export type UsageState = {
  status: "loading" | "ready" | "error";
  /** Comprometimento por data (hoje … hoje+7) e por semana (atual e seguinte), em centavos. Ausente = 0. */
  days: Record<string, number>;
  weeks: Record<string, number>;
  exceptions: PolicyException[];
};

const committed = (data: Record<string, unknown>) => (typeof data.committedCents === "number" ? data.committedCents : 0);

/**
 * Comprometimento de consumo e autorizações ativas de UM aluno, ao vivo (Rules por vínculo ativo). É só leitura para
 * exibir o orçamento; quem decide é sempre o servidor no checkout/PDV. Listeners encerrados no cleanup.
 */
export function useStudentUsage(studentId: string): UsageState {
  const [state, setState] = useState<UsageState & { studentId: string }>({ studentId, status: "loading", days: {}, weeks: {}, exceptions: [] });

  useEffect(() => {
    const { db } = getFirebaseClient();
    const today = localDateOf(new Date());
    const last = addDays(today, MAX_ADVANCE_DAYS);
    const base = `studentUsage/${studentId}`;
    const fail = () => setState((s) => ({ ...s, studentId, status: "error" }));
    const ready = { days: false, weeks: false, exceptions: false };
    const part = (key: keyof typeof ready, patch: Partial<UsageState>) => {
      ready[key] = true;
      setState((s) => {
        const next = { ...(s.studentId === studentId ? s : { studentId, status: "loading" as const, days: {}, weeks: {}, exceptions: [] }), ...patch };
        return { ...next, studentId, status: ready.days && ready.weeks && ready.exceptions ? "ready" : "loading" };
      });
    };
    const stopDays = onSnapshot(
      query(collection(db, `${base}/days`), where("date", ">=", today), where("date", "<=", last), orderBy("date")),
      (snap) => part("days", { days: Object.fromEntries(snap.docs.map((d) => [d.id, committed(d.data())])) }),
      fail,
    );
    const stopWeeks = onSnapshot(
      query(collection(db, `${base}/weeks`), where("weekStart", ">=", weekStartOf(today)), where("weekStart", "<=", weekStartOf(last)), orderBy("weekStart")),
      (snap) => part("weeks", { weeks: Object.fromEntries(snap.docs.map((d) => [d.id, committed(d.data())])) }),
      fail,
    );
    const stopExceptions = onSnapshot(
      query(collection(db, `studentPolicies/${studentId}/exceptions`), where("status", "==", "active")),
      (snap) =>
        part("exceptions", {
          exceptions: snap.docs
            .flatMap((d) => parseException(d.id, d.data()) ?? [])
            .sort((a, b) => a.consumptionDate.localeCompare(b.consumptionDate)),
        }),
      fail,
    );
    return () => {
      stopDays();
      stopWeeks();
      stopExceptions();
    };
  }, [studentId]);

  return state.studentId === studentId ? state : { status: "loading", days: {}, weeks: {}, exceptions: [] };
}
