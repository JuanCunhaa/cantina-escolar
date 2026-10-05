import { authenticatedRoute } from "@/modules/access/command-route";
import { quoteExchange } from "@/modules/orders/amend";

export const dynamic = "force-dynamic";

/** Prévia da troca (só leitura): o que sai, o que entra e a diferença calculada no servidor. Nada é gravado. */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "orders exchange quote", async ({ actor, deps, body }) => quoteExchange(deps.db, actor, { ...(body as object), orderId: (await context.params).id }));
