import { authenticatedRoute } from "@/modules/access/command-route";
import { amendOptions } from "@/modules/orders/amend-queries";

export const dynamic = "force-dynamic";

/** Datas de destino e produtos da troca para a tela da equipe (`orders.amend`). Exibição apenas: os comandos revalidam. */
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders amend options", async ({ actor, deps }) => amendOptions(deps.db, actor, (await context.params).id));
