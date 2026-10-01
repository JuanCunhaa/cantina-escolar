import { ZodError } from "zod";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { requireActor, UnauthenticatedError } from "@/modules/access/actor";
import { IdempotencyConflictError, runProbeCommand } from "@/modules/access/probe";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Prova de fundação: nunca exposta em produção (não é carteira real).
  if (process.env.APP_ENV === "production" || !process.env.APP_ENV) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const actor = await requireActor(adminAuth(), request);
    const body: unknown = await request.json().catch(() => null);
    const result = await runProbeCommand(adminDb(), actor, body);
    return Response.json(result);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return Response.json({ error: "unauthenticated" }, { status: 401 });
    if (error instanceof ZodError) return Response.json({ error: "invalid_input" }, { status: 400 });
    if (error instanceof IdempotencyConflictError) return Response.json({ error: "idempotency_conflict" }, { status: 409 });
    console.error("probe command failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
