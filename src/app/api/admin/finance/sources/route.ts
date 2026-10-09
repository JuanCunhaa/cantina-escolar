import { authenticatedRoute } from "@/modules/access/command-route";
import { createPaymentSource } from "@/modules/fees/fee-commands";

export const dynamic = "force-dynamic";

/** Cadastra provedor online ou maquininha. Só administração; idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "finance source create", ({ actor, deps, body }) => createPaymentSource(deps.db, actor, body));
