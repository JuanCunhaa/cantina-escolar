import { adminDb } from "@/lib/firebase/admin";
import { onlineProviders } from "@/modules/payments/online/config";
import { handleMercadoPagoWebhook } from "@/modules/payments/online/webhook-handler";

export const dynamic = "force-dynamic";

/**
 * Notificação do Mercado Pago (API Orders). Sem sessão: autenticada pela assinatura `x-signature` (chave secreta do webhook em
 * `MERCADOPAGO_WEBHOOK_SECRET`). Não confia no status do corpo: consulta a order no provedor e só então confirma e credita,
 * numa transação idempotente (src/modules/payments/online/confirmation.ts).
 */
export const POST = (request: Request) => handleMercadoPagoWebhook(request, { db: adminDb(), providers: onlineProviders(), secret: process.env.MERCADOPAGO_WEBHOOK_SECRET });
