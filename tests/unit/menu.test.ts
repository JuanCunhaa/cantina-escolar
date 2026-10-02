import { describe, expect, it } from "vitest";
import type { PublicProduct } from "@/modules/catalog/model";
import {
  evaluateMenuSale,
  menuCommandSchema,
  overrideId,
  parseDefaultRule,
  parseOverride,
  productMenuState,
  resolveMenu,
  type DefaultRule,
  type MenuOverride,
} from "@/modules/menu/model";

const M = "shf_manha";
const T = "shf_tarde";
const D1 = "2026-10-09";
const D2 = "2026-10-08";

const product = (id: string, overrides: Partial<PublicProduct> = {}): PublicProduct => ({
  id,
  name: id,
  description: "",
  categoryId: "cat_1",
  priceCents: 500,
  priceVersion: 1,
  channels: ["advance", "counter"],
  shiftIds: [M, T],
  availabilityMode: "physical",
  status: "active",
  version: 1,
  photoPath: null,
  ...overrides,
});

// A: padrão manhã+tarde · B: fora do padrão (extra em D1/manhã) · C: padrão manhã (oculto em D1/manhã)
// K: só balcão, padrão manhã · E: desativado · F: regra cita manhã, mas o produto só é vendido à tarde · G: preço inválido
const products = [
  product("A"),
  product("B"),
  product("C"),
  product("K", { channels: ["counter"] }),
  product("E", { status: "inactive" }),
  product("F", { shiftIds: [T] }),
  product("G", { priceVersion: 0 }),
];
const rules = new Map<string, DefaultRule>(
  [
    { productId: "A", shiftIds: [M, T], version: 1 },
    { productId: "C", shiftIds: [M], version: 1 },
    { productId: "K", shiftIds: [M], version: 1 },
    { productId: "E", shiftIds: [M], version: 1 },
    { productId: "F", shiftIds: [M], version: 1 },
    { productId: "G", shiftIds: [M], version: 1 },
  ].map((r) => [r.productId, r]),
);
const d1Morning: MenuOverride = {
  date: D1,
  shiftId: M,
  suspended: false,
  serviceReason: "",
  items: {
    A: { include: null, limit: 50, reason: "" },
    B: { include: "extra", limit: 30, reason: "Dia do hot-dog" },
    C: { include: "hidden", limit: null, reason: "Fornecedor não entrega" },
  },
  version: 3,
};
const ids = (menu: ReturnType<typeof resolveMenu>) => menu.items.map((i) => `${i.product.id}:${i.source}:${i.limit ?? "-"}`);

describe("resolução do cardápio por data/turno (A15)", () => {
  it("D1/manhã: padrão + extra da data, sem o oculto; limites por produto; catálogo continua valendo", () => {
    expect(ids(resolveMenu({ shiftId: M, products, rules, override: d1Morning }))).toEqual(["A:default:50", "B:extra:30", "K:default:-"]);
  });

  it("o extra aparece SOMENTE na data e no turno configurados; a ocultação vale só para eles", () => {
    // Outra data, mesmo turno (sem exceção): volta o padrão, inclusive o produto oculto em D1; o extra não aparece.
    expect(ids(resolveMenu({ shiftId: M, products, rules, override: null }))).toEqual(["A:default:-", "C:default:-", "K:default:-"]);
    // Mesma data, outro turno (a exceção é de D1/manhã): só o padrão da tarde.
    expect(ids(resolveMenu({ shiftId: T, products, rules, override: null }))).toEqual(["A:default:-"]);
  });

  it("suspensão do atendimento esvazia o cardápio da data/turno", () => {
    expect(resolveMenu({ shiftId: M, products, rules, override: { ...d1Morning, suspended: true, serviceReason: "Passeio" } })).toEqual({ suspended: true, items: [] });
  });

  it("produto extra no padrão continua padrão; extra sem permissão do turno/desativado não aparece", () => {
    expect(productMenuState("A", M, rules.get("A"), { ...d1Morning, items: { A: { include: "extra", limit: null, reason: "" } } })).toMatchObject({ offered: true, source: "default" });
    const stale: MenuOverride = { ...d1Morning, items: { F: { include: "extra", limit: null, reason: "" }, E: { include: "extra", limit: null, reason: "" } } };
    expect(ids(resolveMenu({ shiftId: M, products, rules, override: stale }))).toEqual(["A:default:-", "C:default:-", "K:default:-"]);
  });
});

