import { authenticatedRoute } from "@/modules/access/command-route";
import { setDailyCapacity } from "@/modules/inventory/commands";

export const dynamic = "force-dynamic";

/** Cota planejada por produto/data/turno; somente administração, idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "inventory capacity", ({ actor, deps, body }) => setDailyCapacity(deps.db, actor, body));
