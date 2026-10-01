import { authenticatedRoute } from "@/modules/access/command-route";
import { setStudentPolicy } from "@/modules/policies/commands";

export const dynamic = "force-dynamic";

/** Permissões de compra do aluno: qualquer responsável vinculado ativo ou a administração. */
export const POST = (request: Request) =>
  authenticatedRoute(request, "policy command", ({ actor, deps, body }) => setStudentPolicy(deps.db, actor, body));
