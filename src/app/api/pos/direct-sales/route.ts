import { authenticatedRoute } from "@/modules/access/command-route";
import { recordDirectSale } from "@/modules/pos/commands";

export const dynamic = "force-dynamic";

/** Venda direta sem aluno, após o recebimento local confirmado (idempotente por `key`). `pos.operate`. */
export const POST = (request: Request) =>
  authenticatedRoute(request, "pos direct sale", ({ actor, deps, body }) => recordDirectSale(deps.db, actor, body));
