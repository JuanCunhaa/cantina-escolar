import { authenticatedRoute } from "@/modules/access/command-route";
import { changeReceipt } from "@/modules/inventory/commands";

export const dynamic = "force-dynamic";

/** Entrada de produto acabado (`action: create`) ou estorno (`action: reverse`); administração, idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "inventory receipt", ({ actor, deps, body }) => changeReceipt(deps.db, actor, body));
