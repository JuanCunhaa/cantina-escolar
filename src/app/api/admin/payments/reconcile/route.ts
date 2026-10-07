import { z } from "zod";
import { authenticatedRoute } from "@/modules/access/command-route";
import { authorize } from "@/modules/access/authorize";
import { sweepIntents, refreshIntent } from "@/modules/payments/online/confirmation";
import { onlineProviders } from "@/modules/payments/online/config";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ intentId: z.string().regex(/^tpi_[a-f0-9]{20}$/).optional(), limit: z.number().int().min(1).max(300).optional() }).strict();

/**
 * Conciliação MANUAL autorizada: reconsulta o provedor para uma recarga (`intentId`) ou para o lote recente (varredura). A mesma
 * decisão do webhook e da rotina agendada; idempotente (reexecutar não duplica crédito). Somente administração.
 */
export const POST = (request: Request) =>
  authenticatedRoute(request, "payments reconcile", async ({ actor, deps, body }) => {
    authorize(actor, "payments.review");
    const input = bodySchema.parse(body ?? {});
    const confirmDeps = { providers: onlineProviders() };
    if (input.intentId) return { result: await refreshIntent(deps.db, confirmDeps, input.intentId, "admin") };
    return { sweep: await sweepIntents(deps.db, confirmDeps, { limit: input.limit }) };
  });
