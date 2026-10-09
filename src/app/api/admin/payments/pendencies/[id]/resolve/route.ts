import { authenticatedRoute } from "@/modules/access/command-route";
import { resolvePendency } from "@/modules/payments/online/pendencies";

export const dynamic = "force-dynamic";

/** Regulariza pendência de reembolso/chargeback (recuperar do saldo atual ou absorver, com motivo). Somente administração. */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "payments pendency resolve", async ({ actor, deps, body }) => resolvePendency(deps.db, actor, { ...(body as object), pendencyId: (await context.params).id }));
