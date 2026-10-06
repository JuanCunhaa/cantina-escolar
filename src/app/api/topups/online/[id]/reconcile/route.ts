import { authenticatedRoute } from "@/modules/access/command-route";
import { onlineProviders } from "@/modules/payments/online/config";
import { reconcileTopupIntent } from "@/modules/payments/online/intent-commands";

export const dynamic = "force-dynamic";

/**
 * Conciliação de criação incerta: consulta o provedor; nunca cria outra cobrança sozinha. `{ resend: true }` (pedido explícito
 * da família) reenvia o mesmo Pix com a mesma chave de idempotência. Responsável vinculado ou administração.
 */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "topup intent reconcile", async ({ actor, deps, body }) =>
    reconcileTopupIntent(deps.db, actor, (await context.params).id, body ?? {}, { providers: onlineProviders() }),
  );
