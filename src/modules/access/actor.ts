import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { AccountInactiveError, UnauthenticatedError } from "./errors";
import { parseProfile } from "./profile";
import type { ExtraPermission, Role } from "./roles";

/**
 * Ator autenticado. Papel e permissões vêm do perfil ATUAL em `users/{uid}` (nunca de claim antiga nem do corpo
 * da requisição). `role: null` = conta autenticada sem perfil válido: nada é autorizado.
 */
export type Actor = { uid: string; role?: Role | null; permissions?: readonly ExtraPermission[] };

export { UnauthenticatedError };

/**
 * Verifica o ID token Firebase (Authorization: Bearer) incluindo revogação/conta desativada e carrega o perfil
 * atual. Sem cookie, portanto sem superfície CSRF. Conta com perfil desativado é recusada em toda requisição.
 */
export async function requireActor(auth: Auth, db: Firestore, request: Request): Promise<Actor> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match?.[1]) throw new UnauthenticatedError("Token ausente.");
  let uid: string;
  try {
    uid = (await auth.verifyIdToken(match[1], true)).uid;
  } catch {
    throw new UnauthenticatedError("Token inválido ou revogado.");
  }
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) return { uid, role: null, permissions: [] };
  const profile = parseProfile(snap.data());
  if (!profile) return { uid, role: null, permissions: [] };
  if (profile.status !== "active") throw new AccountInactiveError("Conta desativada.");
  return { uid, role: profile.role, permissions: profile.permissions };
}
