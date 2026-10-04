import { authenticatedRoute } from "@/modules/access/command-route";
import { getOrderDetail } from "@/modules/orders/history";

export const dynamic = "force-dynamic";

/** Detalhe e recibo interno de um pedido, pelo vínculo/perfil atuais. */
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "order detail", async ({ actor, deps }) => getOrderDetail(deps.db, actor, (await context.params).id));
