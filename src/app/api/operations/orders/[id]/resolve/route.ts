import { authenticatedRoute } from "@/modules/access/command-route";
import { resolveNotPickedUp } from "@/modules/orders/fulfillment";

export const dynamic = "force-dynamic";

/** Resolução administrativa de não retirado. O pedido vem da URL; o resto do comando do corpo (idempotente por `key`). */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders resolve", async ({ actor, deps, body }) => resolveNotPickedUp(deps.db, actor, { ...(body as object), orderId: (await context.params).id }));
