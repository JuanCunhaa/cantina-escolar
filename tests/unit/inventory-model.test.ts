import { describe, expect, it } from "vitest";
import {
  allocateFefo,
  availableAt,
  capacityId,
  checkStock,
  deficitOf,
  eligibleOn,
  parseBalance,
  receiptCommandSchema,
  type Lot,
} from "@/modules/inventory/model";

const lot = (id: string, remaining: number, validThrough: string, availableOn = "2026-10-01"): Lot => ({
  id,
  productId: "p",
  receiptId: id,
  lotCode: null,
  availableOn,
  expiresOn: null,
  validThrough,
  quantity: remaining,
  remaining,
});

describe("disponibilidade física = vendável − reservas, com validade por lote", () => {
  it("lote vencido para a data não conta e reserva de outra data consome lote compatível", () => {
    const supply = { "2026-10-05": 10, "2026-10-09": 10 };
    const reserved = { "2026-10-07": 10 };
    expect(availableAt(supply, reserved, "2026-10-04")).toBe(10); // o lote que vence dia 5 atende o dia 4
    expect(availableAt(supply, reserved, "2026-10-08")).toBe(0); // dia 8 só usa o lote do dia 9, já reservado
    expect(availableAt(supply, {}, "2026-10-06")).toBe(10); // dia 6: o lote do dia 5 venceu
    expect(availableAt(supply, {}, "2026-10-10")).toBe(0);
    expect(deficitOf(supply, reserved)).toBe(0);
    expect(deficitOf({ "2026-10-05": 10 }, { "2026-10-07": 1 })).toBe(1);
  });

  it("sem reservas, tudo que não venceu está disponível", () => {
    expect(availableAt({ "9999-12-31": 7 }, {}, "2026-10-03")).toBe(7);
    expect(availableAt({}, {}, "2026-10-03")).toBe(0);
  });
});

describe("FEFO: primeiro a vencer, só lotes elegíveis", () => {
  const lots = [lot("novo", 5, "9999-12-31"), lot("vence5", 4, "2026-10-05"), lot("vencido", 9, "2026-10-01"), lot("futuro", 5, "2026-10-20", "2026-10-10")];
  it("não usa vencido nem lote ainda não disponível", () => {
    const plan = allocateFefo(lots, 8, eligibleOn("2026-10-03"));
    expect(plan.allocations).toEqual([
      { lotId: "vence5", quantity: 4 },
      { lotId: "novo", quantity: 4 },
    ]);
    expect(plan.unmet).toBe(0);
    expect(allocateFefo(lots, 20, eligibleOn("2026-10-03")).unmet).toBe(11);
  });
  it("perda sem filtro sai primeiro do vencido", () => {
    expect(allocateFefo(lots, 3, () => true).allocations).toEqual([{ lotId: "vencido", quantity: 3 }]);
  });
});

describe("reconciliação saldo × livro × lotes × reservas × cotas", () => {
  const balance = parseBalance("p", "physical", { onHand: 8, movementSeq: 2, supplyByValidity: { "9999-12-31": 8 }, reservedByDate: { "2026-10-05": 3 } });
  const base = {
    balance,
    valueMicros: 800,
    movements: [
      { seq: 1, type: "receipt", quantity: 10, totalCostMicros: 1000, onHandAfter: 10, valueAfterMicros: 1000 },
      { seq: 2, type: "sale_exit", quantity: -2, totalCostMicros: -200, onHandAfter: 8, valueAfterMicros: 800 },
    ],
    lots: [{ ...lot("l1", 8, "9999-12-31"), quantity: 10, hasOpenKey: true }],
    reservations: [{ id: "r1", productId: "p", orderRef: "o1", consumptionDate: "2026-10-05", shiftId: "s", quantity: 3, deliveredQty: 0, releasedQty: 0 }],
    capacities: [{ productId: "p", date: "2026-10-05", shiftId: "s", capacity: null, reserved: 3, delivered: 0, version: 1 }],
  };
  it("estado coerente não tem problemas (reserva não entra no livro)", () => {
    expect(checkStock(base)).toEqual([]);
    expect(capacityId("p", "2026-10-05", "s")).toBe("p_2026-10-05_s");
  });
  it("detecta divergências de livro, lote, reserva e cota", () => {
    expect(checkStock({ ...base, valueMicros: 799 })).not.toEqual([]);
    expect(checkStock({ ...base, balance: { ...balance, onHand: 9 } }).length).toBeGreaterThan(0);
    expect(checkStock({ ...base, lots: [{ ...base.lots[0]!, remaining: 7 }] }).length).toBeGreaterThan(0);
    expect(checkStock({ ...base, reservations: [] }).length).toBeGreaterThan(0);
    expect(checkStock({ ...base, capacities: [{ ...base.capacities[0]!, reserved: 2 }] }).length).toBeGreaterThan(0);
    expect(checkStock({ ...base, movements: [base.movements[1]!, base.movements[0]!] }).length).toBeGreaterThan(0);
  });
});

describe("entrada: validação do comando", () => {
  const ok = { action: "create", key: "chave-0001", productId: "prd_1", kind: "purchase", quantity: 100, unitCost: "1,10" };
  it("custo é texto decimal (nunca número de ponto flutuante) e quantidade inteira positiva", () => {
    expect(receiptCommandSchema.safeParse(ok).success).toBe(true);
    expect(receiptCommandSchema.safeParse({ ...ok, unitCost: 1.1 }).success).toBe(false);
    expect(receiptCommandSchema.safeParse({ ...ok, quantity: 0 }).success).toBe(false);
    expect(receiptCommandSchema.safeParse({ ...ok, quantity: 1.5 }).success).toBe(false);
    expect(receiptCommandSchema.safeParse({ ...ok, expiresOn: "2026-02-30" }).success).toBe(false);
  });
});
