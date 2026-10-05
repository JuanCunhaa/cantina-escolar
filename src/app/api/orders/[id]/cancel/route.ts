import { authenticatedRoute } from "@/modules/access/command-route";
import { cancelOrder } from "@/modules/orders/cancellation";

export const dynamic = "force-dynamic";

/**
 * Cancelamento total/parcial do restante do pedido, pelo responsável (dentro do prazo do pedido) ou pela equipe autorizada
 * (excepcional, com motivo). O pedido vem da URL; o resto do comando do corpo (idempotente por `key`). O papel e o vínculo
 * são os do servidor, relidos na transação — nunca do corpo.
 */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders cancel", async ({ actor, deps, body }) => cancelOrder(deps.db, actor, { ...(body as object), orderId: (await context.params).id }));
