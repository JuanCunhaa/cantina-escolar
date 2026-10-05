import { authenticatedRoute } from "@/modules/access/command-route";
import { placeCounterSale } from "@/modules/pos/commands";

export const dynamic = "force-dynamic";

/** Venda de balcão com o saldo da carteira do aluno (idempotente por `key`). `pos.operate`. */
export const POST = (request: Request) =>
  authenticatedRoute(request, "pos sale", ({ actor, deps, body }) => placeCounterSale(deps.db, actor, body));
