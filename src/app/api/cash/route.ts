import { authenticatedRoute } from "@/modules/access/command-route";
import { getMyCash } from "@/modules/cash/cash-queries";

export const dynamic = "force-dynamic";

/** Caixa do PRÓPRIO operador (`cash.operate`): sessão do dia por ponto, o já recebido, alertas próprios e últimos fechamentos (`?date=`). */
export const GET = (request: Request) => authenticatedRoute(request, "cash mine", ({ actor, deps, url }) => getMyCash(deps.db, actor, Object.fromEntries(url.searchParams)));
