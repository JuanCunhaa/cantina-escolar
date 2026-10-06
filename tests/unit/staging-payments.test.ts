// Harness de homologação (F18): recarga online só com o SANDBOX do Mercado Pago; nomes faltantes no erro, nunca valores.
import { describe, expect, it } from "vitest";
import { stagingPayments } from "../../scripts/staging/target.ts";

const token = ["TEST", "0".repeat(30)].join("-");

describe("stagingPayments", () => {
  it("sem provedor no arquivo: canais em branco (indisponíveis)", () => {
    expect(stagingPayments({})).toEqual({ PAYMENTS_PIX_PROVIDER: "", PAYMENTS_CARD_PROVIDER: "" });
  });

  it("mercadopago exige MERCADOPAGO_ENV=sandbox e lista só os NOMES faltantes", () => {
    expect(() => stagingPayments({ PAYMENTS_PIX_PROVIDER: "mercadopago", MERCADOPAGO_ENV: "production", MERCADOPAGO_ACCESS_TOKEN: token })).toThrow(/sandbox/);
    expect(() => stagingPayments({ PAYMENTS_CARD_PROVIDER: "mercadopago", MERCADOPAGO_ENV: "sandbox", MERCADOPAGO_ACCESS_TOKEN: token })).toThrow(/MERCADOPAGO_PUBLIC_KEY/);
    expect(() => stagingPayments({ PAYMENTS_PIX_PROVIDER: "mercadopago", MERCADOPAGO_ENV: "sandbox", MERCADOPAGO_ACCESS_TOKEN: "" })).toThrow(/MERCADOPAGO_ACCESS_TOKEN/);
    expect(() => stagingPayments({ PAYMENTS_PIX_PROVIDER: "mercadopago", MERCADOPAGO_ENV: "sandbox", MERCADOPAGO_ACCESS_TOKEN: token })).not.toThrow();
  });

  it("recusa demo e provedor desconhecido na homologação; repassa as credenciais de teste quando completas", () => {
    expect(() => stagingPayments({ PAYMENTS_PIX_PROVIDER: "demo" })).toThrow(/mercadopago/);
    const env = stagingPayments({ PAYMENTS_PIX_PROVIDER: "mercadopago", PAYMENTS_CARD_PROVIDER: "mercadopago", MERCADOPAGO_ENV: "sandbox", MERCADOPAGO_ACCESS_TOKEN: token, MERCADOPAGO_PUBLIC_KEY: token });
    expect(env).toMatchObject({ PAYMENTS_PIX_PROVIDER: "mercadopago", PAYMENTS_CARD_PROVIDER: "mercadopago", MERCADOPAGO_ENV: "sandbox", MERCADOPAGO_ACCESS_TOKEN: token });
  });
});
