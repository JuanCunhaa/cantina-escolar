import { authenticatedRoute } from "@/modules/access/command-route";
import { readOverview } from "@/modules/inventory/queries";

export const dynamic = "force-dynamic";

/** Visão geral do estoque (cantina e administração). Custos só aparecem para quem tem `costs.read`. */
export const GET = (request: Request) => authenticatedRoute(request, "inventory overview", ({ actor, deps }) => readOverview(deps.db, actor));
