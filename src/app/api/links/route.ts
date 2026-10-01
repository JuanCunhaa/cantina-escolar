import { authenticatedRoute } from "@/modules/access/command-route";
import { runLinkCommand } from "@/modules/guardians/links";

export const dynamic = "force-dynamic";

/** Vínculos responsável–aluno e login do aluno. */
export const POST = (request: Request) =>
  authenticatedRoute(request, "link command", ({ actor, deps, body }) => runLinkCommand(deps, actor, body));
