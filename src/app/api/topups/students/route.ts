import { authenticatedRoute } from "@/modules/access/command-route";
import { topupRoster, topupStudent } from "@/modules/payments/topup-queries";

export const dynamic = "force-dynamic";

/** Busca nominal da secretaria: alunos ativos com turma/turno ou, com `?id=`, o aluno com saldo e últimas recargas. */
export const GET = (request: Request) =>
  authenticatedRoute(request, "topup students", ({ actor, deps, url }) => {
    const id = url.searchParams.get("id");
    return id ? topupStudent(deps.db, actor, id) : topupRoster(deps.db, actor);
  });
