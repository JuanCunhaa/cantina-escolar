"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import { isUncertain } from "@/modules/wallet/operation";
import { toCsv } from "./fulfillment-model";

type Loaded<T> = { status: "loading" | "ready" | "error"; data: T | null; errorCode: string | null; refreshing: boolean; reload: () => void };

/**
 * Leitura autoritativa pelo servidor (`orders` é fechado ao cliente). A chave da consulta (conta + parâmetros) identifica
 * uma GERAÇÃO: resposta de outra geração (filtro/conta trocados, tela desmontada) é descartada. Sem listener: a lista é
 * relida após cada comando, pelo botão Atualizar e ao voltar o foco à aba — nunca se confirma uma entrega por dado em cache.
 */
export function useServerQuery<T>(user: User, path: string, query: string, enabled = true, refreshOnFocus = true): Loaded<T> {
  const [state, setState] = useState<{ key: string; status: "ready" | "error"; data: T | null; errorCode: string | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const userRef = useRef(user);
  const uid = user.uid;
  const key = `${uid}|${path}?${query}`;
  useEffect(() => {
    userRef.current = user;
  });

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api<T>(userRef.current, "GET", `${path}?${query}`, undefined, { timeoutMs: 20000 });
    if (mine !== generation.current) return;
    setRefreshing(false);
    setState((s) => (result.ok ? { key, status: "ready", data: result.data, errorCode: null } : { key, status: "error", data: s?.key === key ? s.data : null, errorCode: result.error }));
  }, [path, query, key]);

  // Trocar de conta/filtro cria um `load` novo, cujo `++generation` invalida as respostas da geração anterior.
  useEffect(() => {
    if (!enabled) return;
    void load();
    const onFocus = () => {
      setRefreshing(true);
      void load();
    };
    if (!refreshOnFocus) return;
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load, enabled, refreshOnFocus]);

  const current = state?.key === key ? state : null;
  return { status: current?.status ?? "loading", data: current?.data ?? null, errorCode: current?.errorCode ?? null, refreshing, reload: () => {
      setRefreshing(true);
      void load();
    },
  };
}

export type CommandMessage = { kind: "ok" | "error"; text: string };

/**
 * Comando de operação (preparo, entrega, não retirado, resolução, cancelamento). Chave de idempotência por tentativa:
 * reaproveitada só quando a resposta se perdeu (rede, tempo esgotado, 429/5xx: o comando pode ter sido aplicado) com o MESMO
 * conteúdo, então clique duplo/reenvio não baixa estoque nem credita a carteira duas vezes. O botão
 * fica desabilitado enquanto há envio em andamento; o resultado exibido é o da RESPOSTA do servidor.
 */
export function useOrderCommand(user: User, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<CommandMessage | null>(null);
  const pending = useRef<{ json: string; key: string } | null>(null);
  const inFlight = useRef(false);

  /** `onError` informa o código e se o resultado é INCERTO (resposta perdida: repetir o mesmo envio reaproveita a chave). */
  async function run(url: string, body: Record<string, unknown>, success: (data: Record<string, unknown>) => string, onError?: (error: string, uncertain: boolean) => void): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const json = JSON.stringify({ url, body });
    const key = pending.current?.json === json ? pending.current.key : newKey();
    const result = await api<Record<string, unknown>>(user, "POST", url, { ...body, key });
    inFlight.current = false;
    setBusy(false);
    if (!result.ok) {
      const uncertain = isUncertain(result);
      pending.current = uncertain ? { json, key } : null;
      onError?.(result.error, uncertain);
      const missing = typeof result.details?.missingUnits === "number" ? ` Registre a entrada de ${result.details.missingUnits} unidade(s) em Estoque.` : "";
      setMessage({ kind: "error", text: errorText(result.error) + missing });
      onDone(); // a lista pode ter mudado (outra pessoa entregou): relê para mostrar o restante real
      return false;
    }
    pending.current = null;
    setMessage({ kind: "ok", text: success(result.data) });
    onDone();
    return true;
  }
  return { busy, message, run };
}

/** Baixa um CSV (separador `;`, UTF-8 com BOM para abrir acentos corretamente em planilhas). */
export function downloadCsv(filename: string, rows: readonly (readonly (string | number)[])[]): void {
  const blob = new Blob(["﻿", toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000); // alguns navegadores iniciam o download de forma assíncrona
}
