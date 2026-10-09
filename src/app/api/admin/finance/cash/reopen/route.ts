import { authenticatedRoute } from "@/modules/access/command-route";
import { reopenCashSession } from "@/modules/cash/cash-commands";

export const dynamic = "force-dynamic";

/** Reabre um caixa FECHADO (só administração, motivo obrigatório); o fechamento anterior é preservado. */
export const POST = (request: Request) => authenticatedRoute(request, "cash reopen", ({ actor, deps, body }) => reopenCashSession(deps.db, actor, body));
