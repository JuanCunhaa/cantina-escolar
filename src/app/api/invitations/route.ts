import { authenticatedRoute } from "@/modules/access/command-route";
import { listInvitations, runInvitationCommand } from "@/modules/guardians/invitations";

export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  authenticatedRoute(request, "invitations list", ({ actor, deps, url }) => listInvitations(deps.db, actor, url.searchParams.get("studentId")));

/** Criar/revogar convites. O token aparece uma única vez, na resposta da criação. */
export const POST = (request: Request) =>
  authenticatedRoute(request, "invitation command", ({ actor, deps, body }) => runInvitationCommand(deps.db, actor, body));
