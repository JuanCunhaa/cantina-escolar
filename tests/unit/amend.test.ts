import { describe, expect, it } from "vitest";
import { exchangeDifference, exchangeQuoteSchema, exchangeSchema, rescheduleSchema } from "@/modules/orders/amend-model";
import { aggregatePreparation, aggregateStatus, deliveryRevenueOf, exchangeCreditOf, refundValueOf, remainingOf, remainingValueOf, totalsOf } from "@/modules/orders/fulfillment-model";
import { applyUsageDeltas, usageAfter, type UsageSnapshot } from "@/modules/policies/usage";

const KEY = "chave-de-teste-123";

describe("esquemas de reagendamento e troca (F16)", () => {
  it("reagendar exige motivo e destino; exceção de horário é explícita (padrão falso); campos de valor são recusados", () => {
    const ok = { key: KEY, orderId: "ord_1", reason: "Comprou para a data errada", toDate: "2026-10-07", toShiftId: "sh_t" };
    expect(rescheduleSchema.parse(ok)).toMatchObject({ overrideCutoff: false });
    expect(rescheduleSchema.safeParse({ ...ok, reason: "ok" }).success).toBe(false);
    expect(rescheduleSchema.safeParse({ ...ok, toDate: "07/10/2026" }).success).toBe(false);
    for (const extra of [{ amountCents: 1 }, { priceCents: 1 }, { studentId: "outro" }, { chargeCents: 0 }]) expect(rescheduleSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
  });

  it("troca: só linhas/produtos distintos, quantidades 1–20, diferença confirmada obrigatória e normalização estável do payload", () => {
    const base = { orderId: "ord_1", remove: [{ lineNo: 2, quantity: 1 }, { lineNo: 1, quantity: 1 }], add: [{ productId: "b", quantity: 1, expectedPriceCents: 700 }, { productId: "a", quantity: 2, expectedPriceCents: 300 }] };
    const q = exchangeQuoteSchema.parse(base);
    expect(q.remove.map((r) => r.lineNo)).toEqual([1, 2]);
    expect(q.add.map((a) => a.productId)).toEqual(["a", "b"]);
    expect(exchangeQuoteSchema.safeParse({ ...base, remove: [{ lineNo: 1, quantity: 1 }, { lineNo: 1, quantity: 2 }] }).success).toBe(false);
    expect(exchangeQuoteSchema.safeParse({ ...base, add: [{ productId: "a", quantity: 21, expectedPriceCents: 1 }] }).success).toBe(false);
    expect(exchangeQuoteSchema.safeParse({ ...base, differenceCents: 0 }).success).toBe(false);
    expect(exchangeSchema.safeParse({ ...base, key: KEY, reason: "Aluno pediu outro" }).success).toBe(false); // sem diferença confirmada
    expect(exchangeSchema.parse({ ...base, key: KEY, reason: "Aluno pediu outro", expectedDifferenceCents: -200 })).toMatchObject({ expectedDifferenceCents: -200, overrideCutoff: false });
  });

  it("diferença: + cobra, − devolve, 0 sem lançamento", () => {
    expect(exchangeDifference(500, 700)).toBe(200);
    expect(exchangeDifference(500, 300)).toBe(-200);
    expect(exchangeDifference(500, 500)).toBe(0);
  });
});

describe("progresso com unidades trocadas", () => {
  it("trocadas saem do restante e não reabrem nada; situação e painel conservam unidades", () => {
    const old = { quantity: 2, deliveredQty: 0, canceledQty: 0, exchangedQty: 2 };
    const fresh = { quantity: 1 };
    expect(remainingOf(old)).toBe(0);
    expect(totalsOf([old, fresh])).toEqual({ scheduled: 3, delivered: 0, canceled: 0, exchanged: 2, remaining: 1 });
    expect(aggregateStatus({ items: [old, fresh], prep: "none", nonPickup: null })).toBe("paid");
    expect(aggregateStatus({ items: [old, { ...fresh, deliveredQty: 1 }], prep: "none", nonPickup: null })).toBe("delivered");
    expect(aggregateStatus({ items: [old, { ...fresh, canceledQty: 1 }], prep: "none", nonPickup: null })).toBe("cancelled");
    // Painel: as unidades trocadas não contam como agendadas (a linha nova as substitui).
    const [row] = aggregatePreparation([{ consumptionDate: "2026-10-07", shiftId: "t", status: "paid", items: [{ ...old, productId: "a", name: "A" }] }]);
    expect(row).toMatchObject({ scheduled: 0, remaining: 0 });
  });

  it("propriedade: em QUALQUER ordem de entregas, cancelamentos e trocas, Σ receita + Σ reembolsos + Σ créditos de troca = pago", () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 400; round++) {
      const quantity = 1 + rand(12);
      const subtotalCents = quantity + rand(5000);
      let line = { quantity, subtotalCents, deliveredQty: 0, canceledQty: 0, exchangedQty: 0 };
      let settled = 0;
      while (remainingOf(line) > 0) {
        const units = 1 + rand(remainingOf(line));
        const kind = rand(3);
        const before = remainingValueOf(line);
        const amount = kind === 0 ? deliveryRevenueOf(line, units) : kind === 1 ? refundValueOf(line, units) : exchangeCreditOf(line, units);
        expect(amount).toBeGreaterThanOrEqual(1);
        expect(amount).toBeLessThanOrEqual(before);
        settled += amount;
        line = kind === 0 ? { ...line, deliveredQty: line.deliveredQty + units } : kind === 1 ? { ...line, canceledQty: line.canceledQty + units } : { ...line, exchangedQty: line.exchangedQty + units };
        expect(remainingValueOf(line)).toBe(before - amount);
      }
      expect(settled).toBe(subtotalCents);
    }
  });
});

