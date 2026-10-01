import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import { z } from "zod";
import { invalid, notFound } from "@/lib/domain-error";
import { runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize, decideStudentAction } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { parseProfile } from "@/modules/access/profile";
import { auditInTransaction } from "@/modules/audit/log";

const key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const studentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const uid = z.string().regex(/^[A-Za-z0-9]{1,128}$/);
const reason = z.string().trim().min(3).max(300);

/** Vínculos responsável–aluno feitos pela administração (o caminho alternativo é o convite validado). */
export const linkCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), key, studentId, guardianEmail: z.email().max(254), reason }),
  z.object({ action: z.literal("revoke"), key, studentId, guardianUid: uid, reason }),
  z.object({ action: z.literal("revokeStudentLogin"), key, studentId, reason }),
]);

export type LinkResult = { studentId: string; changed: boolean };

export const linkId = (guardianUid: string, student: string) => `${guardianUid}_${student}`;

export async function runLinkCommand(deps: { auth: Auth; db: Firestore }, actor: Actor, raw: unknown): Promise<LinkResult & { replayed: boolean }> {
  const { auth, db } = deps;
  const input = linkCommandSchema.parse(raw);
  // Revogar o login do aluno também cabe a qualquer responsável vinculado (decidido dentro da transação).
  if (input.action !== "revokeStudentLogin") authorize(actor, "students.manage");

  if (input.action === "revokeStudentLogin") {
    return runIdempotentCommand(
      db,
      actor,
      { scope: "student.login.revoke", key: input.key, payload: input, allow: (p) => p.role === "admin" || p.role === "guardian" },
      async ({ tx, actor: current, auditId }) => {
        const [student, link] = await tx.getAll(db.doc(`students/${input.studentId}`), db.doc(`guardianStudentLinks/${current.uid}_${input.studentId}`));
        if (!decideStudentAction({ actor: current, studentId: input.studentId, action: "manage", student: student?.data(), link: link?.data(), policy: undefined })) {
          throw new ForbiddenError("Sem acesso ao aluno (manage).");
        }
        const userUid = (student!.data() as { userUid: string | null }).userUid;
        if (!userUid) return { studentId: input.studentId, changed: false };
        const loginKey = db.doc(`uniquenessKeys/studentLogin_${userUid}`);
        tx.update(student!.ref, { userUid: null, version: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
        tx.delete(loginKey);
        auditInTransaction(db, tx, auditId, {
          action: "student.login.revoke",
          actorUid: current.uid,
          actorRole: current.role ?? null,
          target: { type: "student", id: input.studentId },
          reason: input.reason,
          before: { userUid },
          after: { userUid: null },
        });
        return { studentId: input.studentId, changed: true };
      },
    );
  }

  let guardianUid: string = input.action === "revoke" ? input.guardianUid : "";
  if (input.action === "add") {
    // Resolução da conta fora da transação (efeito externo de leitura); o perfil é relido dentro dela.
    try {
      guardianUid = (await auth.getUserByEmail(input.guardianEmail.toLowerCase())).uid;
    } catch {
      throw notFound("guardian_not_found", "Responsável não encontrado.");
    }
  }
  const linkRef = db.doc(`guardianStudentLinks/${linkId(guardianUid, input.studentId)}`);
  return runIdempotentCommand(
    db,
    actor,
    { scope: `link.${input.action}`, key: input.key, payload: input, allow: (p) => p.role === "admin" },
    async ({ tx, actor: current, auditId }) => {
      const [student, link, guardian] = await tx.getAll(db.doc(`students/${input.studentId}`), linkRef, db.doc(`users/${guardianUid}`));
      if (!student?.exists) throw notFound("student_not_found");
      const before = link?.exists ? (link.data() as { status: string }) : null;
      const now = FieldValue.serverTimestamp();
      let changed = true;
      if (input.action === "add") {
        const profile = parseProfile(guardian?.data());
        if (profile?.role !== "guardian" || profile.status !== "active") throw invalid("not_a_guardian", "A conta não é de um responsável ativo.");
        if (before?.status === "active") changed = false;
        else tx.set(linkRef, { guardianUid, studentId: input.studentId, status: "active", source: "admin", createdBy: current.uid, updatedAt: now, createdAt: now });
      } else {
        if (!before) throw notFound("link_not_found");
        if (before.status === "revoked") changed = false;
        else tx.update(linkRef, { status: "revoked", revokedBy: current.uid, revokedAt: now, updatedAt: now });
      }
      if (changed) {
        auditInTransaction(db, tx, auditId, {
          action: `link.${input.action}`,
          actorUid: current.uid,
          actorRole: current.role ?? null,
          target: { type: "link", id: linkId(guardianUid, input.studentId) },
          reason: input.reason,
          before: before && { status: before.status },
          after: { status: input.action === "add" ? "active" : "revoked" },
        });
      }
      return { studentId: input.studentId, changed };
    },
  );
}
