import { authenticatedRoute } from "@/modules/access/command-route";
import { changeException } from "@/modules/policies/commands";

export const dynamic = "force-dynamic";

/** Exceção de compra de uso único: responsável vinculado ativo ou administração (motivo obrigatório; auditada). */
export const POST = (request: Request) =>
  authenticatedRoute(request, "policy exception command", ({ actor, deps, body }) => changeException(deps.db, actor, body));
