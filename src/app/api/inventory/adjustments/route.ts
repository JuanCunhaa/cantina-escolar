import { authenticatedRoute } from "@/modules/access/command-route";
import { changeAdjustment } from "@/modules/inventory/commands";

export const dynamic = "force-dynamic";

/** Inventário e ajustes (`count`, `adjust`, `extend`, `threshold`); somente administração, idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "inventory adjustment", ({ actor, deps, body }) => changeAdjustment(deps.db, actor, body));
