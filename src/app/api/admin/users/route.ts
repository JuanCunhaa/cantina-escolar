import { ZodError } from "zod";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { requireActor } from "@/modules/access/actor";
import { accessErrorResponse } from "@/modules/access/http";
import {
  IdempotencyConflictError,
  InvalidAccessChangeError,
  LastAdminError,
  setUserAccess,
  UserNotFoundError,
} from "@/modules/access/users-command";

export const dynamic = "force-dynamic";

/** Administração de papéis/situação/permissões extras. Somente administração (capacidade users.manage). */
export async function POST(request: Request): Promise<Response> {
  try {
    const db = adminDb();
    const actor = await requireActor(adminAuth(), db, request);
    const body: unknown = await request.json().catch(() => null);
    return Response.json(await setUserAccess({ auth: adminAuth(), db }, actor, body));
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;
    if (error instanceof ZodError) return Response.json({ error: "invalid_input" }, { status: 400 });
    if (error instanceof InvalidAccessChangeError) return Response.json({ error: "invalid_change" }, { status: 422 });
    if (error instanceof UserNotFoundError) return Response.json({ error: "user_not_found" }, { status: 404 });
    if (error instanceof IdempotencyConflictError) return Response.json({ error: "idempotency_conflict" }, { status: 409 });
    if (error instanceof LastAdminError) return Response.json({ error: "last_admin" }, { status: 409 });
    console.error("access command failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
