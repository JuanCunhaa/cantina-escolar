import { authenticatedRoute } from "@/modules/access/command-route";
import { listOrders } from "@/modules/orders/history";
import { filtersFromParams } from "@/modules/orders/history-model";

export const dynamic = "force-dynamic";

/** Histórico paginado por cursor (responsável: um filho ou todos os vinculados; aluno: o próprio). Autorização atual no servidor. */
export const GET = (request: Request) =>
  authenticatedRoute(request, "orders list", ({ actor, deps, url }) => listOrders(deps.db, actor, filtersFromParams(url.searchParams)));
