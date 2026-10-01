"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFirebaseClient } from "@/lib/firebase/client";

export type Unit = { id: string; name: string; status: "active" | "archived" };
export type UnitsState = { status: "loading" | "ready" | "error"; classes: Unit[]; shifts: Unit[] };

function listen(name: "classes" | "shifts", set: (units: Unit[]) => void, fail: () => void): () => void {
  const { db } = getFirebaseClient();
  return onSnapshot(
    query(collection(db, name), orderBy("name")),
    (snap) => set(snap.docs.map((d) => ({ id: d.id, name: String(d.data().name), status: d.data().status === "archived" ? "archived" : "active" }))),
    fail,
  );
}

/** Turmas e turnos ao vivo (leitura permitida pelas Rules a contas com perfil ativo; escrita só pelo servidor). */
export function useUnits(): UnitsState {
  const [state, setState] = useState<UnitsState>({ status: "loading", classes: [], shifts: [] });
  useEffect(() => {
    const loaded = new Set<string>();
    const mark = (name: string) => {
      loaded.add(name);
      if (loaded.size >= 2) setState((s) => (s.status === "error" ? s : { ...s, status: "ready" }));
    };
    const fail = () => setState((s) => ({ ...s, status: "error" }));
    const stopClasses = listen("classes", (classes) => { setState((s) => ({ ...s, classes })); mark("classes"); }, fail);
    const stopShifts = listen("shifts", (shifts) => { setState((s) => ({ ...s, shifts })); mark("shifts"); }, fail);
    return () => {
      stopClasses();
      stopShifts();
    };
  }, []);
  return state;
}
