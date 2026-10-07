// Adapter do Mercado Pago (F18) — testes de CONTRATO com HTTP SIMULADO (respostas no formato da documentação oficial da API
// Orders). NÃO falam com o Mercado Pago e NÃO são evidência de sandbox: o teste real está em tests/sandbox/ (opcional, só com
// credenciais de teste). Provam: corpo e cabeçalhos enviados (idempotência = ID local, valor em string exata, 1 parcela,
// crédito, pagador de teste só no sandbox), mapeamento de estados/erros (402 recusado, 409/423/429/5xx/rede = incerto,
// 4xx = recusa definitiva), conciliação por busca com janela de datas, configuração por ambiente e o componente de cartão.
import { describe, expect, it } from "vitest";
import { onlinePaymentConfig, onlineProviders } from "@/modules/payments/online/config";
import { mapOrder, mercadoPagoCard, mercadoPagoPix, toAmount, type MercadoPagoConfig } from "@/modules/payments/online/mercadopago";
import { ProviderError, type ChargeRequest } from "@/modules/payments/online/provider";
import { toSubmission } from "@/modules/payments/components/mercadopago-card-brick";

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
const credential = (label: string) => ["APP", "USR", label, "0".repeat(24)].join("-");

function fakeHttp(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const next = responses.shift();
    if (!next) throw new Error("sem resposta roteirizada");
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const cfg = (fetchFn: typeof fetch, env: "sandbox" | "production" = "sandbox"): MercadoPagoConfig => ({ accessToken: credential("token"), publicKey: credential("public"), env, fetch: fetchFn });
/** ID fictício da intenção (= chave de idempotência = referência externa). */
const INTENT = "tpi_0123456789abcdef0123";
const req = (over: Partial<ChargeRequest> = {}): ChargeRequest => ({
  intentId: INTENT,
  idempotencyKey: INTENT,
  externalReference: INTENT,
  amountCents: 5005,
  currency: "BRL",
  description: "Recarga",
  payer: { name: "Maria Responsável", email: "maria@example.test" },
  ...over,
});
const expiresAt = new Date(Date.now() + 30 * 60_000);
const pixOrder = { id: "ORD01PIX", status: "action_required", status_detail: "waiting_transfer", external_reference: "tpi_0123456789abcdef0123", transactions: { payments: [{ id: "PAY01", status: "action_required", date_of_expiration: "2026-10-06T13:00:00.000-03:00", payment_method: { id: "pix", type: "bank_transfer", qr_code: "00020126580014br.gov.bcb.pix0136teste", qr_code_base64: "iVBORw0KGgo=", ticket_url: "https://example.test/t" } }] } };
const cardOrder = (status: string, detail = "accredited") => ({ id: "ORD01CARD", status, status_detail: detail, transactions: { payments: [{ id: "PAY02", status, status_detail: detail }] } });

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("deveria ter falhado");
}

describe("valores", () => {
  it("centavos inteiros viram string exata, sem ponto flutuante", () => {
    expect([toAmount(5000), toAmount(5005), toAmount(100), toAmount(199_999), toAmount(1)]).toEqual(["50.00", "50.05", "1.00", "1999.99", "0.01"]);
  });
});

