// Recarga online (F18), regras puras: entrada (centavos, cartão SÓ 1x e só token — número/CVV recusados), configuração por
// canal (sem provedor = indisponível; demonstração só no emulador), validade derivada do Pix e decisão da conciliação
// depois de timeout (consulta antes de qualquer reenvio; reenvio só explícito, Pix, mesma chave, dentro da janela).
import { describe, expect, it } from "vitest";
import { onlinePaymentConfig, onlineProviders } from "@/modules/payments/online/config";
import {
  checkCharge,
  createIntentSchema,
  decideReconcile,
  displayStatusOf,
  GIVE_UP_UNCERTAIN_MS,
  idempotentPayload,
  isOpen,
  needsReconcile,
  STALE_CREATING_MS,
} from "@/modules/payments/online/intent-model";

const base = { key: "k".repeat(12), studentId: "stu_a", amountCents: 5000 };
const now = new Date("2026-10-06T12:00:00Z");
/** Token fictício do componente do provedor (montado em tempo de execução: não é segredo). */
const tok = (suffix: string) => ["tok", suffix].join("_");
/** Dados do componente do provedor além do token (bandeira e pagador fictícios). */
const brick = { paymentMethodId: "visa", payer: { email: "familia@example.test", identification: { type: "CPF", number: "12345678909" } } };

describe("entrada da intenção", () => {
  it("aceita Pix e cartão 1x com token; valores em centavos inteiros dentro dos limites", () => {
    expect(createIntentSchema.parse({ ...base, channel: "pix" })).toMatchObject({ channel: "pix", amountCents: 5000 });
    expect(createIntentSchema.parse({ ...base, channel: "card", installments: 1, ...brick, cardToken: tok("abcdef123") })).toMatchObject({ installments: 1 });
    for (const amountCents of [50.5, 0, 99, 200_001, -100]) expect(createIntentSchema.safeParse({ ...base, amountCents, channel: "pix" }).success).toBe(false);
  });

  it("recusa parcelamento, cartão sem token e QUALQUER dado de cartão em claro (número, CVV, validade)", () => {
    const card = { ...base, channel: "card", installments: 1, ...brick, cardToken: tok("abcdef123") };
    expect(createIntentSchema.safeParse({ ...card, installments: 2 }).success).toBe(false);
    expect(createIntentSchema.safeParse({ ...card, cardToken: undefined }).success).toBe(false);
    for (const extra of [{ cardNumber: "4111111111111111" }, { cvv: "123" }, { expirationMonth: 12 }, { pan: "4111" }]) {
      expect(createIntentSchema.safeParse({ ...card, ...extra }).success).toBe(false);
    }
    expect(createIntentSchema.safeParse({ ...base, channel: "pix", cardToken: tok("abcdef123") }).success).toBe(false);
  });

  it("documento do pagador: CPF com 11 dígitos, CNPJ com 14; outro tamanho ou tipo é recusado", () => {
    const card = { ...base, channel: "card", installments: 1, ...brick, cardToken: tok("abcdef123") };
    const doc = (type: string, number: string) => ({ ...card, payer: { email: "familia@example.test", identification: { type, number } } });
    expect(createIntentSchema.safeParse(doc("CNPJ", "12345678000195")).success).toBe(true);
    for (const [type, number] of [["CPF", "123456789012"], ["CNPJ", "12345678909"], ["CPF", "1234567890"], ["RG", "12345678909"]]) {
      expect(createIntentSchema.safeParse(doc(type!, number!)).success).toBe(false);
    }
  });

  it("a idempotência ignora o token (de uso único): repetir com token novo é a MESMA operação", () => {
    const a = createIntentSchema.parse({ ...base, channel: "card", installments: 1, ...brick, cardToken: tok("first_0001") });
    const b = createIntentSchema.parse({ ...base, channel: "card", installments: 1, ...brick, cardToken: tok("second_002") });
    expect(idempotentPayload(a)).toEqual(idempotentPayload(b));
    expect(JSON.stringify(idempotentPayload(a))).not.toContain("tok_");
  });
});

