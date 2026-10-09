import { authenticatedRoute } from "@/modules/access/command-route";
import { maintainDays } from "@/modules/reports/sales-report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Projeção diária dos relatórios de vendas (F21), só administração (`finance.manage`): `{mode: "verify" | "rebuild", from, to}`.
 * `verify` compara o cache de cada dia fechado com as fontes, sem escrever; `rebuild` reaplica (o mesmo conteúdo dá o mesmo digest).
 * O dia corrente nunca tem cache. Nada aqui altera dinheiro, estoque ou livro.
 */
export const POST = (request: Request) => authenticatedRoute(request, "reports days", ({ actor, deps, body }) => maintainDays(deps.db, actor, body));
