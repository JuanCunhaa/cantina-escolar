import { authenticatedRoute } from "@/modules/access/command-route";
import { posRoster, posStudent } from "@/modules/pos/queries";

export const dynamic = "force-dynamic";

/** Lista de alunos ativos do balcão (turma/turno) ou, com `?id=`, o aluno escolhido com saldo e restrições de hoje. `pos.operate`. */
export const GET = (request: Request) =>
  authenticatedRoute(request, "pos students", ({ actor, deps, url }) => {
    const id = url.searchParams.get("id");
    return id ? posStudent(deps.db, actor, id) : posRoster(deps.db, actor);
  });
