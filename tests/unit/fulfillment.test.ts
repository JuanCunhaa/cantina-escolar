import { describe, expect, it } from "vitest";
import {
  aggregatePreparation,
  aggregateStatus,
  canPrepare,
  csvCell,
  deliverSchema,
  notPickedUpSchema,
  remainingOf,
  resolveSchema,
  toCsv,
  totalsOf,
  deliveryRevenueOf,
  remainingValueOf,
  valueOfUnits,
  type PrepStage,
} from "@/modules/orders/fulfillment-model";
import { statusInfo, statusesOf } from "@/modules/orders/history-model";

const KEY = "chave-de-teste-1";

describe("aggregateStatus (F13): situação agregada determinística", () => {
  const items = (...q: [number, number?, number?][]) => q.map(([quantity, deliveredQty, canceledQty]) => ({ quantity, deliveredQty, canceledQty }));

  it("sem entrega a situação vem do estágio de preparo", () => {
    expect(aggregateStatus({ items: items([2], [1]), prep: "none", nonPickup: null })).toBe("paid");
    expect(aggregateStatus({ items: items([2]), prep: "preparing", nonPickup: null })).toBe("preparing");
    expect(aggregateStatus({ items: items([2]), prep: "ready", nonPickup: null })).toBe("ready");
  });

  it("entrega parcial e total, inclusive com unidades canceladas (F14)", () => {
    expect(aggregateStatus({ items: items([3, 1], [2, 0]), prep: "ready", nonPickup: null })).toBe("partially_delivered");
    expect(aggregateStatus({ items: items([3, 3], [2, 2]), prep: "none", nonPickup: null })).toBe("delivered");
    // um item entregue e o outro todo cancelado: nada mais a entregar → entregue
    expect(aggregateStatus({ items: items([1, 1], [2, 0, 2]), prep: "none", nonPickup: null })).toBe("delivered");
  });

  it("não retirado vence o resto e distingue pendente de encerrado", () => {
    expect(aggregateStatus({ items: items([2, 1]), prep: "ready", nonPickup: { resolved: false } })).toBe("not_picked_up");
    expect(aggregateStatus({ items: items([2, 1]), prep: "ready", nonPickup: { resolved: true } })).toBe("not_picked_up_closed");
  });

  it("é determinística: a mesma entrada dá sempre a mesma situação, qualquer que seja a ordem dos itens", () => {
    for (let a = 0; a <= 3; a++)
      for (let b = 0; b <= 2; b++) {
        const forward = items([3, a], [2, b]);
        const backward = [...forward].reverse();
        for (const prep of ["none", "preparing", "ready"] as PrepStage[]) {
          expect(aggregateStatus({ items: forward, prep, nonPickup: null })).toBe(aggregateStatus({ items: backward, prep, nonPickup: null }));
        }
      }
  });

  it("toda situação produzida tem texto e grupo na tabela do histórico (F12)", () => {
    for (const status of ["paid", "preparing", "ready", "partially_delivered", "delivered", "not_picked_up", "not_picked_up_closed"]) {
      expect(statusInfo(status).label).not.toBe("Em andamento");
    }
    expect(statusesOf("pending")).toEqual(expect.arrayContaining(["partially_delivered", "not_picked_up"]));
    expect(statusesOf("completed")).toEqual(expect.arrayContaining(["delivered", "not_picked_up_closed"]));
  });
});

describe("quantidades e preparo", () => {
  it("restante nunca fica negativo e pedidos anteriores à F13 contam como zero entregue", () => {
    expect(remainingOf({ quantity: 3 })).toBe(3);
    expect(remainingOf({ quantity: 3, deliveredQty: 1, canceledQty: 1 })).toBe(1);
    expect(remainingOf({ quantity: 1, deliveredQty: 1, canceledQty: 1 })).toBe(0);
    expect(totalsOf([{ quantity: 3, deliveredQty: 1 }, { quantity: 2 }])).toEqual({ scheduled: 5, delivered: 1, canceled: 0, exchanged: 0, remaining: 4 });
  });

  it("preparo só avança e só antes da entrega", () => {
    expect(canPrepare("paid", "preparing")).toBe(true);
    expect(canPrepare("paid", "ready")).toBe(true);
    expect(canPrepare("preparing", "ready")).toBe(true);
    expect(canPrepare("preparing", "preparing")).toBe(false);
    expect(canPrepare("ready", "preparing")).toBe(false);
    expect(canPrepare("ready", "ready")).toBe(false);
    for (const status of ["partially_delivered", "delivered", "not_picked_up", "not_picked_up_closed", "cancelled"]) {
      expect(canPrepare(status, "preparing")).toBe(false);
      expect(canPrepare(status, "ready")).toBe(false);
    }
  });

  it("valor das unidades é proporcional ao subtotal pago", () => {
    expect(valueOfUnits({ quantity: 4, subtotalCents: 2000 }, 3)).toBe(1500);
    expect(valueOfUnits({ quantity: 4, subtotalCents: 2000 }, 0)).toBe(0);
  });
});

describe("valores por acumulado (sem deriva de centavos)", () => {
  it("receita das entregas + restante = subtotal pago, mesmo com divisão inexata", () => {
    const line = { quantity: 3, subtotalCents: 100 };
    let delivered = 0;
    let revenue = 0;
    for (let i = 0; i < 3; i++) {
      revenue += deliveryRevenueOf({ ...line, deliveredQty: delivered }, 1);
      delivered += 1;
    }
    expect(revenue).toBe(100); // 33+33+33 perderia 1 centavo
    expect(remainingValueOf({ ...line, deliveredQty: 1 }) + deliveryRevenueOf(line, 1)).toBe(100);
    expect(remainingValueOf({ ...line, deliveredQty: 3 })).toBe(0);
    expect(remainingValueOf({ ...line, deliveredQty: 1, canceledQty: 1 })).toBe(33); // 100 − valor acumulado de 2 un. (67)
  });
});

