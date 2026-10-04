"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { api } from "@/lib/api-client";
import { getFirebaseClient } from "@/lib/firebase/client";
import { appendPage, reconcileFirstPage, type OrderGroup, type OrderPage, type OrderView } from "./history-model";

export type HistoryFilters = { studentId: string; group: OrderGroup; status: string; channel: string; shiftId: string; from: string; to: string };
export const NO_FILTERS: HistoryFilters = { studentId: "", group: "pending", status: "", channel: "", shiftId: "", from: "", to: "" };

export type HistoryState = {
  /** Escopo da leitura (conta|alunos|filtros): estado de outro escopo nunca é exibido. */
  key: string;
  /** loading: sem dado para estes filtros; ready: lista (possivelmente vazia); error: primeira leitura falhou. */
  status: "loading" | "ready" | "error";
  errorCode: string | null;
  orders: OrderView[];
  nextCursor: string | null;
  students: { id: string; name: string }[];
  shifts: { id: string; name: string }[];
  /** Releitura em andamento com a lista anterior ainda na tela ("dados em atualização"). */
  refreshing: boolean;
  loadingMore: boolean;
  moreError: boolean;
  /** Releitura falhou depois de já haver dados: a lista exibida pode estar desatualizada. */
  staleError: boolean;
  /** O aviso em tempo real (listener) está indisponível; a lista continua correta ao reler. */
  liveError: boolean;
};

const INITIAL: HistoryState = { key: "", status: "loading", errorCode: null, orders: [], nextCursor: null, students: [], shifts: [], refreshing: false, loadingMore: false, moreError: false, staleError: false, liveError: false };

function queryOf(filters: HistoryFilters, scopeStudents: readonly string[], cursor?: string): string {
  const params = new URLSearchParams();
  const student = filters.studentId && scopeStudents.includes(filters.studentId) ? filters.studentId : "";
  const entries: [string, string | undefined][] = [["studentId", student], ["group", filters.group], ["status", filters.status], ["channel", filters.channel], ["shiftId", filters.shiftId], ["from", filters.from], ["to", filters.to], ["cursor", cursor]];
  for (const [key, value] of entries) if (value) params.set(key, value);
  return params.toString();
}

/**
 * Histórico de pedidos com leitura autoritativa pelo servidor + aviso em tempo real. Escopo e assinaturas:
 * - cada combinação conta/escopo/filtros é uma GERAÇÃO; respostas de gerações anteriores (troca de conta, aluno, filtro,
 *   desmontagem) são descartadas, inclusive "carregar mais" e releituras em voo;
 * - o único listener é o do documento `wallets/{aluno}` (limitado a UM documento por aluno do escopo): quando a `version`
 *   da carteira sobe, a primeira página é relida e reconciliada por `version` do pedido. O snapshot nunca É o dado do
 *   pedido nem confirma compra; cache local (`fromCache`) é ignorado. As assinaturas são encerradas a cada troca e ao
 *   desmontar. Aluno com login não tem permissão de leitura da carteira: relê ao voltar o foco e pelo botão.
 */
