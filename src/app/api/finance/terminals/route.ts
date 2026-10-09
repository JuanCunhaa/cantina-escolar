import { authenticatedRoute } from "@/modules/access/command-route";
import { listTerminals } from "@/modules/fees/fee-queries";

export const dynamic = "force-dynamic";

/** Maquininhas ativas para o operador escolher no recebimento (secretaria/balcão): só nome e meios, NUNCA percentuais nem prazos. */
export const GET = (request: Request) => authenticatedRoute(request, "finance terminals", ({ actor, deps }) => listTerminals(deps.db, actor));
