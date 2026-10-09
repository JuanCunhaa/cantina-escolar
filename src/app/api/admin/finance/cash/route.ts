import { authenticatedRoute } from "@/modules/access/command-route";
import { listCashAdmin } from "@/modules/cash/cash-queries";

export const dynamic = "force-dynamic";

/** Todos os caixas do período e os alertas (dia sem fechamento, divergência pendente, movimentos posteriores). Só administração. */
export const GET = (request: Request) => authenticatedRoute(request, "cash admin list", ({ actor, deps, url }) => listCashAdmin(deps.db, actor, Object.fromEntries(url.searchParams)));