describe("decisão de venda com o cardápio (servidor; ID enviado manualmente não fura o cardápio)", () => {
  const sale = (id: string, override: MenuOverride | null, channel: "advance" | "counter" = "advance", shiftId = M) =>
    evaluateMenuSale(products.find((p) => p.id === id) ?? null, { channel, shiftId }, rules.get(id), override);

  it("aceita padrão e extra com origem e limite; recusa fora do cardápio, oculto e suspenso", () => {
    expect(sale("B", d1Morning)).toMatchObject({ ok: true, source: "extra", limit: 30 });
    expect(sale("A", d1Morning)).toMatchObject({ ok: true, source: "default", limit: 50 });
    expect(sale("B", null)).toEqual({ ok: false, reason: "not_on_menu" });
    expect(sale("B", null, "advance", T)).toEqual({ ok: false, reason: "not_on_menu" });
    expect(sale("C", d1Morning)).toEqual({ ok: false, reason: "not_on_menu" });
    expect(sale("C", null)).toMatchObject({ ok: true, source: "default" });
    expect(sale("A", { ...d1Morning, suspended: true })).toEqual({ ok: false, reason: "service_suspended" });
  });

  it("regras do catálogo vêm antes: inexistente, desativado, canal, turno e preço", () => {
    expect(sale("X", d1Morning)).toEqual({ ok: false, reason: "product_not_found" });
    expect(sale("E", null)).toEqual({ ok: false, reason: "product_inactive" });
    expect(sale("K", null)).toEqual({ ok: false, reason: "channel_not_allowed" });
    expect(sale("K", null, "counter")).toMatchObject({ ok: true, source: "default" });
    expect(sale("F", null)).toEqual({ ok: false, reason: "shift_not_allowed" });
    expect(sale("G", null)).toEqual({ ok: false, reason: "invalid_price" });
  });
});

describe("leitura defensiva dos documentos", () => {
  it("exceção malformada: entradas inválidas são ignoradas; oculto nunca carrega limite", () => {
    const parsed = parseOverride(D1, M, {
      suspended: "sim",
      items: {
        "../x": { include: "extra" },
        A: { include: "talvez", limit: 0 },
        B: { include: "extra", limit: 2.5 },
        C: { include: "hidden", limit: 10, reason: 5 },
        D: { limit: 12 },
        E: null,
        F: { include: null, limit: 5001 },
      },
      version: "x",
    });
    expect(parsed).toEqual({
      date: D1,
      shiftId: M,
      suspended: false,
      serviceReason: "",
      version: 0,
      items: { B: { include: "extra", limit: null, reason: "" }, C: { include: "hidden", limit: null, reason: "" }, D: { include: null, limit: 12, reason: "" } },
    });
    expect(parseOverride(D1, M, undefined)).toMatchObject({ suspended: false, items: {}, version: 0 });
  });

  it("regra padrão aceita só IDs de turno válidos", () => {
    expect(parseDefaultRule("A", { shiftIds: [M, "../x", 3, ""], version: 2 })).toEqual({ productId: "A", shiftIds: [M], version: 2 });
    expect(parseDefaultRule("A", undefined)).toEqual({ productId: "A", shiftIds: [], version: 0 });
  });

  it("ID da exceção = data local + turno", () => {
    expect(overrideId(D2, M)).toBe("2026-10-08__shf_manha");
  });
});

describe("comandos do cardápio — validação", () => {
  const item = { action: "setItem", key: "chave-teste-0001", date: D1, shiftId: M, productId: "prd_1", expectedVersion: 0, include: "extra", limit: null };

  it("limite inteiro de 1 a 5000; oculto não tem limite e exige motivo", () => {
    for (const limit of [0, -1, 1.5, 5001, "10"]) expect(menuCommandSchema.safeParse({ ...item, limit }).success).toBe(false);
    for (const limit of [1, 5000, null]) expect(menuCommandSchema.safeParse({ ...item, limit }).success).toBe(true);
    expect(menuCommandSchema.safeParse({ ...item, include: "hidden", limit: 10, reason: "x" }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...item, include: "hidden", limit: null }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...item, include: "hidden", limit: null, reason: "Sem entrega" }).success).toBe(true);
    expect(menuCommandSchema.safeParse({ ...item, include: "remove" }).success).toBe(false);
  });

  it("data inexistente, IDs com caminho, motivo com fórmula e chave curta são recusados", () => {
    expect(menuCommandSchema.safeParse({ ...item, date: "2026-02-30" }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...item, date: "09/10/2026" }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...item, productId: "../products/x" }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...item, shiftId: "a/b" }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...item, reason: "=HYPERLINK(1)" }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...item, key: "curta" }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...item, expectedVersion: -1 }).success).toBe(false);
  });

  it("suspender exige motivo; retomar não; padrão normaliza turnos em conjunto ordenado", () => {
    const service = { action: "setService", key: "chave-teste-0002", date: D1, shiftId: M, expectedVersion: 1 };
    expect(menuCommandSchema.safeParse({ ...service, suspended: true }).success).toBe(false);
    expect(menuCommandSchema.safeParse({ ...service, suspended: true, reason: "Passeio" }).success).toBe(true);
    expect(menuCommandSchema.safeParse({ ...service, suspended: false }).success).toBe(true);
    const parsed = menuCommandSchema.parse({ action: "setDefault", key: "chave-teste-0003", productId: "prd_1", expectedVersion: 0, shiftIds: [T, M, M] });
    expect(parsed).toMatchObject({ shiftIds: [M, T] });
    expect(menuCommandSchema.safeParse({ action: "setDefault", key: "chave-teste-0003", productId: "prd_1", expectedVersion: 0, shiftIds: [] }).success).toBe(true);
  });
});
