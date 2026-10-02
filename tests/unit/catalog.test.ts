import { describe, expect, it } from "vitest";
import { evaluateSellable, parseBRLInput, parseProduct, productCommandSchema, type PublicProduct } from "@/modules/catalog/model";

const base = {
  action: "create",
  key: "chave-teste-0001",
  name: "Suco",
  description: "",
  categoryId: "cat_1",
  channels: ["counter", "advance", "advance"],
  shiftIds: ["shf_b", "shf_a", "shf_a"],
  availabilityMode: "physical",
  priceCents: 800,
};

describe("comando de produto — validação (A16: preço em centavos inteiros)", () => {
  it("normaliza canais/turnos em conjuntos ordenados e preenche dados internos vazios", () => {
    const parsed = productCommandSchema.parse(base);
    expect(parsed).toMatchObject({ channels: ["advance", "counter"], shiftIds: ["shf_a", "shf_b"], defaultSupplier: "", internalNotes: "" });
  });

  it("recusa preço fracionário, string, zero, negativo e acima do teto", () => {
    for (const priceCents of [8.5, "800", 0, -100, 50_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(productCommandSchema.safeParse({ ...base, priceCents }).success).toBe(false);
    }
    expect(productCommandSchema.safeParse({ ...base, priceCents: 1 }).success).toBe(true);
    expect(productCommandSchema.safeParse({ ...base, priceCents: 50_000 }).success).toBe(true);
  });

  it("recusa canal/modo desconhecido, listas vazias, nome com fórmula e texto com caractere de controle", () => {
    expect(productCommandSchema.safeParse({ ...base, channels: [] }).success).toBe(false);
    expect(productCommandSchema.safeParse({ ...base, channels: ["delivery"] }).success).toBe(false);
    expect(productCommandSchema.safeParse({ ...base, shiftIds: [] }).success).toBe(false);
    expect(productCommandSchema.safeParse({ ...base, shiftIds: ["../x"] }).success).toBe(false);
    expect(productCommandSchema.safeParse({ ...base, availabilityMode: "recipe" }).success).toBe(false);
    expect(productCommandSchema.safeParse({ ...base, name: "=HYPERLINK(1)" }).success).toBe(false);
    expect(productCommandSchema.safeParse({ ...base, description: "a\u0000b" }).success).toBe(false);
    expect(productCommandSchema.safeParse({ ...base, description: "linha 1\nlinha 2" }).success).toBe(true);
  });

  it("edição não aceita preço (preço muda só pelo comando com motivo e histórico)", () => {
    const update = productCommandSchema.parse({ ...base, action: "update", id: "prd_1", expectedVersion: 1 });
    expect("priceCents" in update).toBe(false);
    expect(productCommandSchema.safeParse({ action: "setPrice", key: base.key, id: "prd_1", expectedPriceVersion: 1, priceCents: 900, reason: "" }).success).toBe(false);
  });
});

describe("parseBRLInput — digitação em reais para centavos, sem ponto flutuante", () => {
  it.each([
    ["8", 800],
    ["8,5", 850],
    ["8,50", 850],
    ["8.05", 805],
    ["R$ 12,34", 1234],
    ["0,01", 1],
    ["500,00", 50_000],
    ["0,1", 10],
  ])("%s → %i", (input, cents) => expect(parseBRLInput(input)).toBe(cents));

  it.each(["", "abc", "8,505", "-1", "0", "500,01", "1.000,00", "8,"])("%s é recusado", (input) => expect(parseBRLInput(input)).toBeNull());
});

describe("evaluateSellable — decisão canônica de canal/turno/situação para F11/F15", () => {
  const product: PublicProduct = {
    id: "prd_1",
    name: "Suco",
    description: "",
    categoryId: "cat_1",
    priceCents: 800,
    priceVersion: 2,
    channels: ["advance"],
    shiftIds: ["shf_m"],
    availabilityMode: "physical",
    status: "active",
    version: 3,
    photoPath: null,
  };
  const ctx = { channel: "advance" as const, shiftId: "shf_m" };

  it("produto ativo, no canal e turno: vendável com o preço do servidor", () => {
    expect(evaluateSellable(product, ctx)).toEqual({ ok: true, product });
  });

  it("nega inexistente, desativado, outro canal, outro turno e preço inválido", () => {
    expect(evaluateSellable(null, ctx)).toEqual({ ok: false, reason: "product_not_found" });
    expect(evaluateSellable({ ...product, status: "inactive" }, ctx)).toEqual({ ok: false, reason: "product_inactive" });
    expect(evaluateSellable(product, { ...ctx, channel: "counter" })).toEqual({ ok: false, reason: "channel_not_allowed" });
    expect(evaluateSellable(product, { ...ctx, shiftId: "shf_t" })).toEqual({ ok: false, reason: "shift_not_allowed" });
    expect(evaluateSellable({ ...product, priceCents: 0 }, ctx)).toEqual({ ok: false, reason: "invalid_price" });
    expect(evaluateSellable({ ...product, priceVersion: 0 }, ctx)).toEqual({ ok: false, reason: "invalid_price" });
  });

  it("parseProduct é defensivo: documento malformado nunca vira produto ativo vendável", () => {
    expect(parseProduct("x", undefined)).toBeNull();
    const odd = parseProduct("x", { name: "X", priceCents: 1.5, status: "ACTIVE", channels: ["advance", "outro"], shiftIds: [1, "shf_m"] })!;
    expect(odd).toMatchObject({ priceCents: 0, status: "inactive", channels: ["advance"], shiftIds: ["shf_m"] });
    expect(evaluateSellable(odd, ctx).ok).toBe(false);
  });
});
