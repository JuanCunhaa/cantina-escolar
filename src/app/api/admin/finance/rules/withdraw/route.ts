import { authenticatedRoute } from "@/modules/access/command-route";
import { withdrawFeeRuleVersion } from "@/modules/fees/fee-commands";

export const dynamic = "force-dynamic";

/** Retira uma versão de vigência FUTURA publicada por engano (marca com motivo; os valores não mudam). Só administração. */
export const POST = (request: Request) => authenticatedRoute(request, "finance rule withdraw", ({ actor, deps, body }) => withdrawFeeRuleVersion(deps.db, actor, body));
