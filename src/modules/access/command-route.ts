import "server-only";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { ZodError } from "zod";
import { DomainError } from "@/lib/domain-error";
import { IdempotencyConflictError } from "@/lib/firebase/command";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { requireActor, type Actor } from "./actor";
import { accessErrorResponse } from "./http";

export type RouteDeps = { auth: Auth; db: Firestore };

/** Mapeia erros de comando para respostas HTTP sem vazar detalhe interno. */
export function commandErrorResponse(error: unknown, label: string): Response {
  const denied = accessErrorResponse(error);
  if (denied) return denied;
  if (error instanceof ZodError) return Response.json({ error: "invalid_input" }, { status: 400 });
  if (error instanceof DomainError) return Response.json(error.details ? { error: error.code, details: error.details } : { error: error.code }, { status: error.status });
  if (error instanceof IdempotencyConflictError) return Response.json({ error: "idempotency_conflict" }, { status: 409 });
  console.error("%s failed", label, error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "internal" }, { status: 500 });
}

/** Rota autenticada: ator pelo ID token (perfil atual), corpo JSON e erros mapeados. A autorização fina é do handler. */
export async function authenticatedRoute(
  request: Request,
  label: string,
  handler: (ctx: { actor: Actor; deps: RouteDeps; body: unknown; url: URL }) => Promise<unknown>,
): Promise<Response> {
  try {
    const deps = { auth: adminAuth(), db: adminDb() };
    const actor = await requireActor(deps.auth, deps.db, request);
    const body: unknown = request.method === "GET" ? null : await request.json().catch(() => null);
    return Response.json(await handler({ actor, deps, body, url: new URL(request.url) }));
  } catch (error) {
    return commandErrorResponse(error, label);
  }
}
