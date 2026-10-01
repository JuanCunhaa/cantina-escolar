import { randomBytes } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { runIdempotentCommand, sha256Hex } from "@/lib/firebase/command";
import { COMMAND_TRANSACTION } from "@/lib/firebase/transaction-options";
import type { Actor } from "@/modules/access/actor";
import { authorize, decideStudentAction } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { parseProfile } from "@/modules/access/profile";
import { auditInTransaction } from "@/modules/audit/log";
import { isSafeLabel } from "@/modules/students/normalize";
import { linkId } from "./links";

/**
 * Convites de uso único e com validade. O token (256 bits) só existe no momento da criação e na URL entregue pela
 * escola; o Firestore guarda apenas o SHA-256 (ID do documento). Convite de responsável é emitido pela administração;
 * convite de login do aluno também pode ser emitido por qualquer responsável vinculado ao aluno.
 */
export const INVITATION_KINDS = ["guardian", "student"] as const;
export type InvitationKind = (typeof INVITATION_KINDS)[number];
export const MAX_PENDING_PER_STUDENT = 5;
export const MAX_TTL_HOURS = 14 * 24;
export const DEFAULT_TTL_HOURS = 72;

const key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const studentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const invitationCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    key,
    kind: z.enum(INVITATION_KINDS),
    studentId,
    ttlHours: z.number().int().min(1).max(MAX_TTL_HOURS).default(DEFAULT_TTL_HOURS),
  }),
  z.object({ action: z.literal("revoke"), key, invitationId: z.string().regex(/^[0-9a-f]{64}$/) }),
]);

export const tokenHash = (token: string) => sha256Hex(`invitation:${token}`);

type InvitationDoc = {
  kind: InvitationKind;
  studentId: string;
  status: "pending" | "used" | "revoked";
  expiresAt: Timestamp;
  createdBy: string;
  usedBy?: string;
};

export type InvitationCreated = { invitationId: string; expiresAt: string; token?: string };

export async function runInvitationCommand(db: Firestore, actor: Actor, raw: unknown): Promise<(InvitationCreated | { invitationId: string; changed: boolean }) & { replayed: boolean }> {
  const input = invitationCommandSchema.parse(raw);
  const allow = (p: { role: string }) => p.role === "admin" || p.role === "guardian";

  if (input.action === "create") {
    if (input.kind === "guardian") authorize(actor, "students.manage");
    // Token criado fora da transação; só o hash entra no banco. Replay da mesma chave não devolve o token novamente.
    const token = randomBytes(32).toString("base64url");
    const id = tokenHash(token);
    const result = await runIdempotentCommand(db, actor, { scope: "invitation.create", key: input.key, payload: input, allow }, async ({ tx, actor: current, auditId }) => {
      const [student, link] = await tx.getAll(db.doc(`students/${input.studentId}`), db.doc(`guardianStudentLinks/${current.uid}_${input.studentId}`));
      if (!student?.exists) throw notFound("student_not_found");
      if (!mayHandleStudent(current, input.kind, input.studentId, student.data(), link?.data())) throw new ForbiddenError("Sem permissão para convidar.");
      const studentData = student.data() as { status: string; userUid: string | null };
      if (studentData.status !== "active") throw invalid("student_inactive", "Aluno inativo.");
      if (input.kind === "student" && studentData.userUid) throw conflict("student_has_login", "O aluno já possui login.");
      const pending = await tx.get(db.collection("invitations").where("studentId", "==", input.studentId).where("status", "==", "pending").limit(MAX_PENDING_PER_STUDENT + 5));
      const now = Date.now();
      const live = pending.docs.filter((d) => (d.data() as InvitationDoc).expiresAt.toMillis() > now);
      if (live.length >= MAX_PENDING_PER_STUDENT) throw conflict("too_many_invitations", "Há convites pendentes demais para este aluno.");
      const expiresAt = Timestamp.fromMillis(now + input.ttlHours * 3_600_000);
      tx.create(db.doc(`invitations/${id}`), {
        kind: input.kind,
        studentId: input.studentId,
        status: "pending",
        expiresAt,
        createdBy: current.uid,
        createdByRole: current.role ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });
      auditInTransaction(db, tx, auditId, {
        action: "invitation.create",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        target: { type: "invitation", id },
        after: { kind: input.kind, studentId: input.studentId, expiresAt: expiresAt.toDate().toISOString() },
      });
      return { invitationId: id, expiresAt: expiresAt.toDate().toISOString() };
    });
    return result.replayed ? result : { ...result, token };
  }

  return runIdempotentCommand(db, actor, { scope: "invitation.revoke", key: input.key, payload: input, allow }, async ({ tx, actor: current, auditId }) => {
    const invitation = await tx.get(db.doc(`invitations/${input.invitationId}`));
    if (!invitation.exists) throw notFound("invitation_not_found");
    const data = invitation.data() as InvitationDoc;
    const [student, link] = await tx.getAll(db.doc(`students/${data.studentId}`), db.doc(`guardianStudentLinks/${current.uid}_${data.studentId}`));
    if (!mayHandleStudent(current, data.kind, data.studentId, student?.data(), link?.data())) throw new ForbiddenError("Sem permissão para revogar.");
    if (data.status !== "pending") return { invitationId: input.invitationId, changed: false };
    tx.update(invitation.ref, { status: "revoked", revokedBy: current.uid, revokedAt: FieldValue.serverTimestamp() });
    auditInTransaction(db, tx, auditId, {
      action: "invitation.revoke",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "invitation", id: input.invitationId },
      before: { status: data.status },
      after: { status: "revoked" },
    });
    return { invitationId: input.invitationId, changed: true };
  });
}

