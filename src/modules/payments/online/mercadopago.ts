import { ProviderError, type CardProvider, type ChargeRequest, type PixData, type PixProvider, type ProviderCharge } from "./provider";

/**
 * Adapter do Mercado Pago — API Orders (Checkout Transparente), conforme a documentação oficial consultada em 06/10/2026
 * (links em docs/status/payment-provider-research.md, seção "Adapter"):
 * - criação `POST /v1/orders` com `X-Idempotency-Key` (1–128) = ID da intenção e `external_reference` = o mesmo ID;
 * - Pix: `payment_method {id: "pix", type: "bank_transfer"}`, `expiration_time` ISO 8601 (mín. 30 min); a resposta traz
 *   `qr_code` (copia e cola), `qr_code_base64` (imagem) e `date_of_expiration`; estado `action_required`/`waiting_transfer`;
 * - cartão: token do Card Payment Brick, `type: "credit_card"`, `installments: 1`;
 * - erros: 409 `idempotency_key_already_used` e 423 `resource_locked` (a order PODE existir), 429/5xx/rede/timeout =
 *   INCERTO (só a conciliação decide); 400/401/403/404/422 = recusa definitiva (nada criado); 402 = order criada com o
 *   pagamento recusado;
 * - conciliação: `GET /v1/orders?begin_date&end_date&external_reference` (datas obrigatórias) + `GET /v1/orders/{id}`.
 * Sandbox: o pagador precisa de e-mail `@testuser.com` (Pix: `test_user_br@testuser.com` com nome `APRO`; cartão:
 * `test@testuser.com`), por isso o pagador é substituído SÓ quando `env = "sandbox"`.
 * Nada aqui confirma pagamento nem credita: "processed" de cartão vira "em análise" até a confirmação da F19.
 * O access token nunca é registrado em log nem devolvido; erros só levam códigos curtos.
 */

