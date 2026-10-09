import { authenticatedRoute } from "@/modules/access/command-route";
import { closeCashSession } from "@/modules/cash/cash-commands";

export const dynamic = "force-dynamic";

/** Fecha o PRÓPRIO caixa: contagem do dinheiro pelo total; totais e divergência calculados no servidor. Idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "cash close", ({ actor, deps, body }) => closeCashSession(deps.db, actor, body));
