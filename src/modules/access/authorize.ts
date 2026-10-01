import type { DocumentReference, DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import type { Actor } from "./actor";
import { ForbiddenError } from "./errors";
import { can, type Capability } from "./permissions";

/** Autorização por capacidade do papel geral (e permissão extra individual). Único ponto de decisão para handlers. */
export function authorize(actor: Actor, capability: Capability): void {
  if (!can(actor, capability)) throw new ForbiddenError(`Sem permissão: ${capability}.`);
}

/**
 * Ações sobre um aluno, decididas com vínculo e política ATUAIS (Firestore), nunca por claim:
 * - view: equipe, responsável vinculado ativo, ou o próprio aluno (students.userUid);
 * - manage: administração ou responsável vinculado ativo (todos os responsáveis são equivalentes);
 * - purchase.site: responsável vinculado (sempre) ou o aluno com `allowSitePurchase`;
 * - purchase.counter: PDV (cantina/administração) somente com `allowCounterPurchase` do aluno.
 * Compra exige aluno ativo. Permissão revogada não apaga pedidos existentes (isso é de checkout/pedidos).
 */
export type StudentAction = "view" | "manage" | "purchase.site" | "purchase.counter";

type StudentData = { status?: unknown; userUid?: unknown } | undefined;
type LinkData = { guardianUid?: unknown; studentId?: unknown; status?: unknown } | undefined;
type PolicyData = { allowSitePurchase?: unknown; allowCounterPurchase?: unknown } | undefined;

export function decideStudentAction(input: {
  actor: Actor;
  studentId: string;
  action: StudentAction;
  student: StudentData;
  link: LinkData;
  policy: PolicyData;
}): boolean {
  const { actor, studentId, action, student, link, policy } = input;
  if (!student || !actor.role) return false;
  const role = actor.role;
  const linkedGuardian =
    role === "guardian" && link?.status === "active" && link.guardianUid === actor.uid && link.studentId === studentId;
  const self = role === "student" && typeof student.userUid === "string" && student.userUid === actor.uid;
  const studentActive = student.status === "active";
  switch (action) {
    case "view":
      return role === "cantina" || role === "secretaria" || role === "admin" || linkedGuardian || self;
    case "manage":
      return role === "admin" || linkedGuardian;
    case "purchase.site":
      return studentActive && (linkedGuardian || (self && policy?.allowSitePurchase === true));
    case "purchase.counter":
      return studentActive && (role === "cantina" || role === "admin") && policy?.allowCounterPurchase === true;
  }
}

export function studentAccessRefs(db: Firestore, actor: Actor, studentId: string): DocumentReference[] {
  return [db.doc(`students/${studentId}`), db.doc(`guardianStudentLinks/${actor.uid}_${studentId}`), db.doc(`studentPolicies/${studentId}`)];
}

/** Lê aluno/vínculo/política (dentro da transação quando `tx` é informado) e nega com ForbiddenError. */
export async function authorizeStudent(
  db: Firestore,
  actor: Actor,
  studentId: string,
  action: StudentAction,
  tx?: Transaction,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(studentId)) throw new ForbiddenError("Aluno inválido.");
  const refs = studentAccessRefs(db, actor, studentId);
  const [student, link, policy]: DocumentSnapshot[] = tx ? await tx.getAll(...refs) : await db.getAll(...refs);
  const allowed = decideStudentAction({
    actor,
    studentId,
    action,
    student: student?.data(),
    link: link?.data(),
    policy: policy?.data(),
  });
  if (!allowed) throw new ForbiddenError(`Sem acesso ao aluno (${action}).`);
}
