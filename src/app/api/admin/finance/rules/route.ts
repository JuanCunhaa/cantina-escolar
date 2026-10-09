import { authenticatedRoute } from "@/modules/access/command-route";
import { publishFeeRule } from "@/modules/fees/fee-commands";

export const dynamic = "force-dynamic";

/** Publica uma NOVA versão da regra de taxa (nunca retroativa; fictícia recusada em produção). Só administração. */
export const POST = (request: Request) => authenticatedRoute(request, "finance rule publish", ({ actor, deps, body }) => publishFeeRule(deps.db, actor, body));
