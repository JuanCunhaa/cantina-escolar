import { authenticatedRoute } from "@/modules/access/command-route";
import { setPreparation } from "@/modules/orders/fulfillment";

export const dynamic = "force-dynamic";

/** Preparo: em preparação ou pronto. O pedido vem da URL; o resto do comando do corpo (idempotente por `key`). */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders prepare", async ({ actor, deps, body }) => setPreparation(deps.db, actor, { ...(body as object), orderId: (await context.params).id }));