export type MercadoPagoConfig = {
  accessToken: string;
  publicKey: string;
  env: "sandbox" | "production";
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

const SANDBOX_PIX_PAYER = { email: "test_user_br@testuser.com", first_name: "APRO" };
const SANDBOX_CARD_EMAIL = "test@testuser.com";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Janela em que o reenvio explícito com a MESMA chave é aceito pelo nosso lado (o provedor responde 409 a chave repetida). */
const IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000;

type Json = Record<string, unknown>;

/** Centavos inteiros → "50.00" sem ponto flutuante. */
export function toAmount(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

const code = (value: unknown, fallback: string) => {
  const s = typeof value === "string" ? value.toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 40) : "";
  return /^[a-z_]{1,40}$/.test(s) ? s : fallback;
};
const errorCode = (body: Json | null, status: number) => {
  const errors = body?.errors as Json[] | undefined;
  return code(errors?.[0]?.code ?? body?.error ?? body?.code, `http_${status}`);
};
const firstName = (name: string) => name.trim().split(/\s+/)[0]?.slice(0, 60) || "Responsável";

async function request(cfg: MercadoPagoConfig, method: "GET" | "POST", path: string, body?: Json, idempotencyKey?: string): Promise<{ status: number; body: Json | null }> {
  const doFetch = cfg.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${cfg.baseUrl ?? "https://api.mercadopago.com"}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.accessToken}`,
        "content-type": "application/json",
        ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("uncertain", "network_or_timeout");
  }
  const parsed = (await response.json().catch(() => null)) as Json | null;
  return { status: response.status, body: parsed && typeof parsed === "object" ? parsed : null };
}

/** Status final/negativo da order (nada a pagar). */
const NEGATIVE = new Set(["failed", "rejected", "canceled", "cancelled", "expired"]);

/** Order → desfecho da fronteira. Estado desconhecido ou order ilegível = incerto. */
export function mapOrder(channel: "pix" | "card", order: Json | null, fallbackExpiresAt: Date): ProviderCharge {
  const id = typeof order?.id === "string" ? order.id : "";
  if (!id) throw new ProviderError("uncertain", "unreadable_order");
  const status = String(order?.status ?? "");
  const detail = String(order?.status_detail ?? "");
  const providerStatus = `${status}/${detail}`.slice(0, 64);
  const payment = ((order?.transactions as Json | undefined)?.payments as Json[] | undefined)?.[0];
  const method = payment?.payment_method as Json | undefined;

  if (NEGATIVE.has(status)) {
    const declineCode = channel === "card" ? "card_declined" : status === "expired" ? "pix_expired" : "provider_rejected";
    return { chargeId: id, providerStatus, outcome: "declined", pix: null, declineCode };
  }
  if (channel === "pix") {
    if (status === "action_required") {
      if (typeof method?.qr_code !== "string") throw new ProviderError("uncertain", "pix_without_qr");
      const expires = typeof payment?.date_of_expiration === "string" ? payment.date_of_expiration : fallbackExpiresAt.toISOString();
      const pix: PixData = { copyPaste: method.qr_code, qrImagePngBase64: typeof method.qr_code_base64 === "string" ? method.qr_code_base64 : null, expiresAt: expires };
      return { chargeId: id, providerStatus, outcome: "awaiting_payment", pix };
    }
    if (status === "processed" || status === "processing") return { chargeId: id, providerStatus, outcome: "processing", pix: null };
    throw new ProviderError("uncertain", "unknown_status");
  }
  // Cartão: desafio adicional (3DS) não é suportado nesta integração → recusado sem cobrança concluída.
  if (status === "action_required") return { chargeId: id, providerStatus, outcome: "declined", pix: null, declineCode: "card_challenge_unsupported" };
  if (["processed", "processing", "pending", "in_review"].includes(status)) return { chargeId: id, providerStatus, outcome: "processing", pix: null };
  throw new ProviderError("uncertain", "unknown_status");
}

/** Resposta da criação: 2xx/402 trazem a order; 409/423/429/5xx = incerto; demais 4xx = recusa definitiva. */
function creationResult(channel: "pix" | "card", r: { status: number; body: Json | null }, fallbackExpiresAt: Date): ProviderCharge {
  if (r.status === 200 || r.status === 201 || r.status === 402) return mapOrder(channel, r.body, fallbackExpiresAt);
  if (r.status === 409 || r.status === 423 || r.status === 429 || r.status >= 500) throw new ProviderError("uncertain", errorCode(r.body, r.status));
  if (r.status >= 400) throw new ProviderError("rejected", errorCode(r.body, r.status));
  throw new ProviderError("uncertain", `http_${r.status}`);
}

function base(request: ChargeRequest) {
  const amount = toAmount(request.amountCents);
  return { type: "online", processing_mode: "automatic", total_amount: amount, external_reference: request.externalReference, amount };
}

async function findOrder(cfg: MercadoPagoConfig, channel: "pix" | "card", reference: string, createdAt: Date): Promise<ProviderCharge | null> {
  const begin = new Date(createdAt.getTime() - 10 * 60_000).toISOString();
  const end = new Date(Date.now() + 60_000).toISOString();
  const query = new URLSearchParams({ begin_date: begin, end_date: end, external_reference: reference, type: "online", page: "1", page_size: "5" });
  const search = await request(cfg, "GET", `/v1/orders?${query.toString()}`);
  if (search.status !== 200) throw new ProviderError("uncertain", errorCode(search.body, search.status));
  const match = ((search.body?.data as Json[] | undefined) ?? []).find((o) => o.external_reference === reference && typeof o.id === "string");
  if (!match) return null;
  const detail = await request(cfg, "GET", `/v1/orders/${encodeURIComponent(String(match.id))}`);
  if (detail.status !== 200) throw new ProviderError("uncertain", errorCode(detail.body, detail.status));
  return mapOrder(channel, detail.body, new Date(createdAt.getTime() + 30 * 60_000));
}

export function mercadoPagoPix(cfg: MercadoPagoConfig): PixProvider {
  return {
    id: "mercadopago",
    mode: "live",
    idempotencyWindowMs: IDEMPOTENCY_WINDOW_MS,
    async createPixCharge(req) {
      const { amount, ...order } = base(req);
      const minutes = Math.max(30, Math.round((req.expiresAt.getTime() - Date.now()) / 60_000));
      const payer = cfg.env === "sandbox" ? SANDBOX_PIX_PAYER : { email: req.payer.email, first_name: firstName(req.payer.name) };
      const body = { ...order, payer, transactions: { payments: [{ amount, payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: `PT${minutes}M` }] } };
      return creationResult("pix", await request(cfg, "POST", "/v1/orders", body, req.idempotencyKey), req.expiresAt);
    },
    findCharge: (reference, createdAt) => findOrder(cfg, "pix", reference, createdAt),
  };
}

export function mercadoPagoCard(cfg: MercadoPagoConfig): CardProvider {
  return {
    id: "mercadopago",
    mode: "live",
    publicConfig: { kind: "mercadopago", publicKey: cfg.publicKey, locale: "pt-BR" },
    async createCardCharge(req) {
      const { amount, ...order } = base(req);
      const payer = {
        email: cfg.env === "sandbox" ? SANDBOX_CARD_EMAIL : req.payer.email,
        first_name: firstName(req.payer.name),
        ...(req.payer.identification ? { identification: req.payer.identification } : {}),
      };
      const body = { ...order, payer, transactions: { payments: [{ amount, payment_method: { id: req.paymentMethodId, type: "credit_card", token: req.cardToken, installments: 1 } }] } };
      return creationResult("card", await request(cfg, "POST", "/v1/orders", body, req.idempotencyKey), new Date());
    },
    findCharge: (reference, createdAt) => findOrder(cfg, "card", reference, createdAt),
  };
}
