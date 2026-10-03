"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { collection, onSnapshot } from "firebase/firestore";
import { api } from "@/lib/api-client";
import { getFirebaseClient } from "@/lib/firebase/client";
import type { Overview, ProductStockView } from "./queries";

type Loaded<T> = { status: "loading" | "ready" | "error"; data: T | null; reload: () => void };

/**
 * Leitura autoritativa pela API (quantidades; custos só se o papel tem `costs.read`). O listener em `stockBalances` apenas
 * AVISA que algo mudou e dispara nova leitura pela API: nunca confirma uma operação, e o atraso conhecido de listeners
 * não afeta o resultado dos comandos (que vem da resposta do servidor).
 */
export function useStockOverview(user: User): Loaded<Overview> {
  const [state, setState] = useState<{ status: Loaded<Overview>["status"]; data: Overview | null }>({ status: "loading", data: null });
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const mine = ++sequence.current;
    const result = await api<Overview>(user, "GET", "/api/inventory");
    if (mine !== sequence.current) return; // resposta antiga não sobrescreve uma mais nova
    setState((s) => (result.ok ? { status: "ready", data: result.data } : { status: "error", data: s.data }));
  }, [user]);

  useEffect(() => {
    void load();
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onSnapshot(
      collection(getFirebaseClient().db, "stockBalances"),
      () => {
        if (first) {
          first = false;
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 400);
      },
      () => undefined, // sem listener a tela continua correta: botão Atualizar e releitura após cada comando
    );
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [load]);

  return { ...state, reload: () => void load() };
}

export function useProductStock(user: User, productId: string | null): Loaded<ProductStockView> {
  const [state, setState] = useState<{ key: string | null; status: Loaded<ProductStockView>["status"]; data: ProductStockView | null }>({ key: null, status: "loading", data: null });
  const sequence = useRef(0);
  const load = useCallback(async () => {
    if (!productId) return;
    const mine = ++sequence.current;
    const result = await api<ProductStockView>(user, "GET", `/api/inventory/product?productId=${encodeURIComponent(productId)}`);
    if (mine !== sequence.current) return;
    setState((s) => (result.ok ? { key: productId, status: "ready", data: result.data } : { key: productId, status: "error", data: s.key === productId ? s.data : null }));
  }, [user, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = state.key === productId;
  return { status: current ? state.status : "loading", data: current ? state.data : null, reload: () => void load() };
}
