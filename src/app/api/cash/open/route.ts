import { authenticatedRoute } from "@/modules/access/command-route";
import { openCashSession } from "@/modules/cash/cash-commands";

export const dynamic = "force-dynamic";

/** Abre o PRÓPRIO caixa com saldo inicial informado e confirmado. Idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "cash open", ({ actor, deps, body }) => openCashSession(deps.db, actor, body));