describe("uso por data ao mover comprometimento", () => {
  type Write = { path: string; data: Record<string, unknown> };
  const fakeTx = () => {
    const writes: Write[] = [];
    return { writes, tx: { set: (ref: { path: string }, data: Record<string, unknown>) => writes.push({ path: ref.path, data }) } };
  };
  const ref = (path: string) => ({ path }) as never;
  const fakeDb = { doc: (path: string) => ref(path) } as never;
  const snapshot = (days: Record<string, number>, weeks: Record<string, number>): UsageSnapshot => ({
    days,
    weeks,
    dayRefs: new Map(Object.keys(days).map((d) => [d, ref(`studentUsage/s/days/${d}`)])),
    weekRefs: new Map(Object.keys(weeks).map((w) => [w, ref(`studentUsage/s/weeks/${w}`)])),
  });

  it("origem e destino na mesma semana viram UMA gravação semanal com o líquido (sem a segunda apagar a primeira)", () => {
    // 2026-10-06 (ter) e 2026-10-08 (qui): semana de 2026-10-05. Move R$ 5 da quinta para a terça.
    const snap = snapshot({ "2026-10-06": 800, "2026-10-08": 500 }, { "2026-10-05": 1300 });
    const { writes, tx } = fakeTx();
    applyUsageDeltas(tx as never, fakeDb, "s", snap, [{ date: "2026-10-08", amountCents: -500 }, { date: "2026-10-06", amountCents: 500 }]);
    expect(writes.map((w) => [w.path, w.data.committedCents])).toEqual([
      ["studentUsage/s/days/2026-10-08", 0],
      ["studentUsage/s/days/2026-10-06", 1300],
    ]); // semana: líquido zero, nenhuma gravação (o total semanal continua R$ 13)
  });

  it("líquido zero não regrava; negativo é violação de invariante (nunca truncado)", () => {
    const snap = snapshot({ "2026-10-06": 500, "2026-10-07": 0 }, { "2026-10-05": 500 });
    const { writes, tx } = fakeTx();
    applyUsageDeltas(tx as never, fakeDb, "s", snap, [{ date: "2026-10-06", amountCents: -500 }, { date: "2026-10-07", amountCents: 500 }]);
    expect(writes.map((w) => [w.path, w.data.committedCents])).toEqual([
      ["studentUsage/s/days/2026-10-06", 0],
      ["studentUsage/s/days/2026-10-07", 500],
    ]);
    expect(() => applyUsageDeltas(tx as never, fakeDb, "s", snap, [{ date: "2026-10-06", amountCents: -501 }])).toThrow(/negativo/);
  });

  it("visão do uso depois de liberar a origem: o destino é avaliado sem contar o que sai", () => {
    expect(usageAfter({ days: { "2026-10-06": 800 }, weeks: { "2026-10-05": 1300 } }, [{ date: "2026-10-08", amountCents: -500 }])).toEqual({ days: { "2026-10-06": 800, "2026-10-08": -500 }, weeks: { "2026-10-05": 800 } });
  });
});
