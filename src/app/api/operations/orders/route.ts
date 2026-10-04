import { authenticatedRoute } from "@/modules/access/command-route";
import { filtersFromParams } from "@/modules/orders/history-model";
import { listDayOrders } from "@/modules/orders/operations";

export const dynamic = "force-dynamic";

/** Pedidos do dia da cantina (data/turno, filtros por turma/situação e busca por aluno). Exige `orders.operate`. */
export const GET = (request: Request) => authenticatedRoute(request, "operations orders", ({ actor, deps, url }) => listDayOrders(deps.db, actor, filtersFromParams(url.searchParams)));
