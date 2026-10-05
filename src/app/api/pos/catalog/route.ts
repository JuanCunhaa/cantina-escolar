import { authenticatedRoute } from "@/modules/access/command-route";
import { posCatalog } from "@/modules/pos/queries";

export const dynamic = "force-dynamic";

/** Produtos do balcão de hoje para o turno (preço atual e unidades vendáveis; nunca custo). `pos.operate`. */
export const GET = (request: Request) =>
  authenticatedRoute(request, "pos catalog", ({ actor, deps, url }) => posCatalog(deps.db, actor, Object.fromEntries(url.searchParams)));
