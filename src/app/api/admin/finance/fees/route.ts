import { authenticatedRoute } from "@/modules/access/command-route";
import { listFeeConfig } from "@/modules/fees/fee-queries";

export const dynamic = "force-dynamic";

/** Cadastro de provedores/maquininhas e regras de taxa versionadas. Só administração. */
export const GET = (request: Request) => authenticatedRoute(request, "fees config", ({ actor, deps }) => listFeeConfig(deps.db, actor));
