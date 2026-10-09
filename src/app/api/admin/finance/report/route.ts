import { authenticatedRoute } from "@/modules/access/command-route";
import { financeReport } from "@/modules/reports/finance-report";

export const dynamic = "force-dynamic";

/** Relatório financeiro por período (`?from=&to=`, data do recebimento). Só administração. */
export const GET = (request: Request) => authenticatedRoute(request, "finance report", ({ actor, deps, url }) => financeReport(deps.db, actor, Object.fromEntries(url.searchParams)));
