import { describe, expect, it } from "vitest";
import { counterSaleSchema, directSaleSchema, feeRecordOf, MAX_POS_LINES, MAX_POS_QUANTITY } from "@/modules/pos/model";
import type { PosProduct, PosStudent, PosStudentRow } from "@/modules/pos/queries";
import { defaultShiftId, filterProducts, frequentProducts, homonymIds, parseQuickAdd, precheck, searchStudents, totalOf } from "@/modules/pos/view";
import { feeCentsOf, EMPTY_DIRECT } from "@/modules/pos/components/sale-panel";

const KEY = "chave-de-teste-1";
const line = (productId: string, quantity = 1) => ({ productId, quantity, expectedPriceCents: 100 });

describe("PDV: entrada validada (F15)", () => {
  it("venda com saldo: ordem das linhas é normalizada e valores do cliente são recusados", () => {
    const a = counterSaleSchema.parse({ key: KEY, studentId: "s1", expectedShiftId: "t", lines: [line("b"), line("a", 10)] });
    const b = counterSaleSchema.parse({ key: KEY, studentId: "s1", expectedShiftId: "t", lines: [line("a", 10), line("b")] });
    expect(a).toEqual(b);
    expect(a.lines.map((l) => l.productId)).toEqual(["a", "b"]);
    for (const extra of [{ totalCents: 1 }, { balanceCents: 1 }, { channel: "advance" }]) {
      expect(counterSaleSchema.safeParse({ key: KEY, studentId: "s1", expectedShiftId: "t", lines: [line("a")], ...extra }).success).toBe(false);
    }
    expect(counterSaleSchema.safeParse({ key: KEY, studentId: "s1", expectedShiftId: "t", lines: [{ ...line("a"), priceCents: 1 }] }).success).toBe(false);
  });

  it("limites: 1–50 unidades por linha, até 20 linhas, sem produto repetido, chave de 8–64 caracteres", () => {
    const base = { key: KEY, studentId: "s1", expectedShiftId: "t" };
    expect(counterSaleSchema.safeParse({ ...base, lines: [line("a", MAX_POS_QUANTITY)] }).success).toBe(true);
    expect(counterSaleSchema.safeParse({ ...base, lines: [line("a", MAX_POS_QUANTITY + 1)] }).success).toBe(false);
    expect(counterSaleSchema.safeParse({ ...base, lines: [line("a", 0)] }).success).toBe(false);
    expect(counterSaleSchema.safeParse({ ...base, lines: [line("a", 1.5)] }).success).toBe(false);
    expect(counterSaleSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(counterSaleSchema.safeParse({ ...base, lines: [line("a"), line("a")] }).success).toBe(false);
    expect(counterSaleSchema.safeParse({ ...base, lines: Array.from({ length: MAX_POS_LINES + 1 }, (_, i) => line(`p${i}`)) }).success).toBe(false);
    expect(counterSaleSchema.safeParse({ ...base, key: "curta", lines: [line("a")] }).success).toBe(false);
  });

  it("venda direta exige recebimento confirmado, meio válido e não aceita aluno/carteira", () => {
    const base = { key: KEY, shiftId: "t", lines: [line("a")], paymentMethod: "pix", receivedConfirmed: true };
    expect(directSaleSchema.parse(base)).toMatchObject({ buyerKind: "other", paymentMethod: "pix" });
    expect(directSaleSchema.safeParse({ ...base, receivedConfirmed: false }).success).toBe(false);
    expect(directSaleSchema.safeParse({ ...base, receivedConfirmed: undefined }).success).toBe(false);
    expect(directSaleSchema.safeParse({ ...base, paymentMethod: "boleto" }).success).toBe(false);
    expect(directSaleSchema.safeParse({ ...base, studentId: "s1" }).success).toBe(false);
    expect(directSaleSchema.safeParse({ ...base, feeCents: -1 }).success).toBe(false);
    expect(directSaleSchema.safeParse({ ...base, feeCents: 1.5 }).success).toBe(false);
    expect(directSaleSchema.safeParse({ ...base, buyerNote: "=1+1" }).success).toBe(false);
  });

  it("taxa: dinheiro sem taxa de meio; Pix/cartão informado ou pendente de conferência (nunca inventada)", () => {
    expect(feeRecordOf("cash", undefined)).toEqual({ status: "none", cents: 0, source: "not_applicable" });
    expect(feeRecordOf("pix", undefined)).toEqual({ status: "pending", cents: null, source: "operator" });
    expect(feeRecordOf("card_credit", 35)).toEqual({ status: "informed", cents: 35, source: "operator" });
    expect(feeRecordOf("card_debit", 0)).toEqual({ status: "informed", cents: 0, source: "operator" });
  });
});

const rows: PosStudentRow[] = [
  { id: "1", name: "Maria Silva", enrollment: "A100", classId: "c1", className: "5º A", shiftId: "m", shiftName: "Manhã" },
  { id: "2", name: "Maria  silva", enrollment: "A200", classId: "c2", className: "3º B", shiftId: "t", shiftName: "Tarde" },
  { id: "3", name: "João Álvaro Mariano", enrollment: "B300", classId: "c1", className: "5º A", shiftId: "m", shiftName: "Manhã" },
  { id: "4", name: "Ana Souza", enrollment: "C400", classId: "c1", className: "5º A", shiftId: "m", shiftName: "Manhã" },
];

describe("PDV: busca de aluno e atalhos", () => {
  it("busca sem acento/caixa, em qualquer ordem e por matrícula; vazio não lista ninguém", () => {
    expect(searchStudents(rows, "")).toEqual([]);
    expect(searchStudents(rows, "  ")).toEqual([]);
    expect(searchStudents(rows, "silva maria").map((r) => r.id).sort()).toEqual(["1", "2"]);
    expect(searchStudents(rows, "alvaro").map((r) => r.id)).toEqual(["3"]);
    expect(searchStudents(rows, "mari").map((r) => r.id)).toEqual(["1", "2", "3"]); // começa por "mari" antes do trecho
    expect(searchStudents(rows, "c400").map((r) => r.id)).toEqual(["4"]);
    expect(searchStudents(rows, "zzz")).toEqual([]);
  });

  it("homônimos: mesmo nome normalizado (espaços e caixa) são destacados", () => {
    expect([...homonymIds(rows)].sort()).toEqual(["1", "2"]);
  });

  it("digitação rápida: '10 bala' = 10 unidades; sem número = 1; texto com número no meio não vira quantidade", () => {
    expect(parseQuickAdd("10 bala")).toEqual({ quantity: 10, term: "bala" });
    expect(parseQuickAdd("3x suco")).toEqual({ quantity: 3, term: "suco" });
    expect(parseQuickAdd("suco")).toEqual({ quantity: 1, term: "suco" });
    expect(parseQuickAdd("coca 600")).toEqual({ quantity: 1, term: "coca 600" });
    expect(parseQuickAdd("0 bala").quantity).toBe(1);
  });

  it("turno padrão da venda direta pelo horário local", () => {
    const shifts = [{ id: "m", slug: "manha" }, { id: "t", slug: "tarde" }];
    expect(defaultShiftId(shifts, new Date("2026-10-05T12:00:00Z"))).toBe("m"); // 09:00 em São Paulo
    expect(defaultShiftId(shifts, new Date("2026-10-05T17:00:00Z"))).toBe("t"); // 14:00 em São Paulo
    expect(defaultShiftId([{ id: "x", slug: "integral" }], new Date())).toBe("x");
    expect(defaultShiftId([], new Date())).toBe("");
  });
});

const product = (id: string, name: string, priceCents: number, availableUnits: number, categoryId = "c"): PosProduct => ({ id, name, categoryId, categoryName: "Cat", priceCents, priceVersion: 1, photoPath: null, mode: "physical", availableUnits });
const products = [product("bala", "Bala de goma", 100, 50), product("suco", "Suco de uva", 450, 3), product("pao", "Pão de queijo", 600, 0, "salgados")];
const student = (over: Partial<PosStudent["restrictions"]> = {}, balance = 5000): PosStudent => ({
  student: { id: "1", name: "Maria", enrollment: "A", classId: "c", className: "5º A", shiftId: "m", shiftName: "Manhã", status: "active" },
  wallet: { balanceCents: balance, version: 1 },
  counterAllowed: true,
  restrictions: { dailyLimitCents: null, weeklyLimitCents: null, dayCommittedCents: 0, weekCommittedCents: 0, weekStart: "2026-10-05", remainingTodayCents: null, blockedProductIds: [], blockedCategoryIds: [], ...over },
  exceptions: [],
  today: "2026-10-05",
});

describe("PDV: carrinho e pré-checagens (a decisão final é do servidor)", () => {
  it("filtra produtos por nome sem acento e por categoria; total em centavos inteiros", () => {
    expect(filterProducts(products, "PAO", "").map((p) => p.id)).toEqual(["pao"]);
    expect(filterProducts(products, "", "salgados").map((p) => p.id)).toEqual(["pao"]);
    expect(filterProducts(products, "de", "").map((p) => p.id)).toEqual(["bala", "suco", "pao"]);
    expect(totalOf([{ productId: "bala", quantity: 10 }, { productId: "suco", quantity: 2 }], products)).toBe(1900);
  });

  it("10 balas: R$ 10,00 cabem no saldo; saldo curto, bloqueio, teto do dia e estoque geram avisos", () => {
    expect(precheck([{ productId: "bala", quantity: 10 }], products, student())).toMatchObject({ totalCents: 1000, overBalanceCents: 0, overLimitCents: 0, blocked: [], overStock: [] });
    expect(precheck([{ productId: "bala", quantity: 10 }], products, student({}, 700))).toMatchObject({ overBalanceCents: 300 });
    expect(precheck([{ productId: "bala", quantity: 10 }], products, student({ remainingTodayCents: 200 }))).toMatchObject({ overLimitCents: 800 });
    expect(precheck([{ productId: "suco", quantity: 1 }], products, student({ blockedProductIds: ["suco"] }))).toMatchObject({ blocked: ["Suco de uva"] });
    expect(precheck([{ productId: "pao", quantity: 1 }], products, student({ blockedCategoryIds: ["salgados"] }))).toMatchObject({ blocked: ["Pão de queijo"], overStock: ["Pão de queijo"] });
    expect(precheck([{ productId: "suco", quantity: 4 }], products, student())).toMatchObject({ overStock: ["Suco de uva"] });
  });

  it("venda direta não tem saldo nem política", () => {
    expect(precheck([{ productId: "bala", quantity: 99 }], products, null)).toMatchObject({ totalCents: 9900, overBalanceCents: 0, overLimitCents: 0, blocked: [] });
  });

  it("frequentes: mais vendidos primeiro, só os que existem no cardápio de hoje", () => {
    expect(frequentProducts(products, { suco: 5, bala: 9, fantasma: 100 }).map((p) => p.id)).toEqual(["bala", "suco"]);
    expect(frequentProducts(products, {})).toEqual([]);
  });

  it("taxa digitada vira centavos; vazio = não informada; zero é válido; inválido = null", () => {
    const f = (feeText: string, paymentMethod: "cash" | "pix" | "card_credit" = "pix") => feeCentsOf({ ...EMPTY_DIRECT, paymentMethod, feeText });
    expect(f("0,35")).toBe(35);
    expect(f("1")).toBe(100);
    expect(f("0")).toBe(0);
    expect(f("0,00")).toBe(0);
    expect(f("")).toBeUndefined();
    expect(f("abc")).toBeNull();
    expect(f("0,35", "cash")).toBeUndefined();
  });
});
