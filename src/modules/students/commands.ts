import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { z } from "zod";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { auditInTransaction } from "@/modules/audit/log";
import { isSafeLabel, normalizeEnrollment, normalizeName } from "./normalize";

export const STUDENT_STATUSES = ["active", "inactive"] as const;

const key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const studentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const personName = z.string().trim().min(2).max(120).refine(isSafeLabel, "Nome inválido.");
const unitId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const reason = z.string().trim().min(3).max(300);
const enrollment = z
  .string()
  .trim()
  .max(40)
  .transform((value, ctx) => {
    const normalized = normalizeEnrollment(value);
    if (!normalized) ctx.addIssue({ code: "custom", message: "Matrícula inválida." });
    return normalized ?? "";
  });

export const studentCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), key, enrollment, name: personName, classId: unitId, shiftId: unitId }),
  z.object({
    action: z.literal("update"),
    key,
    studentId,
    reason,
    name: personName.optional(),
    classId: unitId.optional(),
    shiftId: unitId.optional(),
    status: z.enum(STUDENT_STATUSES).optional(),
  }),
]);

export type StudentView = {
  enrollment: string;
  name: string;
  classId: string;
  shiftId: string;
  status: string;
};

type StudentDoc = StudentView & { nameNormalized: string; userUid: string | null; version: number };

export const enrollmentKeyPath = (normalized: string) => `uniquenessKeys/enrollment_${normalized}`;

type CreateData = { studentId: string; enrollment: string; name: string; classId: string; shiftId: string };

function assertActiveUnit(snap: { exists: boolean; data(): unknown } | null | undefined, code: string, message: string): void {
  if (snap && (!snap.exists || (snap.data() as { status: string }).status !== "active")) throw invalid(code, message);
}

/**
 * Cria aluno + política padrão (compras negadas até o responsável liberar) + chave de matrícula única, na mesma
 * transação. Leituras antes das escritas. `outcome: "duplicate"` quando a matrícula já existe (sem escrever nada).
 */
export async function createStudentInTx(
  db: Firestore,
  tx: Transaction,
  current: Actor,
  auditId: string,
  data: CreateData,
): Promise<{ studentId: string; outcome: "created" | "duplicate" }> {
  const keyRef = db.doc(enrollmentKeyPath(data.enrollment));
  const [existingKey, cls, shift] = await tx.getAll(keyRef, db.doc(`classes/${data.classId}`), db.doc(`shifts/${data.shiftId}`));
  if (existingKey!.exists) {
    const existing = existingKey!.data() as { studentId: string };
    return { studentId: existing.studentId, outcome: "duplicate" };
  }
  assertActiveUnit(cls, "class_unavailable", "Turma inexistente ou arquivada.");
  assertActiveUnit(shift, "shift_unavailable", "Turno inexistente ou arquivado.");
  const now = FieldValue.serverTimestamp();
  tx.create(db.doc(`students/${data.studentId}`), {
    enrollment: data.enrollment,
    name: data.name,
    nameNormalized: normalizeName(data.name),
    classId: data.classId,
    shiftId: data.shiftId,
    status: "active",
    userUid: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  tx.create(db.doc(`studentPolicies/${data.studentId}`), {
    allowSitePurchase: false,
    allowCounterPurchase: false,
    configVersion: 1,
    updatedAt: now,
  });
  tx.create(keyRef, { studentId: data.studentId, createdAt: now });
  auditInTransaction(db, tx, auditId, {
    action: "student.create",
    actorUid: current.uid,
    actorRole: current.role ?? null,
    target: { type: "student", id: data.studentId },
    after: { enrollment: data.enrollment, name: data.name, classId: data.classId, shiftId: data.shiftId, status: "active" },
  });
  return { studentId: data.studentId, outcome: "created" };
}

export type StudentChanges = { name?: string; classId?: string; shiftId?: string; status?: (typeof STUDENT_STATUSES)[number] };

/** Altera o cadastro: turma/turno só para unidades ativas; histórico (matrícula, vínculos, pedidos) permanece. */
export async function updateStudentInTx(
  db: Firestore,
  tx: Transaction,
  current: Actor,
  auditId: string,
  id: string,
  changes: StudentChanges,
  reasonText: string,
): Promise<{ changed: boolean; scheduleChanged: boolean }> {
  const refs = [db.doc(`students/${id}`)];
  if (changes.classId) refs.push(db.doc(`classes/${changes.classId}`));
  if (changes.shiftId) refs.push(db.doc(`shifts/${changes.shiftId}`));
  const snaps = await tx.getAll(...refs);
  const snap = snaps[0]!;
  if (!snap.exists) throw notFound("student_not_found");
  const before = snap.data() as StudentDoc;
  let at = 1;
  if (changes.classId) assertActiveUnit(snaps[at++], "class_unavailable", "Turma inexistente ou arquivada.");
  if (changes.shiftId) assertActiveUnit(snaps[at++], "shift_unavailable", "Turno inexistente ou arquivado.");
  const after: StudentView = {
    enrollment: before.enrollment,
    name: changes.name ?? before.name,
    classId: changes.classId ?? before.classId,
    shiftId: changes.shiftId ?? before.shiftId,
    status: changes.status ?? before.status,
  };
  const scheduleChanged = after.classId !== before.classId || after.shiftId !== before.shiftId;
  const changed = scheduleChanged || after.name !== before.name || after.status !== before.status;
  if (!changed) return { changed, scheduleChanged };
  tx.update(snap.ref, {
    name: after.name,
    nameNormalized: normalizeName(after.name),
    classId: after.classId,
    shiftId: after.shiftId,
    status: after.status,
    version: before.version + 1,
    updatedAt: FieldValue.serverTimestamp(),
  });
  auditInTransaction(db, tx, auditId, {
    action: "student.update",
    actorUid: current.uid,
    actorRole: current.role ?? null,
    target: { type: "student", id },
    reason: reasonText,
    before: { name: before.name, classId: before.classId, shiftId: before.shiftId, status: before.status },
    after: { name: after.name, classId: after.classId, shiftId: after.shiftId, status: after.status },
  });
  return { changed, scheduleChanged };
}

export type StudentCommandResult = { studentId: string; changed: boolean; scheduleChanged?: boolean };

const adminOnly = (profile: { role: string }) => profile.role === "admin";

export async function runStudentCommand(db: Firestore, actor: Actor, raw: unknown): Promise<StudentCommandResult & { replayed: boolean }> {
  authorize(actor, "students.manage");
  const input = studentCommandSchema.parse(raw);
  if (input.action === "create") {
    const id = deterministicId("stu", actor.uid, input.key);
    return runIdempotentCommand(db, actor, { scope: "student.create", key: input.key, payload: input, allow: adminOnly }, async ({ tx, actor: current, auditId }) => {
      const result = await createStudentInTx(db, tx, current, auditId, { studentId: id, ...input });
      if (result.outcome === "duplicate") throw conflict("enrollment_taken", "Matrícula já cadastrada.");
      return { studentId: id, changed: true };
    });
  }
  const changes: StudentChanges = { name: input.name, classId: input.classId, shiftId: input.shiftId, status: input.status };
  if (Object.values(changes).every((v) => v === undefined)) throw invalid("no_changes", "Nenhuma alteração informada.");
  return runIdempotentCommand(db, actor, { scope: "student.update", key: input.key, payload: input, allow: adminOnly }, async ({ tx, actor: current, auditId }) => {
    const result = await updateStudentInTx(db, tx, current, auditId, input.studentId, changes, input.reason);
    return { studentId: input.studentId, ...result };
  });
}