describe("Pix (POST /v1/orders)", () => {
  it("envia idempotência = ID local, referência, valor exato, Pix com validade ISO 8601 e o pagador de TESTE no sandbox", async () => {
    const http = fakeHttp([{ status: 201, body: pixOrder }]);
    const charge = await mercadoPagoPix(cfg(http.fetchFn)).createPixCharge({ ...req(), expiresAt });
    const call = http.calls[0]!;
    expect(call).toMatchObject({ url: "https://api.mercadopago.com/v1/orders", method: "POST" });
    expect(call.headers["x-idempotency-key"]).toBe("tpi_0123456789abcdef0123");
    expect(call.headers.authorization).toMatch(/^Bearer /);
    expect(call.body).toMatchObject({
      type: "online",
      processing_mode: "automatic",
      total_amount: "50.05",
      external_reference: "tpi_0123456789abcdef0123",
      payer: { email: "test_user_br@testuser.com", first_name: "APRO" },
      transactions: { payments: [{ amount: "50.05", payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: "PT30M" }] },
    });
    expect(charge).toEqual({
      chargeId: "ORD01PIX",
      providerStatus: "action_required/waiting_transfer",
      outcome: "awaiting_payment",
      pix: { copyPaste: pixOrder.transactions.payments[0]!.payment_method.qr_code, qrImagePngBase64: "iVBORw0KGgo=", expiresAt: "2026-10-06T13:00:00.000-03:00" },
    });
  });

  it("em produção usa o e-mail e o primeiro nome do responsável", async () => {
    const http = fakeHttp([{ status: 201, body: pixOrder }]);
    await mercadoPagoPix(cfg(http.fetchFn, "production")).createPixCharge({ ...req(), expiresAt });
    expect(http.calls[0]!.body!.payer).toEqual({ email: "maria@example.test", first_name: "Maria" });
  });

  it("erros: 409/423/429/5xx/rede/corpo ilegível = INCERTO; 400/401/403 = recusa definitiva com código curto", async () => {
    const cases: Array<[{ status: number; body?: unknown } | Error, "uncertain" | "rejected", string]> = [
      [{ status: 409, body: { errors: [{ code: "idempotency_key_already_used" }] } }, "uncertain", "idempotency_key_already_used"],
      [{ status: 423, body: { errors: [{ code: "resource_locked" }] } }, "uncertain", "resource_locked"],
      [{ status: 429 }, "uncertain", "http_429"],
      [{ status: 500, body: { errors: [{ code: "internal_error" }] } }, "uncertain", "internal_error"],
      [new Error("ECONNRESET"), "uncertain", "network_or_timeout"],
      [{ status: 201, body: { nada: true } }, "uncertain", "unreadable_order"],
      [{ status: 201, body: { ...pixOrder, transactions: { payments: [{ payment_method: {} }] } } }, "uncertain", "pix_without_qr"],
      [{ status: 400, body: { errors: [{ code: "invalid_email_for_sandbox" }] } }, "rejected", "invalid_email_for_sandbox"],
      [{ status: 401 }, "rejected", "http_401"],
      [{ status: 403, body: { errors: [{ code: "PA_UNAUTHORIZED_RESULT_FROM_POLICIES" }] } }, "rejected", "pa_unauthorized_result_from_policies"],
    ];
    for (const [response, kind, code] of cases) {
      const http = fakeHttp([response]);
      const error = await failure(mercadoPagoPix(cfg(http.fetchFn)).createPixCharge({ ...req(), expiresAt }));
      expect([error.kind, error.code], JSON.stringify(response)).toEqual([kind, code]);
      expect(error.message).not.toContain("APP-USR"); // credencial nunca em mensagem
    }
  });

  it("conciliação: busca com janela de datas e referência; achou → detalhe da order; nada → null; falha da busca = incerto", async () => {
    const http = fakeHttp([{ status: 200, body: { data: [{ id: "ORD01PIX", external_reference: "tpi_0123456789abcdef0123" }], paging: { total: "1" } } }, { status: 200, body: pixOrder }]);
    const createdAt = new Date("2026-10-06T12:00:00Z");
    const found = await mercadoPagoPix(cfg(http.fetchFn)).findCharge("tpi_0123456789abcdef0123", createdAt);
    const search = new URL(http.calls[0]!.url);
    expect(search.pathname).toBe("/v1/orders");
    expect(search.searchParams.get("external_reference")).toBe("tpi_0123456789abcdef0123");
    expect(Date.parse(search.searchParams.get("begin_date")!)).toBe(createdAt.getTime() - 10 * 60_000);
    expect(Date.parse(search.searchParams.get("end_date")!)).toBeGreaterThan(Date.now());
    expect(http.calls[1]!.url).toBe("https://api.mercadopago.com/v1/orders/ORD01PIX");
    expect(found).toMatchObject({ chargeId: "ORD01PIX", outcome: "awaiting_payment" });

    const empty = fakeHttp([{ status: 200, body: { data: [{ id: "OUTRA", external_reference: "tpi_outra" }] } }]);
    expect(await mercadoPagoPix(cfg(empty.fetchFn)).findCharge("tpi_0123456789abcdef0123", createdAt)).toBeNull();
    expect(empty.calls).toHaveLength(1);
    const broken = fakeHttp([{ status: 500 }]);
    expect((await failure(mercadoPagoPix(cfg(broken.fetchFn)).findCharge("tpi_0123456789abcdef0123", createdAt))).kind).toBe("uncertain");
  });

  it("estados da order: pago no provedor = em análise (não é crédito); expirado/cancelado = recusado; desconhecido = incerto", () => {
    expect(mapOrder("pix", cardOrder("processed"), expiresAt).outcome).toBe("processing");
    expect(mapOrder("pix", cardOrder("expired", "expired"), expiresAt)).toMatchObject({ outcome: "declined", declineCode: "pix_expired" });
    expect(mapOrder("pix", cardOrder("canceled", "canceled"), expiresAt)).toMatchObject({ outcome: "declined", declineCode: "provider_rejected" });
    expect(() => mapOrder("pix", cardOrder("estranho"), expiresAt)).toThrow(ProviderError);
  });
});

