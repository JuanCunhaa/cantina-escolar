import type { Firestore } from "firebase-admin/firestore";
import { DomainError } from "@/lib/domain-error";
import { confirmFromProvider } from "./confirmation";
import { diagnoseSignature, parseNotification, parseSignatureHeader, verifyWebhookSignature, WEBHOOK_BODY_MAX_BYTES } from "./mercadopago-webhook";
import { ProviderError, type OnlineProviders } from "./provider";

/**
 * Endpoint de notificação do Mercado Pago (F19). Sem sessão: a autenticação é a ASSINATURA (HMAC com a chave secreta do
 * webhook). Respostas, pensadas para o reenvio do provedor (a cada 15 min enquanto não houver 200/201):
 *   - 401 assinatura ausente/inválida/antiga (nada é lido nem gravado); 503 sem chave configurada (falha fechada);
 *   - 400 corpo ilegível ou incoerente com a assinatura; 413 corpo grande;
 *   - 200 notificação autêntica PROCESSADA (creditou, já estava creditada, ignorada, order desconhecida, divergente em revisão);
 *   - 503 provedor indisponível na consulta confirmatória / 500 falha nossa → o provedor reenvia e a reconciliação cobre.
 * O status do corpo nunca credita: a order é consultada no provedor pelo servidor (confirmation.ts).
 */
export type WebhookDeps = { db: Firestore; providers: OnlineProviders; secret: string | undefined; production?: boolean; clock?: () => Date };

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleMercadoPagoWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const clock = deps.clock ?? (() => new Date());
  try {
    if (!deps.secret) return json(503, { error: "webhook_unavailable" });
    const url = new URL(request.url);
    const queryId = url.searchParams.get("data.id");
    // A assinatura cobre `data.id` (query), `x-request-id` e `ts` — NÃO o corpo. Sem `data.id` na query não há o que autenticar.
    if (!queryId) return json(400, { error: "invalid_input" });
    if (Number(request.headers.get("content-length") ?? 0) > WEBHOOK_BODY_MAX_BYTES) return json(413, { error: "payload_too_large" });
    const signature = verifyWebhookSignature({ secret: deps.secret, signature: request.headers.get("x-signature"), requestId: request.headers.get("x-request-id"), dataId: queryId, nowMs: clock().getTime() });
    if (!signature.ok) {
      // Só dados NÃO secretos (ID da order, request-id, ts, 10 primeiros hex do v1 e quais variantes do manifesto bateriam).
      const header = request.headers.get("x-signature");
      const parsed = parseSignatureHeader(header);
      console.warn(
        "mercadopago webhook rejected: %s %s",
        signature.reason,
        JSON.stringify({ dataId: queryId.slice(0, 40), requestId: (request.headers.get("x-request-id") ?? "").slice(0, 60), ts: parsed?.ts ?? null, v1: parsed?.v1.slice(0, 10) ?? null, matches: signature.reason === "bad_signature" ? diagnoseSignature({ secret: deps.secret, signature: header, requestId: request.headers.get("x-request-id"), dataId: queryId }) : [] }),
      );
      return json(401, { error: "invalid_signature" });
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > WEBHOOK_BODY_MAX_BYTES) return json(413, { error: "payload_too_large" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid_input" });
    }
    const notification = parseNotification(body, queryId, url.searchParams.get("type"));
    if (!notification) return json(400, { error: "invalid_input" });
    // Só a notificação de order interessa; outros tópicos recebem 200 (o provedor não deve reenviar) e nada é lido.
    if (notification.type !== "order") return json(200, { ok: true, ignored: "topic" });

    const result = await confirmFromProvider(deps.db, { providers: deps.providers, production: deps.production, clock }, notification.orderId, {
      source: "webhook",
      event: { action: notification.action, version: notification.version, requestId: request.headers.get("x-request-id"), tsMs: signature.tsMs, liveMode: notification.liveMode, userId: notification.userId },
    });
    return json(200, { ok: true, outcome: result.outcome });
  } catch (error) {
    if (error instanceof ProviderError || (error instanceof DomainError && error.status === 503)) return json(503, { error: "provider_unavailable" });
    console.error("mercadopago webhook failed", error instanceof Error ? error.name : "unknown");
    return json(500, { error: "internal" });
  }
}
