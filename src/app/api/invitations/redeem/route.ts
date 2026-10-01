import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { requireActor } from "@/modules/access/actor";
import { commandErrorResponse } from "@/modules/access/command-route";
import { redeemInvitation } from "@/modules/guardians/invitations";

export const dynamic = "force-dynamic";

/**
 * Resgate de convite. Pública por natureza (quem recebe o link ainda não tem conta): a autorização é o token secreto,
 * de uso único e com validade. Com `Authorization: Bearer`, vincula a conta autenticada; sem ele, cria a conta.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const deps = { auth: adminAuth(), db: adminDb() };
    const session = request.headers.has("authorization") ? await requireActor(deps.auth, deps.db, request) : null;
    const body: unknown = await request.json().catch(() => null);
    return Response.json(await redeemInvitation(deps, session, body));
  } catch (error) {
    return commandErrorResponse(error, "invitation redeem");
  }
}
