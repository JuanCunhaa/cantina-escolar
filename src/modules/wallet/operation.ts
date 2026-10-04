import type { ApiResult } from "@/lib/api-client";

/**
 * Ciclo de uma operação financeira na interface: pendente (enviada, sem resposta) → confirmada (resposta do servidor
 * ok) | recusada (resposta definitiva) | incerta (sem resposta definitiva). Sucesso só existe depois da confirmação do
 * servidor; um resultado incerto nunca vira falha: a MESMA operação (mesma chave) é repetida, e a idempotência do
 * servidor devolve o resultado original sem novo movimento.
 */
export type Outcome<T> = { phase: "confirmed"; data: T } | { phase: "refused"; status: number; error: string; details?: Record<string, unknown> } | { phase: "uncertain"; attempts: number };

/** Sem resposta (rede/tempo esgotado) ou erro transitório do servidor: o comando pode ou não ter sido aplicado. */
export function isUncertain(result: ApiResult<unknown>): boolean {
  return !result.ok && (result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500);
}

export async function executeWithRetry<T>(
  send: () => Promise<ApiResult<T>>,
  opts: { maxAttempts?: number; backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Outcome<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoff = opts.backoffMs ?? [400, 1200];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await send();
    if (result.ok) return { phase: "confirmed", data: result.data };
    if (!isUncertain(result)) return { phase: "refused", status: result.status, error: result.error, details: result.details };
    if (attempt < maxAttempts) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0);
  }
  return { phase: "uncertain", attempts: maxAttempts };
}
