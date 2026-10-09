import { authenticatedRoute } from "@/modules/access/command-route";
import { onlineProviders } from "@/modules/payments/online/config";
import { reconcileAndConfirm } from "@/modules/payments/online/reconcile";

export const dynamic = "force-dynamic";

/**
 * Conciliação pela tela (F18 + F19): resolve criação incerta (consulta por referência; nunca cria outra cobrança sozinha,
 * `{ resend: true }` reenvia o mesmo Pix com a mesma chave) e consulta o pagamento no provedor (confirmação confiável, a mesma do
 * webhook). Recupera notificação perdida e pagamento tardio. Responsável vinculado ou administração.
 */
export const POST = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "topup intent reconcile", async ({ actor, deps, body }) =>
    reconcileAndConfirm(deps.db, actor, (await context.params).id, body ?? {}, { providers: onlineProviders() }),
  );
