import { authenticatedRoute } from "@/modules/access/command-route";
import { placeAdvanceOrders } from "@/modules/orders/commands";

export const dynamic = "force-dynamic";

/** Checkout antecipado (lote tudo-ou-nada, pedidos separados por data); idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "orders checkout", ({ actor, deps, body }) => placeAdvanceOrders(deps.db, actor, body));