function mayHandleStudent(current: Actor, kind: InvitationKind, studentId: string, student: unknown, link: unknown): boolean {
  if (current.role === "admin") return true;
  if (kind !== "student") return false;
  return decideStudentAction({ actor: current, studentId, action: "manage", student: student as never, link: link as never, policy: undefined });
}

export type InvitationRow = { id: string; kind: InvitationKind; status: "pending" | "used" | "revoked" | "expired"; expiresAt: string; createdBy: string };

/** Convites de um aluno (sem token). Administração vê todos; responsável vinculado vê apenas os de login do aluno. */
export async function listInvitations(db: Firestore, actor: Actor, rawStudentId: unknown): Promise<{ invitations: InvitationRow[] }> {
  const id = studentId.parse(rawStudentId);
  const [student, link, snap] = await Promise.all([
    db.doc(`students/${id}`).get(),
    db.doc(`guardianStudentLinks/${actor.uid}_${id}`).get(),
    db.collection("invitations").where("studentId", "==", id).limit(100).get(),
  ]);
  const manage = decideStudentAction({ actor, studentId: id, action: "manage", student: student.data(), link: link.data(), policy: undefined });
  if (!manage) throw new ForbiddenError("Sem acesso ao aluno (manage).");
  const now = Date.now();
  const rows = snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as InvitationDoc) }))
    .filter((d) => actor.role === "admin" || d.kind === "student")
    .map<InvitationRow>((d) => ({
      id: d.id,
      kind: d.kind,
      status: d.status === "pending" && d.expiresAt.toMillis() <= now ? "expired" : d.status,
      expiresAt: d.expiresAt.toDate().toISOString(),
      createdBy: d.createdBy,
    }))
    .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt));
  return { invitations: rows };
}

export const redeemSchema = z.object({
  token: tokenSchema,
  /** Sem sessão: dados da nova conta. Com sessão (Bearer), são ignorados e a conta autenticada é usada. */
  email: z.email().max(254).optional(),
  displayName: z.string().trim().min(2).max(120).refine(isSafeLabel, "Nome inválido.").optional(),
  password: z.string().min(8).max(128).optional(),
  contact: z.string().trim().max(60).refine(isSafeLabel, "Contato inválido.").optional(),
});

export type RedeemResult = { kind: InvitationKind; studentId: string; uid: string; accountCreated: boolean; replayed: boolean };

const INVALID = () => invalid("invitation_invalid", "Convite inválido, expirado ou já utilizado.");

/**
 * Resgata um convite. Sem sessão: cria a conta (Auth) com e-mail/senha e perfil do papel do convite. Com sessão: vincula a
 * conta autenticada (sem perfil, ou já com o mesmo papel). Todas as condições (pendente, não expirado, aluno ativo, sem
 * login anterior) são relidas na transação; se ela falhar, a conta recém-criada é removida (compensação).
 */
