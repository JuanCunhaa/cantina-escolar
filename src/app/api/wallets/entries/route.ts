import { authenticatedRoute } from "@/modules/access/command-route";
import { filtersFromParams } from "@/modules/orders/history-model";
import { listStatement } from "@/modules/wallet/queries";

export const dynamic = "force-dynamic";

/** Extrato da carteira paginado por cursor, com filtro de tipo e período (responsável vinculado, o próprio aluno ou administração). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "wallet statement", ({ actor, deps, url }) => listStatement(deps.db, actor, filtersFromParams(url.searchParams)));
