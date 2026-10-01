import { createHash } from "node:crypto";
import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import type { Actor } from "@/modules/access/actor";
import { ForbiddenError } from "@/modules/access/errors";
import { parseProfile, type AccessProfile } from "@/modules/access/profile";
import { COMMAND_TRANSACTION } from "./transaction-options";

export class IdempotencyConflictError extends Error {}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash estável do payload normalizado (chaves em ordem de inserção do chamador). */
export function hashPayload(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

/** ID determinístico e seguro (prefixo + 20 hex) derivado da identidade da operação: estável entre retentativas. */
export function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256Hex(parts.join("\u0000")).slice(0, 20)}`;
}

type Stored<T> = { payloadHash: string; response: T };

export type CommandContext = {
  tx: Transaction;
  /** Ator com papel/permissões relidos do perfil ATUAL dentro da transação. */
  actor: Actor;
  profile: AccessProfile;
  auditId: string;
};

/**
 * Executa um comando idempotente: registro `idempotencyRecords/{uid}__{scope}__{key}` ligado ao hash do payload,
 * perfil atual do ator relido na transação (rebaixado/desativado entre a autenticação e aqui = negado) e resposta
 * reproduzível. `work` faz as demais leituras antes de qualquer escrita e devolve a resposta; efeitos externos ficam
 * fora desta função.
 */
export async function runIdempotentCommand<T extends object>(
  db: Firestore,
  actor: Actor,
  opts: { scope: string; key: string; payload: unknown; allow: (profile: AccessProfile) => boolean },
  work: (ctx: CommandContext) => Promise<T>,
): Promise<T & { replayed: boolean }> {
  const hash = hashPayload({ a: opts.scope, p: opts.payload });
  const idemRef = db.doc(`idempotencyRecords/${actor.uid}__${opts.scope}__${opts.key}`);
  const auditId = `${actor.uid}__${opts.scope}__${opts.key}`;
  return db.runTransaction(async (tx) => {
    const [idem, actorSnap] = await tx.getAll(idemRef, db.doc(`users/${actor.uid}`));
    const profile = parseProfile(actorSnap?.data());
    if (!profile || profile.status !== "active" || !opts.allow(profile)) throw new ForbiddenError("Ator sem permissão atual.");
    if (idem?.exists) {
      const stored = idem.data() as Stored<T>;
      if (stored.payloadHash !== hash) throw new IdempotencyConflictError("Chave reutilizada com payload diferente.");
      return { ...stored.response, replayed: true };
    }
    const current: Actor = { uid: actor.uid, role: profile.role, permissions: profile.permissions };
    const response = await work({ tx, actor: current, profile, auditId });
    tx.create(idemRef, { payloadHash: hash, response, createdAt: FieldValue.serverTimestamp() });
    return { ...response, replayed: false };
  }, COMMAND_TRANSACTION);
}
