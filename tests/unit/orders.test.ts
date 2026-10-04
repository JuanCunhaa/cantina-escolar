import { describe, expect, it } from "vitest";
import { MAX_BATCH_DATES, MAX_BATCH_LINES, MAX_LINES_PER_DATE, MAX_LINE_QUANTITY, checkoutSchema, priceChanges, reviewedCart, subtotalOf, totalOf } from "@/modules/orders/model";

const line = (productId: string, quantity = 1, expectedPriceCents = 500) => ({ productId, quantity, expectedPriceCents });
const base = (days: unknown) => ({ key: "chave-de-teste-1", studentId: "stu_1", expectedShiftId: "shf_1", days });
const day = (date: string, ...ids: string[]) => ({ date, lines: ids.map((id) => line(id)) });
const dateN = (n: number) => `2026-10-${String(n + 1).padStart(2, "0")}`;

describe("checkoutSchema (F11): limites do lote e normalização", () => {
  it("documenta e aplica o tamanho máximo: 8 datas, 10 produtos por data, 40 linhas, 20 unidades por linha", () => {
    expect([MAX_BATCH_DATES, MAX_LINES_PER_DATE, MAX_BATCH_LINES, MAX_LINE_QUANTITY]).toEqual([8, 10, 40, 20]);
    const full = Array.from({ length: 8 }, (_, i) => day(dateN(i), "a", "b", "c", "d", "e"));
    expect(checkoutSchema.safeParse(base(full)).success).toBe(true); // 8 × 5 = 40 linhas
    expect(checkoutSchema.safeParse(base([...full, day(dateN(8), "a")])).success).toBe(false); // 9 datas
    expect(checkoutSchema.safeParse(base([...full.slice(0, 7), day(dateN(7), "a", "b", "c", "d", "e", "f")])).success).toBe(false); // 41 linhas
    expect(checkoutSchema.safeParse(base([day(dateN(0), ...Array.from({ length: 11 }, (_, i) => `p${i}`))])).success).toBe(false);
    expect(checkoutSchema.safeParse(base([])).success).toBe(false);
    expect(checkoutSchema.safeParse(base([{ date: dateN(0), lines: [] }])).success).toBe(false);
  });

  it("recusa quantidade/preço inválidos, repetições e campos que o cliente não pode informar", () => {
    const ok = base([day(dateN(0), "a")]);
    expect(checkoutSchema.safeParse(ok).success).toBe(true);
    for (const quantity of [0, -1, 1.5, MAX_LINE_QUANTITY + 1]) expect(checkoutSchema.safeParse(base([{ date: dateN(0), lines: [line("a", quantity)] }])).success).toBe(false);
    for (const price of [0, -5, 2.5, 50_001]) expect(checkoutSchema.safeParse(base([{ date: dateN(0), lines: [line("a", 1, price)] }])).success).toBe(false);
    expect(checkoutSchema.safeParse(base([day(dateN(0), "a", "a")])).success).toBe(false); // produto repetido na data
    expect(checkoutSchema.safeParse(base([day(dateN(0), "a"), day(dateN(0), "b")])).success).toBe(false); // data repetida
    expect(checkoutSchema.safeParse(base([day("2026-02-30", "a")])).success).toBe(false);
    for (const extra of [{ totalCents: 1 }, { balanceCents: 1 }, { shiftId: "x" }]) expect(checkoutSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...ok, key: "curta" }).success).toBe(false);
    expect(checkoutSchema.safeParse(base([{ date: dateN(0), lines: [{ ...line("a"), unitPriceCents: 1 }] }])).success).toBe(false);
  });

  it("normaliza a ordem de datas e produtos (o mesmo carrinho tem o mesmo payload) e assume confirmed=false", () => {
    const a = checkoutSchema.parse(base([day(dateN(2), "b", "a"), day(dateN(0), "z")]));
    const b = checkoutSchema.parse(base([day(dateN(0), "z"), day(dateN(2), "a", "b")]));
    expect(a).toEqual(b);
    expect(a.days.map((d) => d.date)).toEqual([dateN(0), dateN(2)]);
    expect(a.days[1]!.lines.map((l) => l.productId)).toEqual(["a", "b"]);
    expect(a.confirmed).toBe(false);
  });
});

describe("revisão de preço (F11)", () => {
  const lines = [
    { date: "2026-10-05", productId: "a", name: "Suco", quantity: 2, expectedPriceCents: 800, currentPriceCents: 900 },
    { date: "2026-10-05", productId: "b", name: "Pão", quantity: 1, expectedPriceCents: 300, currentPriceCents: 300 },
    { date: "2026-10-06", productId: "a", name: "Suco", quantity: 1, expectedPriceCents: 800, currentPriceCents: 900 },
  ];
  it("qualquer diferença (maior OU menor) exige nova confirmação; iguais não geram revisão", () => {
    expect(priceChanges(lines).map((c) => [c.date, c.productId, c.expectedPriceCents, c.currentPriceCents])).toEqual([
      ["2026-10-05", "a", 800, 900],
      ["2026-10-06", "a", 800, 900],
    ]);
    expect(priceChanges([{ ...lines[1]!, expectedPriceCents: 400 }])).toHaveLength(1);
    expect(priceChanges([lines[1]!])).toEqual([]);
  });

  it("o carrinho revisto usa SEMPRE o preço do servidor, por data, em centavos inteiros", () => {
    expect(reviewedCart(lines)).toEqual({
      totalCents: 2 * 900 + 300 + 900,
      days: [
        { date: "2026-10-05", totalCents: 2100, lines: [expect.objectContaining({ productId: "a", unitPriceCents: 900, subtotalCents: 1800 }), expect.objectContaining({ productId: "b", subtotalCents: 300 })] },
        { date: "2026-10-06", totalCents: 900, lines: [expect.objectContaining({ productId: "a", unitPriceCents: 900, subtotalCents: 900 })] },
      ],
    });
    expect(subtotalOf(333, 3)).toBe(999);
    expect(totalOf([{ subtotalCents: 1 }, { subtotalCents: 2 }])).toBe(3);
  });
});
