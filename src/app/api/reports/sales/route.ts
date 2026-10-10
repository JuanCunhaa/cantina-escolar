import { authenticatedRoute } from "@/modules/access/command-route";
import { salesReport } from "@/modules/reports/sales-report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Relatório de vendas, CMV, margens, perdas, pedidos a realizar e cancelamentos (`?from=&to=&shiftId=&productId=&categoryId=&channel=`).
 * Administração (finance.manage + costs.read + profit.read) recebe custos e margens; cantina (reports.operational) recebe só quantidades e valores
 * vendidos; os demais papéis, 403. O corte é decidido pelo servidor, nunca pelo cliente.
 */
export const GET = (request: Request) => authenticatedRoute(request, "sales report", ({ actor, deps, url }) => salesReport(deps.db, actor, Object.fromEntries(url.searchParams)));
