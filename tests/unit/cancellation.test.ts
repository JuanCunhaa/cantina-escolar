import { describe, expect, it } from "vitest";
import { decideStudentAction } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import {
  aggregateStatus,
  cancelSchema,
  deliveryRevenueOf,
  refundValueOf,
  remainingOf,
  remainingValueOf,
  resolveSchema,
  valueOfUnits,
} from "@/modules/orders/fulfillment-model";
import { statusInfo } from "@/modules/orders/history-model";

const KEY = "chave-de-teste-1";

describe("cancelSchema (F14)", () => {
  const ok = { key: KEY, orderId: "ord_1", reason: "Mudança de planos" };

  it("motivo obrigatório (mínimo 5), campos desconhecidos recusados e `lines` ausente = cancelar tudo", () => {
    expect(cancelSchema.safeParse({ key: KEY, orderId: "ord_1" }).success).toBe(false);
    expect(cancelSchema.safeParse({ ...ok, reason: "ok" }).success).toBe(false);
    expect(cancelSchema.safeParse({ ...ok, refundCents: 1 }).success).toBe(false); // o cliente não informa valor
    expect(cancelSchema.safeParse({ ...ok, studentId: "x" }).success).toBe(false);
    const total = cancelSchema.parse(ok);
    expect(total.lines).toBeUndefined();
    expect(total.discards).toEqual([]);
  });

  it("parcial: linhas sem repetição, quantidade 1–20, ordem normalizada (mesmo payload → mesmo hash)", () => {
    const parsed = cancelSchema.parse({ ...ok, lines: [{ lineNo: 2, quantity: 1 }, { lineNo: 1, quantity: 3 }] });
    expect(parsed.lines!.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(cancelSchema.safeParse({ ...ok, lines: [] }).success).toBe(false);
    expect(cancelSchema.safeParse({ ...ok, lines: [{ lineNo: 1, quantity: 0 }] }).success).toBe(false);
    expect(cancelSchema.safeParse({ ...ok, lines: [{ lineNo: 1, quantity: 1 }, { lineNo: 1, quantity: 2 }] }).success).toBe(false);
    expect(cancelSchema.safeParse({ ...ok, discards: [{ lineNo: 1, quantity: 1 }, { lineNo: 1, quantity: 1 }] }).success).toBe(false);
  });

  it("a resolução cancel_refund é aceita e o reagendamento segue aceito só no esquema (recusado pelo comando)", () => {
    expect(resolveSchema.parse({ key: KEY, orderId: "ord_1", resolution: "cancel_refund", reason: "Política da escola" }).resolution).toBe("cancel_refund");
  });
});

describe("situação agregada com cancelamento (F14)", () => {
  const items = (...q: [number, number?, number?][]) => q.map(([quantity, deliveredQty, canceledQty]) => ({ quantity, deliveredQty, canceledQty }));

  it("tudo cancelado e nada entregue = cancelled; cancelamento parcial NÃO muda a situação do que sobrou", () => {
    expect(aggregateStatus({ items: items([2, 0, 2], [1, 0, 1]), prep: "none", nonPickup: null })).toBe("cancelled");
    expect(aggregateStatus({ items: items([2, 0, 1]), prep: "none", nonPickup: null })).toBe("paid");
    expect(aggregateStatus({ items: items([2, 0, 1]), prep: "ready", nonPickup: null })).toBe("ready");
    expect(aggregateStatus({ items: items([3, 1, 1]), prep: "none", nonPickup: null })).toBe("partially_delivered");
  });

  it("entregue + restante cancelado = entregue (nunca cancelled)", () => {
    expect(aggregateStatus({ items: items([3, 2, 1]), prep: "none", nonPickup: null })).toBe("delivered");
  });

  it("cancelled tem texto e vai para a aba de cancelados", () => {
    expect(statusInfo("cancelled")).toMatchObject({ group: "cancelled", label: expect.stringContaining("Cancelado") });
  });
});

describe("reembolso pelo valor PAGO, rateado por acumulado (sem deriva de centavos)", () => {
  type Line = { quantity: number; subtotalCents: number; deliveredQty: number; canceledQty: number };
  const fresh = (quantity: number, subtotalCents: number): Line => ({ quantity, subtotalCents, deliveredQty: 0, canceledQty: 0 });

  it("o reembolso usa o subtotal gravado: o preço atual do produto nunca entra", () => {
    // Comprado a R$ 8,00 (2 un. = 1600); o cadastro passar a R$ 9,00 não aparece em nenhum cálculo (só há snapshot).
    expect(refundValueOf(fresh(2, 1600), 1)).toBe(800);
    expect(refundValueOf(fresh(2, 1600), 2)).toBe(1600);
  });

  it("valor por unidade fracionário (desconto rateado): Σ reembolsos = valor pago, a diferença de centavos fica na última fatia", () => {
    const line = fresh(3, 1000); // 1000 / 3 = 333,33…
    const first = refundValueOf(line, 1);
    const afterFirst = { ...line, canceledQty: 1 };
    const second = refundValueOf(afterFirst, 1);
    const afterSecond = { ...line, canceledQty: 2 };
    const third = refundValueOf(afterSecond, 1);
    expect([first, second, third]).toEqual([333, 334, 333]);
    expect(first + second + third).toBe(1000);
    expect(remainingValueOf({ ...line, canceledQty: 3 })).toBe(0);
  });

  it("propriedade: em QUALQUER ordem de entregas e cancelamentos, Σ receita + Σ reembolsos = pago, nunca negativo e nunca acima do restante", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 400; round++) {
      const quantity = 1 + rand(12);
      const subtotalCents = quantity + rand(5000); // ≥ 1 centavo por unidade
      let line: Line = fresh(quantity, subtotalCents);
      let revenue = 0;
      let refunded = 0;
      while (remainingOf(line) > 0) {
        const units = 1 + rand(remainingOf(line));
        const cancel = rand(2) === 0;
        const before = remainingValueOf(line);
        const amount = cancel ? refundValueOf(line, units) : deliveryRevenueOf(line, units);
        expect(amount).toBeGreaterThanOrEqual(1);
        expect(amount).toBeLessThanOrEqual(before);
        if (cancel) {
          refunded += amount;
          line = { ...line, canceledQty: line.canceledQty + units };
        } else {
          revenue += amount;
          line = { ...line, deliveredQty: line.deliveredQty + units };
        }
        expect(remainingValueOf(line)).toBe(before - amount);
      }
      expect(revenue + refunded).toBe(subtotalCents);
      expect(remainingValueOf(line)).toBe(0);
      expect(valueOfUnits(line, quantity)).toBe(subtotalCents);
    }
  });
});

