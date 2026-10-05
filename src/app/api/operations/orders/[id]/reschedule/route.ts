import { authenticatedRoute } from "@/modules/access/command-route";
import { rescheduleOrder } from "@/modules/orders/amend";

export const dynamic = "force-dynamic";

/** Reagendar/antecipar atendimento (equipe com `orders.amend`, motivo obrigatório). O pedido vem da URL; idempotente por `key`. */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders reschedule", async ({ actor, deps, body }) => rescheduleOrder(deps.db, actor, { ...(body as object), orderId: (await context.params).id }));