export async function redeemInvitation(deps: { auth: Auth; db: Firestore }, session: Actor | null, raw: unknown): Promise<RedeemResult> {
  const { auth, db } = deps;
  const input = redeemSchema.parse(raw);
  const id = tokenHash(input.token);
  const early = await db.doc(`invitations/${id}`).get();
  const invitation = early.data() as InvitationDoc | undefined;
  const replayByOwner = Boolean(session && invitation?.status === "used" && invitation.usedBy === session.uid);
  if (!invitation || (!replayByOwner && (invitation.status !== "pending" || invitation.expiresAt.toMillis() <= Date.now()))) throw INVALID();
  const wantedRole = invitation.kind === "guardian" ? "guardian" : "student";

  let uid: string;
  let created = false;
  let email: string;
  let displayName: string;
  if (session) {
    if (session.role && session.role !== wantedRole) throw invalid("account_role_mismatch", "Esta conta tem outro perfil de acesso.");
    uid = session.uid;
    const authUser = await auth.getUser(uid);
    email = authUser.email ?? "";
    displayName = input.displayName ?? authUser.displayName ?? email;
  } else {
    if (!input.email || !input.password || !input.displayName) throw invalid("account_data_required", "Informe nome, e-mail e senha.");
    try {
      const user = await auth.createUser({ email: input.email.toLowerCase(), password: input.password, displayName: input.displayName });
      uid = user.uid;
      email = input.email.toLowerCase();
      displayName = input.displayName;
      created = true;
    } catch (error) {
      if ((error as { code?: string }).code === "auth/email-already-exists") throw conflict("account_exists", "Já existe uma conta com este e-mail. Entre e abra o convite novamente.");
      throw error;
    }
  }

  try {
    await db.runTransaction(async (tx) => {
      const refs = [
        db.doc(`invitations/${id}`),
        db.doc(`students/${invitation.studentId}`),
        db.doc(`users/${uid}`),
        db.doc(`guardianStudentLinks/${linkId(uid, invitation.studentId)}`),
        db.doc(`uniquenessKeys/studentLogin_${uid}`),
      ];
      const [inv, student, profileSnap, link, loginKey] = await tx.getAll(...refs);
      const current = inv!.data() as InvitationDoc | undefined;
      if (current?.status === "used" && current.usedBy === uid) return; // replay do mesmo dono
      if (!current || current.status !== "pending" || current.expiresAt.toMillis() <= Date.now()) throw INVALID();
      const studentData = student!.data() as { status: string; userUid: string | null } | undefined;
      if (!studentData || studentData.status !== "active") throw invalid("student_inactive", "Aluno inativo.");
      const profile = profileSnap!.exists ? parseProfile(profileSnap!.data()) : null;
      if (profileSnap!.exists && !profile) throw invalid("account_role_mismatch", "Perfil da conta inválido.");
      if (profile && (profile.role !== wantedRole || profile.status !== "active")) throw invalid("account_role_mismatch", "Esta conta tem outro perfil de acesso.");
      if (wantedRole === "student") {
        if (studentData.userUid) throw conflict("student_has_login", "O aluno já possui login.");
        if (loginKey!.exists) throw conflict("account_already_student", "Esta conta já é login de outro aluno.");
      }
      const now = FieldValue.serverTimestamp();
      if (!profile) {
        tx.set(db.doc(`users/${uid}`), {
          email,
          displayName,
          role: wantedRole,
          status: "active",
          permissions: [],
          accessVersion: 1,
          ...(input.contact ? { contact: input.contact } : {}),
          updatedAt: now,
        });
      }
      if (wantedRole === "guardian") {
        tx.set(link!.ref, { guardianUid: uid, studentId: invitation.studentId, status: "active", source: "invitation", invitationId: id, createdBy: current.createdBy, createdAt: now, updatedAt: now });
      } else {
        tx.update(student!.ref, { userUid: uid, version: FieldValue.increment(1), updatedAt: now });
        tx.create(loginKey!.ref, { studentId: invitation.studentId, createdAt: now });
      }
      tx.update(inv!.ref, { status: "used", usedBy: uid, usedAt: now });
      auditInTransaction(db, tx, `invitation__${id}__redeem`, {
        action: "invitation.redeem",
        actorUid: uid,
        actorRole: wantedRole,
        target: { type: "invitation", id },
        after: { kind: invitation.kind, studentId: invitation.studentId, accountCreated: created },
      });
    }, COMMAND_TRANSACTION);
  } catch (error) {
    if (created) await auth.deleteUser(uid).catch(() => undefined);
    throw error;
  }
  return { kind: invitation.kind, studentId: invitation.studentId, uid, accountCreated: created, replayed: replayByOwner };
}