export function useOrderHistory(user: User, filters: HistoryFilters, listenIds: readonly string[], scopeStudents: readonly string[]) {
  const [raw, setState] = useState<HistoryState>(INITIAL);
  /** Chave em que o listener falhou: independe de a primeira leitura já ter chegado. */
  const [liveErrorKey, setLiveErrorKey] = useState("");
  const userRef = useRef(user);
  const generation = useRef(0);
  const uid = user.uid;
  const filterKey = JSON.stringify(filters);
  const scopeKey = [...scopeStudents].sort().join(",");
  const listenKey = [...listenIds].sort().join(",");
  const key = `${uid}|${scopeKey}|${filterKey}`;
  // Troca de conta/escopo/filtros: o estado de outra chave nunca é exibido (volta a "carregando" sem setState no efeito).
  const state = { ...(raw.key === key ? raw : { ...INITIAL, key, shifts: raw.shifts }), liveError: liveErrorKey === key };
  const stateRef = useRef(state);
  useEffect(() => {
    userRef.current = user;
    stateRef.current = state;
  });

  /** Lê a primeira página. `silent`: mantém a lista atual na tela e reconcilia por versão (releitura). */
  const load = useCallback(
    async (silent: boolean) => {
      const started = generation.current;
      const result = await api<OrderPage>(userRef.current, "GET", `/api/orders?${queryOf(JSON.parse(filterKey) as HistoryFilters, scopeKey ? scopeKey.split(",") : [])}`, undefined, { timeoutMs: 15000 });
      if (started !== generation.current) return;
      if (!result.ok) {
        setState((s) => (s.key === key && s.status === "ready" ? { ...s, refreshing: false, staleError: true } : { ...INITIAL, key, shifts: s.shifts, status: "error", errorCode: result.error }));
        return;
      }
      const page = result.data;
      setState((s) => {
        if (s.key !== key && silent) return s;
        const hadMore = s.nextCursor !== null;
        const reconcile = silent && s.key === key && s.status === "ready";
        const orders = reconcile ? reconcileFirstPage(s.orders, page.orders, page.nextCursor !== null) : page.orders;
        // Só adota o cursor da releitura se a lista ainda não passou da primeira página.
        const keepCursor = reconcile && hadMore && s.orders.length > page.orders.length;
        return { ...(s.key === key ? s : { ...INITIAL, key }), status: "ready", errorCode: null, orders, nextCursor: keepCursor ? s.nextCursor : page.nextCursor, students: page.students, shifts: page.shifts ?? s.shifts, refreshing: false, staleError: false };
      });
    },
    [filterKey, scopeKey, key],
  );

  /** Releitura com a lista atual na tela: marca "atualizando" e reconcilia por versão. */
  const refresh = useCallback(() => {
    setState((s) => (s.key === key ? { ...s, refreshing: true } : s));
    void load(true);
  }, [key, load]);

  useEffect(() => {
    generation.current += 1;
    void load(false);
    const started = generation.current;
    const stops: (() => void)[] = [];
    const baseline = new Map<string, number>();
    if (listenKey) {
      const { db } = getFirebaseClient();
      for (const id of listenKey.split(",")) {
        stops.push(
          onSnapshot(
            doc(db, "wallets", id),
            (snap) => {
              if (snap.metadata.fromCache || started !== generation.current) return;
              const version = snap.exists() ? Number(snap.get("version")) : 0;
              const known = baseline.get(id);
              baseline.set(id, Math.max(known ?? -1, version));
              setLiveErrorKey((k) => (k === key ? "" : k));
              if (known !== undefined && version > known) refresh();
            },
            () => {
              if (started === generation.current) setLiveErrorKey(key);
            },
          ),
        );
      }
    }
    const onFocus = () => {
      if (document.visibilityState === "visible" && stateRef.current.status === "ready") refresh();
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      generation.current += 1;
      for (const stop of stops) stop();
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [key, listenKey, load, refresh]);

  const loadMore = useCallback(async () => {
    const cursor = stateRef.current.nextCursor;
    if (!cursor || stateRef.current.loadingMore) return;
    const started = generation.current;
    setState((s) => (s.key === key ? { ...s, loadingMore: true, moreError: false } : s));
    const result = await api<OrderPage>(userRef.current, "GET", `/api/orders?${queryOf(JSON.parse(filterKey) as HistoryFilters, scopeKey ? scopeKey.split(",") : [], cursor)}`, undefined, { timeoutMs: 15000 });
    if (started !== generation.current) return;
    setState((s) => (s.key !== key ? s : result.ok ? { ...s, loadingMore: false, orders: appendPage(s.orders, result.data.orders), nextCursor: result.data.nextCursor } : { ...s, loadingMore: false, moreError: true }));
  }, [filterKey, scopeKey, key]);

  return { state, reload: () => (stateRef.current.status === "ready" ? refresh() : void load(false)), loadMore };
}
