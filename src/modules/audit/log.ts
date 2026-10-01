import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import type { Role } from "@/modules/access/roles";

/** Auditoria mínima append-only (auditLog). Rules negam todo acesso do cliente; só o servidor cria, nunca altera. */
export type AuditEntry = {
  action: string;
  actorUid: string;
  actorRole: Role | null;
  target: { type: string; id: string };
  reason?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

export const AUDIT_COLLECTION = "auditLog";

function body(entry: AuditEntry): Record<string, unknown> {
  return { ...entry, reason: entry.reason ?? null, before: entry.before ?? null, after: entry.after ?? null, createdAt: FieldValue.serverTimestamp() };
}

/** Dentro de transação: `id` deve ser derivado da operação (estável em retentativas); `create` falha se já existir. */
export function auditInTransaction(db: Firestore, tx: Transaction, id: string, entry: AuditEntry): void {
  tx.create(db.doc(`${AUDIT_COLLECTION}/${id}`), body(entry));
}

/** Fora de transação (comandos sem outros efeitos). */
export async function appendAudit(db: Firestore, id: string, entry: AuditEntry): Promise<void> {
  await db.doc(`${AUDIT_COLLECTION}/${id}`).create(body(entry)).catch((error: { code?: number }) => {
    if (error.code !== 6) throw error; // 6 = ALREADY_EXISTS: mesma operação já auditada
  });
}