describe("cartão 1x (POST /v1/orders com token do Brick)", () => {
  const cardReq = (over: Record<string, unknown> = {}) => ({
    ...req({ payer: { name: "Maria Responsável", email: "maria@example.test", identification: { type: "CPF", number: "12345678909" } } }),
    cardToken: ["tok", "brick", "0001"].join("_"),
    paymentMethodId: "master",
    installments: 1 as const,
    ...over,
  });

  it("envia só token, bandeira, crédito e 1 parcela; sandbox usa o e-mail de teste documentado", async () => {
    const http = fakeHttp([{ status: 201, body: cardOrder("processed") }]);
    const charge = await mercadoPagoCard(cfg(http.fetchFn)).createCardCharge(cardReq());
    expect(http.calls[0]!.body).toMatchObject({
      total_amount: "50.05",
      payer: { email: "test@testuser.com", first_name: "Maria", identification: { type: "CPF", number: "12345678909" } },
      transactions: { payments: [{ amount: "50.05", payment_method: { id: "master", type: "credit_card", token: "tok_brick_0001", installments: 1 } }] },
    });
    expect(JSON.stringify(http.calls[0]!.body)).not.toMatch(/card_number|security_code|cvv/i);
    expect(charge).toMatchObject({ chargeId: "ORD01CARD", outcome: "processing", pix: null }); // aprovado ≠ recebido confirmado
  });

  it("402 (order criada, pagamento recusado) e 'failed' = recusado; desafio 3DS = recusado (não suportado); pendente = em análise", async () => {
    // Formato observado no sandbox (06/10/2026): 402 = { errors, data: order }.
    const declined = fakeHttp([{ status: 402, body: { errors: [{ code: "failed", details: ["PAY01: rejected_by_issuer"] }], data: cardOrder("failed", "failed") } }]);
    expect(await mercadoPagoCard(cfg(declined.fetchFn)).createCardCharge(cardReq())).toMatchObject({ outcome: "declined", declineCode: "card_declined" });
    const bare = fakeHttp([{ status: 402, body: cardOrder("failed", "cc_rejected_other_reason") }]);
    expect(await mercadoPagoCard(cfg(bare.fetchFn)).createCardCharge(cardReq())).toMatchObject({ outcome: "declined" });
    expect(mapOrder("card", cardOrder("action_required", "pending_challenge"), expiresAt)).toMatchObject({ outcome: "declined", declineCode: "card_challenge_unsupported" });
    expect(mapOrder("card", cardOrder("processing", "in_process"), expiresAt).outcome).toBe("processing");
  });

  it("componente: só crédito com token, bandeira, e-mail e CPF/CNPJ; débito ou dados faltando são recusados antes de enviar", () => {
    const form = { token: "tok_x_123456", payment_method_id: "visa", payer: { email: "a@example.test", identification: { type: "CPF", number: "123.456.789-09" } } };
    expect(toSubmission(form, "credit_card")).toEqual({ cardToken: "tok_x_123456", paymentMethodId: "visa", payer: { email: "a@example.test", identification: { type: "CPF", number: "12345678909" } } });
    expect(toSubmission(form, "debit_card")).toBeNull();
    expect(toSubmission({ ...form, token: undefined }, "credit_card")).toBeNull();
    expect(toSubmission({ ...form, payer: { email: "a@example.test", identification: { type: "RG", number: "1" } } }, "credit_card")).toBeNull();
  });
});

describe("configuração do Mercado Pago por ambiente", () => {
  const base = { PAYMENTS_PIX_PROVIDER: "mercadopago", PAYMENTS_CARD_PROVIDER: "mercadopago", MERCADOPAGO_ACCESS_TOKEN: credential("token"), MERCADOPAGO_PUBLIC_KEY: credential("public") };

  it("homologação com sandbox: os dois canais disponíveis; a configuração pública do cartão não leva o access token", () => {
    const env = { ...base, APP_ENV: "staging", MERCADOPAGO_ENV: "sandbox" };
    expect(onlinePaymentConfig(env)).toMatchObject({ pix: { available: true, provider: "mercadopago", mode: "live" }, card: { available: true } });
    const providers = onlineProviders(env);
    expect(providers.card?.publicConfig).toEqual({ kind: "mercadopago", publicKey: base.MERCADOPAGO_PUBLIC_KEY, locale: "pt-BR" });
    expect(JSON.stringify(providers.card?.publicConfig)).not.toContain(base.MERCADOPAGO_ACCESS_TOKEN);
  });

  it("produção exige credencial de produção e homologação exige sandbox; credencial ausente = indisponível", () => {
    expect(onlinePaymentConfig({ ...base, APP_ENV: "production", MERCADOPAGO_ENV: "sandbox" }).pix).toMatchObject({ available: false, reason: "env_mismatch" });
    expect(onlinePaymentConfig({ ...base, APP_ENV: "staging", MERCADOPAGO_ENV: "production" }).pix).toMatchObject({ available: false, reason: "env_mismatch" });
    expect(onlinePaymentConfig({ ...base, APP_ENV: "production", MERCADOPAGO_ENV: "production" }).pix.available).toBe(true);
    expect(onlinePaymentConfig({ ...base, APP_ENV: "staging", MERCADOPAGO_ENV: "sandbox", MERCADOPAGO_ACCESS_TOKEN: "" }).pix).toMatchObject({ available: false, reason: "missing_credentials" });
    expect(onlinePaymentConfig({ ...base, APP_ENV: "staging", MERCADOPAGO_ENV: "sandbox", MERCADOPAGO_PUBLIC_KEY: undefined })).toMatchObject({ pix: { available: true }, card: { available: false, reason: "missing_credentials" } });
    expect(onlinePaymentConfig({ ...base, APP_ENV: "staging" }).pix).toMatchObject({ available: false, reason: "missing_credentials" });
  });
});