describe("quem pode cancelar (decisão com vínculo/perfil atuais)", () => {
  const link = (uid: string, status = "active") => ({ guardianUid: uid, studentId: "stu", status });
  const decide = (actor: { uid: string; role: "guardian" | "student" | "cantina" | "admin" | "secretaria" }, over: { student?: object; link?: object } = {}) =>
    decideStudentAction({ actor, studentId: "stu", action: "orders.cancel", student: over.student ?? { status: "active", userUid: "stu" }, link: over.link, policy: { allowSitePurchase: true } });

  it("só o responsável com vínculo ativo; o aluno não cancela sozinho, nem com permissão de compra", () => {
    expect(decide({ uid: "g", role: "guardian" }, { link: link("g") })).toBe(true);
    expect(decide({ uid: "g", role: "guardian" }, { link: link("g", "revoked") })).toBe(false);
    expect(decide({ uid: "g", role: "guardian" }, { link: link("outro") })).toBe(false);
    expect(decide({ uid: "g", role: "guardian" })).toBe(false);
    expect(decide({ uid: "stu", role: "student" })).toBe(false);
    for (const role of ["cantina", "secretaria", "admin"] as const) expect(decide({ uid: "x", role })).toBe(false); // equipe usa a capacidade, não o vínculo
  });

  it("aluno arquivado: o responsável vinculado ainda cancela (o reembolso vai à carteira original)", () => {
    expect(decide({ uid: "g", role: "guardian" }, { link: link("g"), student: { status: "archived" } })).toBe(true);
  });

  it("capacidade operacional: cantina e administração; secretaria e família não", () => {
    expect(can({ role: "cantina" }, "orders.cancel")).toBe(true);
    expect(can({ role: "admin" }, "orders.cancel")).toBe(true);
    expect(can({ role: "secretaria", permissions: ["topup.reverse"] }, "orders.cancel")).toBe(false);
    expect(can({ role: "guardian" }, "orders.cancel")).toBe(false);
    expect(can({ role: "cantina" }, "orders.resolve")).toBe(false); // resolver continua só da administração
  });
});
