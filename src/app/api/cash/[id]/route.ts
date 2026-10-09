import { authenticatedRoute } from "@/modules/access/command-route";
import { getCashSession } from "@/modules/cash/cash-queries";

export const dynamic = "force-dynamic";

/** Uma sessão de caixa com histórico de fechamentos e movimentos posteriores: o dono ou a administração. */
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "cash session", async ({ actor, deps }) => getCashSession(deps.db, actor, (await context.params).id));