describe("configuração por canal", () => {
  it("sem provedor (ausente, vazio, none) o canal fica indisponível", () => {
    for (const value of [undefined, "", "none"]) {
      const c = onlinePaymentConfig({ APP_ENV: "production", PAYMENTS_PIX_PROVIDER: value, PAYMENTS_CARD_PROVIDER: value });
      expect(c.pix).toMatchObject({ available: false, reason: "not_configured" });
      expect(c.card.available).toBe(false);
    }
  });

  it("demonstração só no emulador; em homologação/produção é recusada (nunca há 'simular pagamento' fora do emulador)", () => {
    expect(onlinePaymentConfig({ APP_ENV: "emulator", PAYMENTS_PIX_PROVIDER: "demo" }).pix).toMatchObject({ available: true, mode: "demo" });
    for (const APP_ENV of ["staging", "production", undefined]) {
      expect(onlinePaymentConfig({ APP_ENV, PAYMENTS_PIX_PROVIDER: "demo", PAYMENTS_CARD_PROVIDER: "demo" }).pix).toMatchObject({ available: false, reason: "demo_outside_emulator" });
      expect(onlineProviders({ APP_ENV, PAYMENTS_PIX_PROVIDER: "demo", PAYMENTS_CARD_PROVIDER: "demo" })).toEqual({ pix: null, card: null });
    }
  });

  it("provedor desconhecido = indisponível; Mercado Pago sem credenciais = indisponível (nunca integração inventada)", () => {
    expect(onlinePaymentConfig({ APP_ENV: "production", PAYMENTS_PIX_PROVIDER: "outro_gateway" }).pix).toMatchObject({ available: false, reason: "unknown_provider" });
    expect(onlinePaymentConfig({ APP_ENV: "production", PAYMENTS_PIX_PROVIDER: "mercadopago" }).pix).toMatchObject({ available: false, reason: "missing_credentials" });
    expect(onlineProviders({ APP_ENV: "production", PAYMENTS_PIX_PROVIDER: "mercadopago" }).pix).toBeNull();
  });
});

describe("estados, validade e conciliação", () => {
  const pix = { copyPaste: "0002012636br.gov.bcb.pix", qrImagePngBase64: "iVBORw0KGgo=", expiresAt: "2026-10-06T12:30:00Z" };

  it("Pix vencido aparece expirado (derivado, sem apagar) e deixa de contar como aberto", () => {
    expect(displayStatusOf("awaiting_payment", pix, now)).toBe("awaiting_payment");
    expect(displayStatusOf("awaiting_payment", pix, new Date("2026-10-06T12:30:00Z"))).toBe("expired");
    expect(isOpen("awaiting_payment", pix, new Date("2026-10-06T12:31:00Z"))).toBe(false);
    expect(isOpen("creation_uncertain", null, now)).toBe(true);
    expect(isOpen("processing", null, now)).toBe(false);
  });

  it("precisa de conciliação: incerta sempre; `creating` só quando parada além do limite", () => {
    expect(needsReconcile("creation_uncertain", now.getTime(), now)).toBe(true);
    expect(needsReconcile("creating", now.getTime() - STALE_CREATING_MS + 1, now)).toBe(false);
    expect(needsReconcile("creating", now.getTime() - STALE_CREATING_MS, now)).toBe(true);
    expect(needsReconcile("awaiting_payment", 0, now)).toBe(false);
  });

  it("decisão: encontrada → aplica; reenvio só explícito, Pix e dentro da janela; nunca reenvio automático; limite encerra", () => {
    const d = (over: Partial<Parameters<typeof decideReconcile>[0]>) =>
      decideReconcile({ found: false, channel: "pix", resend: false, createdAtMs: now.getTime() - 60_000, now, idempotencyWindowMs: 3_600_000, ...over });
    expect(d({ found: true, resend: true })).toBe("apply_found");
    expect(d({})).toBe("keep_uncertain");
    expect(d({ resend: true })).toBe("resend");
    expect(d({ resend: true, channel: "card" })).toBe("keep_uncertain");
    expect(d({ resend: true, idempotencyWindowMs: 30_000 })).toBe("keep_uncertain");
    expect(d({ createdAtMs: now.getTime() - GIVE_UP_UNCERTAIN_MS })).toBe("give_up");
  });

  it("resposta incoerente do provedor é rejeitada pela checagem (vira incerta, nunca sucesso)", () => {
    const ok = { chargeId: "ch_1", providerStatus: "pending", outcome: "awaiting_payment" as const, pix };
    expect(checkCharge("pix", ok)).toBeNull();
    expect(checkCharge("pix", { ...ok, pix: null })).toBe("invalid_pix_payload");
    expect(checkCharge("pix", { ...ok, pix: { ...pix, expiresAt: "amanhã" } })).toBe("invalid_pix_expiry");
    expect(checkCharge("pix", { ...ok, pix: { ...pix, qrImagePngBase64: "<svg>" } })).toBe("invalid_pix_image");
    expect(checkCharge("pix", { ...ok, chargeId: "../x" })).toBe("invalid_charge_id");
    expect(checkCharge("card", ok)).toBe("unexpected_outcome");
    expect(checkCharge("card", { ...ok, outcome: "processing", pix: null })).toBeNull();
  });
});
