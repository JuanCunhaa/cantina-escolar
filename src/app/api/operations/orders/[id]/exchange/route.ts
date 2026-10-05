import { authenticatedRoute } from "@/modules/access/command-route";
import { exchangeItems } from "@/modules/orders/amend";

export const dynamic = "force-dynamic";

/** Troca de produtos (equipe com `orders.amend`): confirma a diferença calculada pelo servidor. Idempotente por `key`. */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders exchange", async ({ actor, deps, body }) => exchangeItems(deps.db, actor, { ...(body as object), orderId: (await context.params).id }));
