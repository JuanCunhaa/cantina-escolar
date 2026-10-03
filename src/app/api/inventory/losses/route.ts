import { authenticatedRoute } from "@/modules/access/command-route";
import { registerLoss } from "@/modules/inventory/commands";

export const dynamic = "force-dynamic";

/** Perda (vencimento, quebra, descarte, consumo interno) com motivo; cantina e administração, idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "inventory loss", ({ actor, deps, body }) => registerLoss(deps.db, actor, body));