describe("esquemas dos comandos", () => {
  it("entrega: confirma aluno e pedido, linhas sem repetição, quantidade 1–20, campos desconhecidos recusados", () => {
    const ok = { key: KEY, orderId: "ord_1", studentId: "stu_1", lines: [{ lineNo: 2, quantity: 1 }, { lineNo: 1, quantity: 3 }] };
    const parsed = deliverSchema.parse(ok);
    expect(parsed.lines.map((l) => l.lineNo)).toEqual([1, 2]); // normaliza: mesmo payload → mesmo hash
    expect(deliverSchema.safeParse({ ...ok, studentId: undefined }).success).toBe(false);
    expect(deliverSchema.safeParse({ ...ok, lines: [] }).success).toBe(false);
    expect(deliverSchema.safeParse({ ...ok, lines: [{ lineNo: 1, quantity: 0 }] }).success).toBe(false);
    expect(deliverSchema.safeParse({ ...ok, lines: [{ lineNo: 1, quantity: 21 }] }).success).toBe(false);
    expect(deliverSchema.safeParse({ ...ok, lines: [{ lineNo: 1, quantity: 1 }, { lineNo: 1, quantity: 1 }] }).success).toBe(false);
    expect(deliverSchema.safeParse({ ...ok, totalCents: 1 }).success).toBe(false);
    expect(deliverSchema.safeParse({ ...ok, key: "curta" }).success).toBe(false);
  });

  it("não retirado e resolução exigem motivo; reagendar (F16) exige destino e não aceita descarte", () => {
    expect(notPickedUpSchema.safeParse({ key: KEY, orderId: "ord_1", reason: "ok" }).success).toBe(false);
    expect(notPickedUpSchema.safeParse({ key: KEY, orderId: "ord_1", reason: "Família avisou que não virá" }).success).toBe(true);
    expect(resolveSchema.safeParse({ key: KEY, orderId: "ord_1", resolution: "close_charged" }).success).toBe(false);
    const parsed = resolveSchema.parse({ key: KEY, orderId: "ord_1", resolution: "close_charged", reason: "Política da escola: cobrança mantida" });
    expect(parsed.discards).toEqual([]);
    expect(resolveSchema.safeParse({ key: KEY, orderId: "ord_1", resolution: "invented", reason: "motivo válido" }).success).toBe(false);
    const base = { key: KEY, orderId: "ord_1", resolution: "reschedule", reason: "Aluno faltou; reagendar" };
    expect(resolveSchema.safeParse(base).success).toBe(false); // sem destino
    expect(resolveSchema.safeParse({ ...base, toDate: "2026-10-07", toShiftId: "sh_m" }).success).toBe(true);
    expect(resolveSchema.safeParse({ ...base, toDate: "2026-10-07", toShiftId: "sh_m", discards: [{ lineNo: 1, quantity: 1 }] }).success).toBe(false);
    // Destino/exceção de horário só existem no reagendamento.
    expect(resolveSchema.safeParse({ key: KEY, orderId: "ord_1", resolution: "close_charged", reason: "Política da escola", toDate: "2026-10-07", toShiftId: "sh_m" }).success).toBe(false);
    expect(resolveSchema.safeParse({ key: KEY, orderId: "ord_1", resolution: "cancel_refund", reason: "Política da escola", overrideCutoff: true }).success).toBe(false);
  });
});

describe("painel de preparação", () => {
  const item = (productId: string, quantity: number, deliveredQty = 0, canceledQty = 0) => ({ productId, name: `Produto ${productId}`, quantity, deliveredQty, canceledQty });

  it("soma por produto/data/turno e conserva: agendadas = canceladas + entregues + restantes + não retiradas", () => {
    const rows = aggregatePreparation([
      { consumptionDate: "2026-10-05", shiftId: "m", status: "paid", items: [item("a", 2), item("b", 1)] },
      { consumptionDate: "2026-10-05", shiftId: "m", status: "partially_delivered", items: [item("a", 3, 1)] },
      { consumptionDate: "2026-10-05", shiftId: "m", status: "not_picked_up", items: [item("a", 2, 1)] },
      { consumptionDate: "2026-10-05", shiftId: "t", status: "ready", items: [item("a", 4, 0, 1)] },
      { consumptionDate: "2026-10-06", shiftId: "m", status: "delivered", items: [item("a", 1, 1)] },
    ]);
    const a = rows.find((r) => r.productId === "a" && r.consumptionDate === "2026-10-05" && r.shiftId === "m")!;
    expect(a).toMatchObject({ scheduled: 7, delivered: 2, canceled: 0, remaining: 4, notPickedUp: 1 });
    for (const r of rows) expect(r.scheduled).toBe(r.canceled + r.delivered + r.remaining + r.notPickedUp);
    expect(rows.find((r) => r.shiftId === "t")).toMatchObject({ scheduled: 4, canceled: 1, remaining: 3 });
    expect(rows.map((r) => `${r.consumptionDate}|${r.shiftId}|${r.productId}`)).toEqual(["2026-10-05|m|a", "2026-10-05|m|b", "2026-10-05|t|a", "2026-10-06|m|a"]);
  });
});

describe("exportação CSV", () => {
  it("neutraliza fórmulas de planilha e escapa aspas, separador e quebra de linha", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell('Ana "Lu"')).toBe('"Ana ""Lu"""');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell(-5)).toBe("-5"); // número de verdade não é fórmula
    expect(toCsv([["Produto", "Qtd"], ["Suco; laranja", 3]])).toBe('Produto;Qtd\r\n"Suco; laranja";3');
  });
});
