import { authenticatedRoute } from "@/modules/access/command-route";
import { reviewCashDivergence } from "@/modules/cash/cash-commands";

export const dynamic = "force-dynamic";

/** Revisão administrativa da divergência (aprovar ou manter em apuração). NÃO cria ajuste em carteira, recebimento, estoque ou livro. */
export const POST = (request: Request) => authenticatedRoute(request, "cash review", ({ actor, deps, body }) => reviewCashDivergence(deps.db, actor, body));
