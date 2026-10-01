import type { Auth } from "firebase-admin/auth";
import { parseRole, type Role } from "./roles";

/** `role` vem da custom claim assinada no ID token (provisório até F03); nunca do corpo da requisição. */
export type Actor = { uid: string; role?: Role | null };

export class UnauthenticatedError extends Error {}

/** Verifica o ID token Firebase (Authorization: Bearer) incluindo revogação. Sem cookie, portanto sem superfície CSRF. */
export async function requireActor(auth: Auth, request: Request): Promise<Actor> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match?.[1]) throw new UnauthenticatedError("Token ausente.");
  try {
    const decoded = await auth.verifyIdToken(match[1], true);
    return { uid: decoded.uid, role: parseRole(decoded.role) };
  } catch {
    throw new UnauthenticatedError("Token inválido ou revogado.");
  }
}