describe("consulta confirmatória e conta recebedora (F19)", () => {
  // Formato medido em GET /v1/orders/{id} no sandbox, 07/10/2026 (campos relevantes; sem dados do pagador).
  const sandboxOrder = {
    id: "ORDTST01M49WSD2C20Y1PGN55PTY7SW3",
    type: "online",
    external_reference: "tpi_c4b97e8d36fb5924869a",
    total_amount: "10.00",
    total_paid_amount: "10.00",
    user_id: "3745150346",
    status: "processed",
    status_detail: "accredited",
    currency: "BRL",
    last_updated_date: "2026-10-07T00:39:06.403Z",
    transactions: { payments: [{ id: "PAY01M49WSD2ZE69ZWHYDNJ7K4DS0", amount: "10.00", paid_amount: "10.00", status: "processed", status_detail: "accredited", payment_method: { id: "master", type: "credit_card", installments: 1 } }] },
  };

  it("GET /v1/orders/{id} com o token do servidor; order paga vira PAGA com conta, moeda e centavos exatos", async () => {
    const http = fakeHttp([{ status: 200, body: sandboxOrder }]);
    const order = await mercadoPagoPix(cfg(http.fetchFn)).getOrder("ORDTST01M49WSD2C20Y1PGN55PTY7SW3");
    expect(order).toMatchObject({ orderId: "ORDTST01M49WSD2C20Y1PGN55PTY7SW3", externalReference: "tpi_c4b97e8d36fb5924869a", accountId: "3745150346", currency: "BRL", totalCents: 1000, paidCents: 1000, state: "paid", paymentId: "PAY01M49WSD2ZE69ZWHYDNJ7K4DS0" });
    expect(http.calls[0]).toMatchObject({ method: "GET" });
    expect(http.calls[0]!.url).toMatch(/\/v1\/orders\/ORDTST01M49WSD2C20Y1PGN55PTY7SW3$/);
    expect(http.calls[0]!.headers.authorization).toMatch(/^Bearer /);
  });

  it("404 = o provedor não conhece a order; 5xx/429/rede/corpo ilegível = incerto (nunca crédito por palpite)", async () => {
    expect(await mercadoPagoCard(cfg(fakeHttp([{ status: 404, body: { errors: [{ code: "order_not_found" }] } }]).fetchFn)).getOrder("ORDX")).toBeNull();
    for (const response of [{ status: 500 }, { status: 429 }, { status: 401, body: { error: "unauthorized" } }, new Error("socket")] as const) {
      const error = await failure(mercadoPagoPix(cfg(fakeHttp([response as { status: number }]).fetchFn)).getOrder("ORDX"));
      expect(error.kind).toBe("uncertain");
    }
    const garbled = await failure(mercadoPagoPix(cfg(fakeHttp([{ status: 200, body: { id: "ORDX", total_amount: "abc" } }]).fetchFn)).getOrder("ORDX"));
    expect(garbled).toMatchObject({ kind: "uncertain", code: "unreadable_order" });
  });

  it("ID de order fora do formato nem chega à rede (sem injeção de caminho)", async () => {
    const http = fakeHttp([]);
    expect(await mercadoPagoPix(cfg(http.fetchFn)).getOrder("../users/me")).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it("conta recebedora vem de GET /users/me e fica em cache por credencial (uma chamada)", async () => {
    const http = fakeHttp([{ status: 200, body: { id: 3745150346, site_id: "MLB" } }]);
    const provider = mercadoPagoPix({ ...cfg(http.fetchFn), accessToken: credential("cache-test") });
    expect(await provider.accountId()).toBe("3745150346");
    expect(await provider.accountId()).toBe("3745150346");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toMatch(/\/users\/me$/);
    const failed = await failure(mercadoPagoPix({ ...cfg(fakeHttp([{ status: 401, body: { message: "invalid_token" } }]).fetchFn), accessToken: credential("sem-cache") }).accountId());
    expect(failed.kind).toBe("uncertain");
  });
});
