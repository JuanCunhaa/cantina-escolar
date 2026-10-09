import { authenticatedRoute } from "@/modules/access/command-route";
import { reconcileReceipt } from "@/modules/fees/reconcile";

export const dynamic = "force-dynamic";

/** Confere a taxa REAL e/ou a liquidação de um recebimento. Não toca carteira nem livro. Só administração; idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "finance reconcile", ({ actor, deps, body }) => reconcileReceipt(deps.db, actor, body));
