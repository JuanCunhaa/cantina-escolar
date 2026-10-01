import { createHash } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { Actor } from "./actor";

/**
 * Comando de prova de F01: credita centavos numa carteira fictícia do próprio ator.
 * Exercita o roteiro de docs/firebase/transactions.md (idempotência, leituras antes de escritas,
 * livro imutável + saldo na mesma transação, efeito externo fora do callback). Não é a carteira real (F04).
 */
export const probeInputSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  amountCents: z.number().int().min(1).max(10_000),
});
export type ProbeInput = z.infer<typeof probeInputSchema>;

export type ProbeResult = { entryId: string; balanceCents: number; replayed: boolean };

export class IdempotencyConflictError extends Error {}

export const PROBE_COLLECTION = "foundationProbes";

type Stored = { payloadHash: string; response: { entryId: string; balanceCents: number } };

function payloadHash(input: ProbeInput): string {
  return createHash("sha256").update(JSON.stringify({ a: "probe", amountCents: input.amountCents })).digest("hex");
}

export async function runProbeCommand(
  db: Firestore,
  actor: Actor,
  rawInput: unknown,
  hooks: { afterCommit?: (result: ProbeResult) => Promise<void> | void; onAttempt?: () => void } = {},
): Promise<ProbeResult> {
  const input = probeInputSchema.parse(rawInput);
  const hash = payloadHash(input);
  // IDs derivados antes do callback: estáveis em retentativas.
  const idemRef = db.doc(`idempotencyRecords/${actor.uid}__probe__${input.key}`);
  const probeRef = db.doc(`${PROBE_COLLECTION}/${actor.uid}`);
  const entryRef = probeRef.collection("entries").doc(input.key);

  const result = await db.runTransaction(async (tx): Promise<ProbeResult> => {
    hooks.onAttempt?.();
    const [idem, probe] = await Promise.all([tx.get(idemRef), tx.get(probeRef)]); // leituras antes das escritas
    if (idem.exists) {
      const stored = idem.data() as Stored;
      if (stored.payloadHash !== hash) throw new IdempotencyConflictError("Chave reutilizada com payload diferente.");
      return { ...stored.response, replayed: true };
    }
    const current = probe.exists ? Number(probe.get("balanceCents")) : 0;
    if (!Number.isSafeInteger(current)) throw new Error("Saldo corrompido.");
    const balanceCents = current + input.amountCents;
    tx.create(entryRef, { amountCents: input.amountCents, balanceAfterCents: balanceCents, createdAt: FieldValue.serverTimestamp() });
    tx.set(probeRef, { balanceCents, version: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.create(idemRef, { payloadHash: hash, response: { entryId: input.key, balanceCents }, createdAt: FieldValue.serverTimestamp() });
    return { entryId: input.key, balanceCents, replayed: false };
  });

  if (!result.replayed) await hooks.afterCommit?.(result); // efeito externo somente após commit, uma vez
  return result;
}
