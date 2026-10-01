import { createHash, randomBytes } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { auditInTransaction } from "@/modules/audit/log";
import type { Actor } from "./actor";
import { authorize } from "./authorize";
import { ForbiddenError } from "./errors";
import { parseProfile, type AccessProfile } from "./profile";
import { EXTRA_PERMISSIONS, ROLES, USER_STATUSES } from "./roles";

export class IdempotencyConflictError extends Error {}
export class UserNotFoundError extends Error {}
export class InvalidAccessChangeError extends Error {}
export class LastAdminError extends Error {}

const uidPattern = /^[A-Za-z0-9]{1,128}$/;

/** Cria ou altera o acesso (papel, situação, permissões extras) de uma conta. Comando de administração. */
export const setUserAccessSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    uid: z.string().regex(uidPattern).optional(),
    email: z.email().max(254).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    permissions: z.array(z.enum(EXTRA_PERMISSIONS)).max(EXTRA_PERMISSIONS.length).optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .refine((v) => Boolean(v.uid) !== Boolean(v.email), { message: "Informe uid ou email, não ambos." });
export type SetUserAccessInput = z.infer<typeof setUserAccessSchema>;

export type SetUserAccessResult = { uid: string; changed: boolean; replayed: boolean };

type Stored = { payloadHash: string; response: { uid: string; changed: boolean } };

function view(profile: AccessProfile | null): Record<string, unknown> | null {
  return profile && { role: profile.role, status: profile.status, permissions: profile.permissions, accessVersion: profile.accessVersion };
}

export async function setUserAccess(
  deps: { auth: Auth; db: Firestore },
  actor: Actor,
  rawInput: unknown,
): Promise<SetUserAccessResult> {
  authorize(actor, "users.manage");
  const input = setUserAccessSchema.parse(rawInput);
  const { auth, db } = deps;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        a: "access",
        uid: input.uid ?? null,
        email: input.email?.toLowerCase() ?? null,
        name: input.displayName ?? null,
        role: input.role ?? null,
        status: input.status ?? null,
        permissions: input.permissions ?? null,
        reason: input.reason,
      }),
    )
    .digest("hex");
  const idemRef = db.doc(`idempotencyRecords/${actor.uid}__access__${input.key}`);

  // Replay antes de qualquer efeito externo (criar conta no Auth).
  const early = await idemRef.get();
  if (early.exists) {
    const stored = early.data() as Stored;
    if (stored.payloadHash !== hash) throw new IdempotencyConflictError("Chave reutilizada com payload diferente.");
    await syncAuthDisabled(auth, db, stored.response.uid);
    return { ...stored.response, replayed: true };
  }

  const uid = await resolveUid(auth, input);
  const authUser = await authUserFor(auth, uid);
  const profileRef = db.doc(`users/${uid}`);
  const auditId = `${actor.uid}__access__${input.key}`;

  const result = await db.runTransaction(async (tx) => {
    // Leituras antes das escritas; o último administrador ativo é conferido na própria transação.
    const [idem, snap, admins, actorSnap] = await Promise.all([
      tx.get(idemRef),
      tx.get(profileRef),
      tx.get(db.collection("users").where("role", "==", "admin").where("status", "==", "active").limit(2)),
      tx.get(db.doc(`users/${actor.uid}`)),
    ]);
    // O ator pode ter sido rebaixado/desativado entre a autenticação e a transação: confere o perfil atual dele aqui.
    const actorProfile = parseProfile(actorSnap.data());
    if (actorProfile?.status !== "active" || actorProfile.role !== "admin") throw new ForbiddenError("Ator sem permissão atual.");
    if (idem.exists) {
      const stored = idem.data() as Stored;
      if (stored.payloadHash !== hash) throw new IdempotencyConflictError("Chave reutilizada com payload diferente.");
      return { ...stored.response, replayed: true };
    }
    const before = snap.exists ? parseProfile(snap.data()) : null;
    const role = input.role ?? before?.role;
    if (!role) throw new InvalidAccessChangeError("Papel obrigatório para conta sem perfil.");
    const permissions = input.permissions ?? before?.permissions ?? [];
    if (permissions.length > 0 && role !== "secretaria") {
      throw new InvalidAccessChangeError("Permissões extras só se aplicam à secretaria.");
    }
    const status = input.status ?? before?.status ?? "active";
    const loseAdmin = before?.role === "admin" && before.status === "active" && !(role === "admin" && status === "active");
    if (loseAdmin && admins.docs.every((d) => d.id === uid)) {
      throw new LastAdminError("Não é possível remover o último administrador ativo.");
    }

    const after: AccessProfile = {
      email: authUser.email ?? before?.email ?? "",
      displayName: input.displayName ?? before?.displayName ?? authUser.displayName ?? authUser.email ?? uid,
      role,
      status,
      permissions: [...permissions],
      accessVersion: (before?.accessVersion ?? 0) + 1,
    };
    const changed =
      !before ||
      before.role !== after.role ||
      before.status !== after.status ||
      before.displayName !== after.displayName ||
      before.permissions.join() !== after.permissions.join();
    if (changed) {
      tx.set(profileRef, { ...after, updatedAt: FieldValue.serverTimestamp() });
      auditInTransaction(db, tx, auditId, {
        action: "access.set",
        actorUid: actor.uid,
        actorRole: actor.role ?? null,
        target: { type: "user", id: uid },
        reason: input.reason,
        before: view(before),
        after: view(after),
      });
    }
    tx.create(idemRef, { payloadHash: hash, response: { uid, changed }, createdAt: FieldValue.serverTimestamp() });
    return { uid, changed, replayed: false };
  });

  // Efeitos no Auth somente após o commit; a decisão de acesso já vale pelo perfil (servidor e Rules).
  if (!result.replayed) await syncAuthDisabled(auth, db, uid, true);
  return result;
}

async function resolveUid(auth: Auth, input: SetUserAccessInput): Promise<string> {
  if (input.uid) return (await authUserFor(auth, input.uid)).uid;
  const email = input.email!.toLowerCase();
  try {
    return (await auth.getUserByEmail(email)).uid;
  } catch {
    if (!input.role) throw new InvalidAccessChangeError("Papel obrigatório para criar conta.");
    // Senha aleatória descartada: a pessoa define a própria senha pelo fluxo "Esqueci minha senha".
    const created = await auth.createUser({ email, displayName: input.displayName, password: randomBytes(24).toString("base64url") });
    return created.uid;
  }
}

async function authUserFor(auth: Auth, uid: string) {
  try {
    return await auth.getUser(uid);
  } catch {
    throw new UserNotFoundError("Conta não encontrada.");
  }
}

/** Reflete a situação do perfil no Auth: desativada = conta desabilitada e sessões revogadas. Idempotente. */
async function syncAuthDisabled(auth: Auth, db: Firestore, uid: string, revoke = false): Promise<void> {
  const profile = parseProfile((await db.doc(`users/${uid}`).get()).data());
  if (!profile) return;
  const disabled = profile.status === "disabled";
  const current = await auth.getUser(uid);
  if (current.disabled !== disabled) await auth.updateUser(uid, { disabled });
  if (disabled && (revoke || !current.disabled)) await auth.revokeRefreshTokens(uid);
}
