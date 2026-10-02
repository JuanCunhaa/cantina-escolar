"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { collection, doc, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { api } from "@/lib/api-client";
import { getFirebaseClient } from "@/lib/firebase/client";
import { DEFAULT_WEEKDAYS, isOperatingDay } from "@/modules/school/calendar";
import { overrideId, parseDefaultRule, parseOverride, type DefaultRule, type MenuOverride, type MenuWeek } from "./model";

/* ------------------------------------------------------------------------------------------------------ portal */

export type MenuWeekState = { status: "loading" | "ready" | "error"; week: MenuWeek | null; error: string | null; reload: () => void };
type Loaded = { key: string; week: MenuWeek | null; error: string | null };

/**
 * Cardápio da janela de compra resolvido pelo servidor (GET /api/menu). A família não lê a configuração do cardápio
 * diretamente (Rules fechadas): recebe só o resultado. Atualiza ao voltar à página (foco/visibilidade); preço e
 * disponibilidade finais são revalidados no checkout. Falha numa atualização mantém o último cardápio com aviso.
 */
export function useMenuWeek(user: User, studentId: string | null): MenuWeekState {
  const key = `${user.uid}|${studentId ?? "self"}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const url = studentId ? `/api/menu?studentId=${encodeURIComponent(studentId)}` : "/api/menu";
    void api<MenuWeek>(user, "GET", url).then((result) => {
      if (!alive) return;
      setLoaded((previous) =>
        result.ok
          ? { key, week: result.data, error: null }
          : { key, week: previous?.key === key ? previous.week : null, error: result.error },
      );
    });
    return () => {
      alive = false;
    };
  }, [user, studentId, key, tick]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (loaded?.key !== key) return { status: "loading", week: null, error: null, reload };
  return { status: loaded.week ? "ready" : "error", week: loaded.week, error: loaded.error, reload };
}

/* ---------------------------------------------------------------------------------------- operação (listeners) */

type Status = "loading" | "ready" | "error";

/** Regras do cardápio padrão ao vivo (cantina e administração; Rules negam aos demais). */
export function useDefaultRules(): { status: Status; rules: Map<string, DefaultRule> } {
  const [state, setState] = useState<{ status: Status; rules: Map<string, DefaultRule> }>({ status: "loading", rules: new Map() });
  useEffect(
    () =>
      onSnapshot(
        collection(getFirebaseClient().db, "defaultMenuRules"),
        (snap) => setState({ status: "ready", rules: new Map(snap.docs.map((d) => [d.id, parseDefaultRule(d.id, d.data())])) }),
        () => setState({ status: "error", rules: new Map() }),
      ),
    [],
  );
  return state;
}

/** Exceção de uma data/turno ao vivo; documento ausente = sem exceção (versão 0). */
export function useMenuOverride(date: string, shiftId: string): { status: Status; override: MenuOverride | null } {
  const id = date && shiftId ? overrideId(date, shiftId) : "";
  const [state, setState] = useState<{ id: string; status: Status; override: MenuOverride | null }>({ id: "", status: "loading", override: null });
  useEffect(() => {
    if (!id) return;
    return onSnapshot(
      doc(getFirebaseClient().db, "menuOverrides", id),
      (snap) => setState({ id, status: "ready", override: parseOverride(date, shiftId, snap.data()) }),
      () => setState({ id, status: "error", override: null }),
    );
  }, [id, date, shiftId]);
  return state.id === id && id ? state : { status: "loading", override: null };
}

/** Exceções a partir de `fromDate` (ordenadas por data; limitadas). Consulta de intervalo num campo: sem índice composto. */
export function useUpcomingOverrides(fromDate: string): { status: Status; overrides: MenuOverride[] } {
  const [state, setState] = useState<{ from: string; status: Status; overrides: MenuOverride[] }>({ from: "", status: "loading", overrides: [] });
  useEffect(
    () =>
      onSnapshot(
        query(collection(getFirebaseClient().db, "menuOverrides"), where("date", ">=", fromDate), orderBy("date"), limit(100)),
        (snap) =>
          setState({
            from: fromDate,
            status: "ready",
            overrides: snap.docs.map((d) => parseOverride(String(d.get("date")), String(d.get("shiftId")), d.data())),
          }),
        () => setState({ from: fromDate, status: "error", overrides: [] }),
      ),
    [fromDate],
  );
  return state.from === fromDate ? state : { status: "loading", overrides: [] };
}

/** Dia de funcionamento pelo calendário (F05: `settings/school` + `calendarDays/{data}`), para avisar na tela. */
export function useOperatingDay(date: string): boolean | null {
  const [weekdays, setWeekdays] = useState<readonly number[] | null>(null);
  const [day, setDay] = useState<{ date: string; kind: "extra" | "closed" | null } | null>(null);
  useEffect(
    () =>
      onSnapshot(
        doc(getFirebaseClient().db, "settings", "school"),
        (snap) => {
          const list = snap.get("weekdays");
          setWeekdays(Array.isArray(list) ? list.filter((d): d is number => Number.isInteger(d)) : DEFAULT_WEEKDAYS);
        },
        () => setWeekdays(null),
      ),
    [],
  );
  useEffect(() => {
    if (!date) return;
    return onSnapshot(
      doc(getFirebaseClient().db, "calendarDays", date),
      (snap) => {
        const kind = snap.get("kind");
        setDay({ date, kind: kind === "extra" || kind === "closed" ? kind : null });
      },
      () => setDay(null),
    );
  }, [date]);
  if (!weekdays || !date || day?.date !== date) return null;
  return isOperatingDay({ weekdays, days: day.kind ? { [date]: day.kind } : {} }, date);
}
