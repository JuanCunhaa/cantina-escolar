import { authenticatedRoute } from "@/modules/access/command-route";
import { reverseManualTopup } from "@/modules/payments/topup-commands";

export const dynamic = "force-dynamic";

/** Estorno (total/parcial) da recarga manual: permissão separada `topup.reverse`, motivo; novo movimento. A recarga vem da URL. */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "topup reverse", async ({ actor, deps, body }) => reverseManualTopup(deps.db, actor, { ...(body as object), topupId: (await context.params).id }));
