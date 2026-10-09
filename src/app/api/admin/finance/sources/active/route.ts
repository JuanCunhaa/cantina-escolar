import { authenticatedRoute } from "@/modules/access/command-route";
import { setPaymentSourceActive } from "@/modules/fees/fee-commands";

export const dynamic = "force-dynamic";

/** Arquiva ou reativa um cadastro (nunca apaga). Só administração, com motivo. */
export const POST = (request: Request) => authenticatedRoute(request, "finance source active", ({ actor, deps, body }) => setPaymentSourceActive(deps.db, actor, body));
