import { authenticatedRoute } from "@/modules/access/command-route";
import { filtersFromParams } from "@/modules/orders/history-model";
import { preparationPanel } from "@/modules/orders/operations";

export const dynamic = "force-dynamic";

/** Painel "O que preparar": totais da data/turno, previsão de sete dias e pendências de resolução. Exige `orders.operate`. */
export const GET = (request: Request) => authenticatedRoute(request, "operations preparation", ({ actor, deps, url }) => preparationPanel(deps.db, actor, filtersFromParams(url.searchParams)));
