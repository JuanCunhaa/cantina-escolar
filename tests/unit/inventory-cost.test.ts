import { describe, expect, it } from "vitest";
import {
  MICROS_PER_REAL,
  averageUnitMicros,
  entryValue,
  exitCost,
  grossProfitCents,
  microsToCents,
  microsToReaisText,
  parseUnitCost,
} from "@/modules/inventory/cost";

describe("custo unitário Decimal exato (inteiro escalado em micro-centavos)", () => {
  it("converte reais em texto sem ponto flutuante", () => {
    expect(parseUnitCost("1")).toBe(1 * MICROS_PER_REAL);
    expect(parseUnitCost("1,10")).toBe(110_000_000);
    expect(parseUnitCost("1.1")).toBe(110_000_000);
    expect(parseUnitCost("0,0001")).toBe(10_000);
    expect(parseUnitCost("0.1")).toBe(10_000_000); // 0,1 não vira 0,1000000000000000055
    expect(parseUnitCost("999,9999")).toBe(99_999_990_000);
  });

  it("recusa custo zero, negativo, com casas demais ou acima do teto: nunca inventa custo", () => {
    for (const bad of ["", "0", "0,0000", "-1", "1,12345", "abc", "1e3", "10000", "1.000,00", "1,"]) {
      expect(() => parseUnitCost(bad), bad).toThrow();
    }
  });

  it("formata o valor exato sem arredondar", () => {
    expect(microsToReaisText(105_000_000)).toBe("1,05");
    expect(microsToReaisText(100_006_667)).toBe("1,00006667");
    expect(microsToReaisText(0)).toBe("0,00");
    expect(microsToReaisText(-110_000_000)).toBe("-1,10");
  });
});

describe("A20 — custo médio ponderado sobre o que está em estoque", () => {
  it("100 a R$ 1,00 + 100 a R$ 1,10, sem saída: média R$ 1,05; vender 10 a R$ 2 → receita 20, CMV 10,50, lucro 9,50", () => {
    const value = entryValue(100, parseUnitCost("1,00")) + entryValue(100, parseUnitCost("1,10"));
    expect(value).toBe(210 * MICROS_PER_REAL); // R$ 210,00
    expect(averageUnitMicros(value, 200)).toBe(parseUnitCost("1,05"));
    const cogs = exitCost(value, 200, 10);
    expect(microsToReaisText(cogs)).toBe("10,50");
    expect(microsToCents(cogs)).toBe(1050);
    const revenueCents = 10 * 200;
    expect(revenueCents).toBe(2000);
    expect(grossProfitCents(revenueCents, cogs)).toBe(950);
  });
});

describe("A21 — saídas entre compras e arredondamento residual", () => {
  it("a média usa só o que resta: compra, saída, nova compra", () => {
    let onHand = 100;
    let value = entryValue(100, parseUnitCost("1,00")); // R$ 100,00
    const first = exitCost(value, onHand, 60); // 60 × 1,00
    value -= first;
    onHand -= 60;
    expect(first).toBe(60 * MICROS_PER_REAL);
    value += entryValue(100, parseUnitCost("1,10")); // sobram 40 a 1,00 + 100 a 1,10 = 150,00 em 140 un.
    onHand += 100;
    expect(value).toBe(150 * MICROS_PER_REAL);
    expect(averageUnitMicros(value, onHand)).toBe(107_142_857); // 1,0714… (média só do que restava)
    const second = exitCost(value, onHand, 70);
    expect(second).toBe(75 * MICROS_PER_REAL); // 150 × 70 / 140
  });

  it("preserva o resíduo: Σ custo das saídas + valor restante = Σ entradas, e a última unidade leva o resto", () => {
    let onHand = 3;
    let value = entryValue(1, parseUnitCost("1,0000")) + entryValue(2, parseUnitCost("1,0001"));
    const total = value;
    expect(value).toBe(300_020_000);
    const costs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const c = exitCost(value, onHand, 1);
      costs.push(c);
      value -= c;
      onHand -= 1;
    }
    expect(costs).toEqual([100_006_667, 100_006_667, 100_006_666]);
    expect(costs.reduce((a, b) => a + b, 0)).toBe(total);
    expect(value).toBe(0);
  });

  it("propriedade: com sequências variadas de entradas e saídas nunca se perde nem se cria valor", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      let onHand = 0;
      let value = 0;
      let entered = 0;
      let exited = 0;
      for (let step = 0; step < 30; step++) {
        if (onHand === 0 || rnd(3) === 0) {
          const q = 1 + rnd(50);
          const v = entryValue(q, parseUnitCost(`${rnd(30)}.${String(1 + rnd(9998)).padStart(4, "0")}`));
          onHand += q;
          value += v;
          entered += v;
        } else {
          const q = 1 + rnd(onHand);
          const c = exitCost(value, onHand, q);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(value);
          onHand -= q;
          value -= c;
          exited += c;
          if (onHand === 0) expect(value).toBe(0); // resíduo nunca fica preso sem unidades
        }
      }
      expect(exited + value).toBe(entered);
    }
  });

  it("valores grandes não perdem precisão (produto passa de 2^53 em ponto flutuante)", () => {
    const value = entryValue(10_000, parseUnitCost("999,9999"));
    const c = exitCost(value, 10_000, 3_333);
    expect(Number.isSafeInteger(c)).toBe(true);
    expect(c).toBe(Number((BigInt(value) * 3_333n * 2n + 10_000n) / 20_000n)); // referência em BigInt
    expect(exitCost(value, 10_000, 10_000)).toBe(value);
  });

  it("recusa saída maior que o estoque", () => {
    expect(() => exitCost(1000, 2, 3)).toThrow();
    expect(() => exitCost(1000, 2, 0)).toThrow();
  });
});
