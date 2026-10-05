"use client";

import { useRef, useState } from "react";
import type { User } from "firebase/auth";
import { api, newKey, type ApiResult } from "@/lib/api-client";
import { isUncertain } from "@/modules/wallet/operation";

/**
 * Envio de venda do PDV. Uma chave de idempotência por TENTATIVA: reaproveitada só quando a resposta se perdeu (rede, tempo
 * esgotado, 429/5xx — a venda pode ter sido aplicada) com o MESMO conteúdo; assim o clique duplo e o reenvio devolvem a
 * venda original sem novo débito nem nova baixa. O botão fica travado enquanto há envio e a venda só é mostrada como feita
 * pela RESPOSTA do servidor (nunca por listener, cache ou dado otimista).
 */
export function usePosSubmit(user: User) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<{ json: string; key: string } | null>(null);
  const inFlight = useRef(false);

  async function submit<T>(url: string, body: Record<string, unknown>): Promise<ApiResult<T> | null> {
    if (inFlight.current) return null; // clique duplo: o segundo é ignorado aqui e, se escapasse, o servidor devolveria a mesma venda
    inFlight.current = true;
    setBusy(true);
    const json = JSON.stringify({ url, body });
    const key = pending.current?.json === json ? pending.current.key : newKey();
    const result = await api<T>(user, "POST", url, { ...body, key }, { timeoutMs: 20000 });
    inFlight.current = false;
    setBusy(false);
    if (!result.ok && isUncertain(result)) {
      pending.current = { json, key };
      setUncertain(true);
    } else {
      pending.current = null;
      setUncertain(false);
    }
    return result;
  }
  return { busy, uncertain, submit };
}
