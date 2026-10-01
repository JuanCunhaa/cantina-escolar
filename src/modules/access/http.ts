import { AccountInactiveError, ForbiddenError, UnauthenticatedError } from "./errors";

/** Mapeamento único dos erros de acesso para respostas HTTP; `null` = não é erro de acesso. */
export function accessErrorResponse(error: unknown): Response | null {
  if (error instanceof UnauthenticatedError) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (error instanceof AccountInactiveError) return Response.json({ error: "account_inactive" }, { status: 403 });
  if (error instanceof ForbiddenError) return Response.json({ error: "forbidden" }, { status: 403 });
  return null;
}
