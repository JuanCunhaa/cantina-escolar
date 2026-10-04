import { authenticatedRoute } from "@/modules/access/command-route";
import { deliverOrder } from "@/modules/orders/fulfillment";

export const dynamic = "force-dynamic";

/** Entrega direta ou parcial por quantidade de item. O pedido vem da URL; o resto do comando do corpo (idempotente por `key`). */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders deliver", async ({ actor, deps, body }) => deliverOrder(deps.db, actor, { ...(body as object), orderId: (await context.params).id }));
