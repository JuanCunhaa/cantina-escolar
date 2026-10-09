// Projeção diária persistida (F21) — regras puras: digest estável e sensível, partes que respeitam o teto e reconstituem o mesmo dia,
// fusão de dias e o instante em que um dia fecha (10 minutos depois da meia-noite local de America/Sao_Paulo).
import { describe, expect, it } from "vitest";
import { CLOSE_GRACE_MS, PART_MAX_BYTES, canonical, chunkFacts, countsOf, digestOf, emptyDayFacts, isComplete, mergeDayFacts, type DayFacts } from "@/modules/reports/sales-days";
import { closedBefore } from "@/modules/reports/sales-report";
import type { SaleFact } from "@/modules/reports/sales-model";

const sale = (id: string, over: Partial<SaleFact> = {}): SaleFact => ({
  id,
  date: "2026-10-05",
  productId: "p1",
  productName: "Coxinha",
  categoryId: "cat_a",
  channel: "counter",
  shiftId: "turno_m",
  units: 1,
  revenueCents: 200,
  costMicros: 105_000_000,
  origin: `order:${id}`,
  originFound: true,
  ...over,
});
const day = (sales: SaleFact[], extra: Partial<DayFacts> = {}): DayFacts => ({ ...emptyDayFacts(), sales, ...extra });

describe("F21 — digest do dia: estável na ordem de leitura e sensível a qualquer mudança de fato", () => {
  it("a ordem em que o Firestore devolve os documentos não muda o digest", () => {
    const a = sale("m1");
    const b = sale("m2", { productId: "p2" });
    expect(digestOf(day([a, b]))).toBe(digestOf(day([b, a])));
    expect(canonical(day([a, b]))).toBe(canonical(day([b, a])));
  });

  it("propriedade indefinida equivale a ausente; valor, fato a mais, ilegível e truncado mudam o digest", () => {
    const base = digestOf(day([sale("m1")]));
    expect(digestOf(day([{ ...sale("m1"), originPaidCents: undefined }]))).toBe(base);
    expect(digestOf(day([sale("m1", { units: 2 })]))).not.toBe(base);
    expect(digestOf(day([sale("m1", { costMicros: null })]))).not.toBe(base);
    expect(digestOf(day([sale("m1"), sale("m2")]))).not.toBe(base);
    expect(digestOf(day([sale("m1")], { unreadable: { perdas: 1 } }))).not.toBe(base);
    expect(digestOf(day([sale("m1")], { truncated: ["cancelamentos"] }))).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("completo = sem fonte truncada e sem documento ilegível", () => {
    expect(isComplete(day([sale("m1")]))).toBe(true);
    expect(isComplete(day([], { truncated: ["movimentos de estoque"] }))).toBe(false);
    expect(isComplete(day([], { unreadable: { perdas: 2 } }))).toBe(false);
    expect(isComplete(day([], { unreadable: { perdas: 0 } }))).toBe(true);
  });
});

describe("F21 — partes do dia: respeitam o teto e reconstituem exatamente o mesmo dia", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => sale(`m${String(i).padStart(4, "0")}`));

  it("dia pequeno = uma parte; dia vazio também (resumo presente = dia completo)", () => {
    expect(chunkFacts(day(many(3)))).toHaveLength(1);
    expect(chunkFacts(emptyDayFacts())).toHaveLength(1);
  });

  it("com teto pequeno divide em várias partes, nenhuma passa do teto, e juntar devolve o mesmo digest", () => {
    const original = day(many(40), { losses: [{ id: "l1", date: "2026-10-05", productId: "p1", productName: "Coxinha", categoryId: null, reasonCode: "expiry", units: 1, costMicros: 5, origin: "x" }] });
    const parts = chunkFacts(original, 1200);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(Buffer.byteLength(JSON.stringify(p), "utf8")).toBeLessThanOrEqual(1200 + 400); // fatos + moldura (ilegíveis/truncados vazios)
    const joined = mergeDayFacts(parts.map((p) => JSON.parse(JSON.stringify(p)) as DayFacts));
    expect(digestOf(joined)).toBe(digestOf(original));
    expect(countsOf(joined)).toEqual(countsOf(original));
  });

  it("ilegíveis e truncados acompanham a primeira parte; um fato maior que o teto é recusado em vez de cortado", () => {
    const parts = chunkFacts(day(many(30), { unreadable: { perdas: 1 }, truncated: ["cancelamentos"] }), 1000);
    expect(parts[0]!.unreadable).toEqual({ perdas: 1 });
    expect(parts[0]!.truncated).toEqual(["cancelamentos"]);
    expect(parts.slice(1).every((p) => Object.keys(p.unreadable).length === 0 && p.truncated.length === 0)).toBe(true);
    expect(() => chunkFacts(day([sale("m1", { productName: "x".repeat(2000) })]), 500)).toThrow(RangeError);
    expect(PART_MAX_BYTES).toBeLessThan(1_048_487); // cabe num documento do Firestore
  });
});

describe("F21 — fusão de dias", () => {
  it("concatena fatos, soma ilegíveis e une truncados sem repetir", () => {
    const merged = mergeDayFacts([day([sale("a")], { unreadable: { perdas: 1 }, truncated: ["x"] }), day([sale("b")], { unreadable: { perdas: 2, ajustes: 1 }, truncated: ["x", "y"] }), emptyDayFacts()]);
    expect(merged.sales.map((s) => s.id)).toEqual(["a", "b"]);
    expect(merged.unreadable).toEqual({ perdas: 3, ajustes: 1 });
    expect(merged.truncated).toEqual(["x", "y"]);
  });
});

describe("F21 — quando um dia fecha (America/Sao_Paulo, UTC−3)", () => {
  it("10 minutos depois da meia-noite local; antes disso o dia anterior ainda é lido ao vivo", () => {
    expect(CLOSE_GRACE_MS).toBe(600_000);
    expect(closedBefore(new Date("2026-10-09T03:09:59Z"))).toBe("2026-10-08"); // 00:09:59 local: 08/10 ainda não fechou
    expect(closedBefore(new Date("2026-10-09T03:10:00Z"))).toBe("2026-10-09"); // 00:10:00 local: 08/10 fechou
    expect(closedBefore(new Date("2026-10-09T14:00:00Z"))).toBe("2026-10-09"); // meio do dia: só hoje está aberto
    expect(closedBefore(new Date("2026-10-09T02:59:00Z"))).toBe("2026-10-08"); // 23:59 de 08/10 local
  });
});
