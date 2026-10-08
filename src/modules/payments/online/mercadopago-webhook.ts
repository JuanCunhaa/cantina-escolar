import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Autenticidade da notificação do Mercado Pago (API Orders, documentação oficial "Notificações", consultada em 07/10/2026,
 * https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/notifications):
 * - cabeçalhos `x-signature` (`ts=<ms>,v1=<hex>`) e `x-request-id`; `data.id` vem na query (`?data.id=<id>&type=order`);
 * - manifesto `id:[data.id em minúsculas];request-id:[x-request-id];ts:[ts];` — componente ausente é descartado;
 * - HMAC-SHA256 do manifesto com a chave secreta do webhook (painel "Suas integrações → Webhooks"), em hexadecimal,
 *   comparado em tempo constante com `v1`;
 * - o provedor tenta de novo a cada 15 min se não receber 200/201 em 22 s.
 * A assinatura prova que a notificação veio do Mercado Pago, NÃO que o pagamento está aprovado: o status do corpo nunca é
 * usado para creditar (a order é sempre consultada pelo servidor). A janela de `ts` só limita o reaproveitamento de uma
 * notificação capturada; como cada notificação é reconferida no provedor e o efeito é idempotente, a janela é larga (24 h)
 * para não rejeitar reentregas legítimas.
 */
export const WEBHOOK_TOLERANCE_MS = 24 * 60 * 60 * 1000;
export const WEBHOOK_BODY_MAX_BYTES = 64 * 1024;

export type SignatureResult = { ok: true; tsMs: number } | { ok: false; reason: "missing_secret" | "missing_signature" | "malformed_signature" | "stale_timestamp" | "bad_signature" };

export function parseSignatureHeader(header: string | null): { ts: string; v1: string } | null {
  if (!header || header.length > 512) return null;
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((p) => p.trim().split("=", 2))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== ""),
  );
  const { ts, v1 } = parts as Record<string, string | undefined>;
  return ts && v1 && /^\d{1,16}$/.test(ts) && /^[a-f0-9]{64}$/i.test(v1) ? { ts, v1: v1.toLowerCase() } : null;
}

/** Manifesto assinado. `dataId` em minúsculas (documentação); parte ausente fica de fora. */
export function signatureManifest(input: { dataId: string | null; requestId: string | null; ts: string }): string {
  return `${input.dataId ? `id:${input.dataId.toLowerCase()};` : ""}${input.requestId ? `request-id:${input.requestId};` : ""}ts:${input.ts};`;
}

export function computeSignature(secret: string, manifest: string): string {
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

export function verifyWebhookSignature(input: { secret: string | undefined; signature: string | null; requestId: string | null; dataId: string | null; nowMs: number }): SignatureResult {
  if (!input.secret) return { ok: false, reason: "missing_secret" };
  if (!input.signature) return { ok: false, reason: "missing_signature" };
  const parsed = parseSignatureHeader(input.signature);
  if (!parsed) return { ok: false, reason: "malformed_signature" };
  const expected = Buffer.from(computeSignature(input.secret, signatureManifest({ dataId: input.dataId, requestId: input.requestId, ts: parsed.ts })), "hex");
  const received = Buffer.from(parsed.v1, "hex");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return { ok: false, reason: "bad_signature" };
  const raw = Number(parsed.ts);
  const tsMs = raw < 1e12 ? raw * 1000 : raw; // `ts` é em milissegundos; segundos são aceitos por tolerância de formato
  if (!Number.isFinite(tsMs) || Math.abs(input.nowMs - tsMs) > WEBHOOK_TOLERANCE_MS) return { ok: false, reason: "stale_timestamp" };
  return { ok: true, tsMs };
}

/**
 * Diagnóstico de assinatura RECUSADA (só para o log do servidor; NUNCA aceita a requisição): quais variantes do manifesto
 * teriam batido com a chave. Serve para distinguir "chave errada" de "formato do manifesto diferente do documentado" sem
 * registrar a chave nem o v1 inteiro. Variantes: `default` (documentada), `id_original` (sem minúsculas), `sem_id`,
 * `sem_request_id`, `sem_ts`.
 */
export function diagnoseSignature(input: { secret: string; signature: string | null; requestId: string | null; dataId: string | null }): string[] {
  const parsed = parseSignatureHeader(input.signature);
  if (!parsed) return ["cabecalho_malformado"];
  const build = (id: string | null, rid: string | null, withTs = true) => `${id ? `id:${id};` : ""}${rid ? `request-id:${rid};` : ""}${withTs ? `ts:${parsed.ts};` : ""}`;
  const variants: Record<string, string> = {
    default: build(input.dataId?.toLowerCase() ?? null, input.requestId),
    id_original: build(input.dataId, input.requestId),
    sem_id: build(null, input.requestId),
    sem_request_id: build(input.dataId?.toLowerCase() ?? null, null),
    sem_ts: build(input.dataId?.toLowerCase() ?? null, input.requestId, false),
  };
  return Object.entries(variants)
    .filter(([, manifest]) => computeSignature(input.secret, manifest) === parsed.v1)
    .map(([name]) => name);
}

const notificationSchema = z
  .object({
    action: z.string().max(80).optional(),
    type: z.string().max(80).optional(),
    live_mode: z.boolean().optional(),
    user_id: z.union([z.string().max(40), z.number()]).optional(),
    data: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), version: z.union([z.number(), z.string().max(40)]).optional() }).passthrough(),
  })
  .passthrough();

export type Notification = { action: string; type: string; orderId: string; version: string; liveMode: boolean | null; userId: string | null };

/**
 * Corpo → notificação normalizada. Só os campos usados; o `data.status` do corpo é DESCARTADO de propósito (a decisão vem da
 * consulta ao provedor). `type`/`action` desconhecidos são tratados pelo chamador como "ignorar" (resposta 200).
 */
export function parseNotification(body: unknown, queryDataId: string | null, queryType: string | null): Notification | null {
  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) return null;
  const n = parsed.data;
  // O `data.id` assinado vem da query; se o corpo traz outro, a notificação é incoerente.
  if (queryDataId && queryDataId.toLowerCase() !== n.data.id.toLowerCase()) return null;
  return {
    action: n.action ?? "",
    type: n.type ?? queryType ?? "",
    orderId: n.data.id,
    version: n.data.version === undefined ? "" : String(n.data.version),
    liveMode: n.live_mode ?? null,
    userId: n.user_id === undefined ? null : String(n.user_id),
  };
}
