import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { auditInTransaction } from "@/modules/audit/log";

/**
 * Permissões de compra do aluno (site e balcão). Qualquer responsável vinculado ativo — todos equivalentes, sem
 * "principal" — ou a administração altera; a mudança vale para a conta do aluno e registra o autor na auditoria.
 * Vínculo, aluno e política são lidos DENTRO da transação (decisão com estado atual).
 */
export const setPolicySchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    studentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    allowSitePurchase: z.boolean().optional(),
    allowCounterPurchase: z.boolean().optional(),
    reason: z.string().trim().min(3).max(300).default("Ajuste de permissões de compra"),
  })
  .refine((v) => v.allowSitePurchase !== undefined || v.allowCounterPurchase !== undefined, { message: "Nada a alterar." });

export type SetPolicyResult = { studentId: string; changed: boolean; configVersion: number };

export async function setStudentPolicy(db: Firestore, actor: Actor, raw: unknown): Promise<SetPolicyResult & { replayed: boolean }> {
  const input = setPolicySchema.parse(raw);
  return runIdempotentCommand(
    db,
    actor,
    { scope: "policy.set", key: input.key, payload: input, allow: (p) => p.role === "guardian" || p.role === "admin" },
    async ({ tx, actor: current, auditId }) => {
      const [student, link, policy] = await tx.getAll(
        db.doc(`students/${input.studentId}`),
        db.doc(`guardianStudentLinks/${current.uid}_${input.studentId}`),
        db.doc(`studentPolicies/${input.studentId}`),
      );
      if (!decideStudentAction({ actor: current, studentId: input.studentId, action: "manage", student: student?.data(), link: link?.data(), policy: policy?.data() })) {
        throw new ForbiddenError("Sem acesso ao aluno (manage).");
      }
      const before = (policy?.exists ? policy.data() : {}) as { allowSitePurchase?: boolean; allowCounterPurchase?: boolean; configVersion?: number };
      const after = {
        allowSitePurchase: input.allowSitePurchase ?? before.allowSitePurchase === true,
        allowCounterPurchase: input.allowCounterPurchase ?? before.allowCounterPurchase === true,
      };
      const changed = after.allowSitePurchase !== (before.allowSitePurchase === true) || after.allowCounterPurchase !== (before.allowCounterPurchase === true);
      const configVersion = (before.configVersion ?? 0) + (changed ? 1 : 0);
      if (changed) {
        tx.set(policy!.ref, { ...after, configVersion, updatedAt: FieldValue.serverTimestamp(), updatedBy: current.uid });
        auditInTransaction(db, tx, auditId, {
          action: "policy.set",
          actorUid: current.uid,
          actorRole: current.role ?? null,
          target: { type: "student", id: input.studentId },
          reason: input.reason,
          before: { allowSitePurchase: before.allowSitePurchase === true, allowCounterPurchase: before.allowCounterPurchase === true, configVersion: before.configVersion ?? 0 },
          after: { ...after, configVersion },
        });
      }
      return { studentId: input.studentId, changed, configVersion };
    },
  );
}
