import { authenticatedRoute } from "@/modules/access/command-route";
import { markNotPickedUp } from "@/modules/orders/fulfillment";

export const dynamic = "force-dynamic";

/** Marca o pedido como não retirado (sem reembolso nem perda automáticos). O pedido vem da URL; o resto do comando do corpo (idempotente por `key`). */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders not-picked-up", async ({ actor, deps, body }) => markNotPickedUp(deps.db, actor, { ...(body as object), orderId: (await context.params).id }));
