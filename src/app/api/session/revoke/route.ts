import { randomUUID } from "node:crypto";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { requireActor } from "@/modules/access/actor";
import { accessErrorResponse } from "@/modules/access/http";
import { appendAudit } from "@/modules/audit/log";

export const dynamic = "force-dynamic";

/** "Sair de todos os dispositivos": revoga os refresh tokens do próprio ator; tokens já emitidos deixam de valer no servidor. */
export async function POST(request: Request): Promise<Response> {
  try {
    const db = adminDb();
    const actor = await requireActor(adminAuth(), db, request);
    await adminAuth().revokeRefreshTokens(actor.uid);
    await appendAudit(db, `${actor.uid}__session-revoke__${randomUUID()}`, {
      action: "session.revoke_all",
      actorUid: actor.uid,
      actorRole: actor.role ?? null,
      target: { type: "user", id: actor.uid },
    });
    return Response.json({ revoked: true });
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;
    console.error("session revoke failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
