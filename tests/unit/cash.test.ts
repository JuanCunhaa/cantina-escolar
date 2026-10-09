import { describe, expect, it } from "vitest";
import {
  backfillRange,
  closeSchema,
  computeClosing,
  methodTotals,
  movementsAfterClose,
  openSchema,
  pointAllowed,
  reviewSchema,
  sessionIdOf,
  type CashLineReceipt,
} from "@/modules/cash/cash-model";

const line = (ref: string, method: CashLineReceipt["method"], grossCents: number, reversedCents = 0): CashLineReceipt => ({ ref, kind: "topup", method, grossCents, reversedCents });

describe("F20 — fechamento de caixa (tolerância ZERO; só dinheiro físico é contado)", () => {
  const receipts = [line("topup:a", "cash", 5000), line("topup:b", "cash", 2000, 2000), line("topup:c", "pix", 3000), line("direct_sale:d", "card_credit", 1500), line("direct_sale:e", "card_debit", 700)];

  it("esperado = saldo inicial + dinheiro recebido − estornado; Pix e cartão não entram na gaveta", () => {
    const c = computeClosing({ openingCents: 10_000, receipts, countedCashCents: 15_000 });
    expect(c.expectedCashCents).toBe(15_000); // 10.000 + 5.000 + (2.000 − 2.000)
    expect(c.cashDifferenceCents).toBe(0);
    expect(c.hasDivergence).toBe(false);
    expect(c.byMethod.find((m) => m.method === "pix")).toMatchObject({ receiptCount: 1, grossCents: 3000, netCents: 3000 });
    expect(c.byMethod.find((m) => m.method === "cash")).toMatchObject({ receiptCount: 2, grossCents: 7000, reversedCents: 2000, netCents: 5000 });
    expect(c.receiptCount).toBe(5);
  });

  it("qualquer diferença — 1 centavo, para mais ou para menos — é divergência (tolerância inicial zero)", () => {
    expect(computeClosing({ openingCents: 10_000, receipts, countedCashCents: 14_999 })).toMatchObject({ cashDifferenceCents: -1, hasDivergence: true, largestDifferenceCents: 1 });
    expect(computeClosing({ openingCents: 10_000, receipts, countedCashCents: 15_001 })).toMatchObject({ cashDifferenceCents: 1, hasDivergence: true });
  });

  it("conferências declaradas de Pix/cartão são comparadas ao líquido por meio; ausentes não são conferidas", () => {
    const ok = computeClosing({ openingCents: 0, receipts, countedCashCents: 5000, declared: { pixCents: 3000, cardCreditCents: 1500 } });
    expect(ok.hasDivergence).toBe(false);
    expect(ok.declared).toEqual({ pix: { declaredCents: 3000, expectedCents: 3000, differenceCents: 0 }, card_credit: { declaredCents: 1500, expectedCents: 1500, differenceCents: 0 } });
    const diff = computeClosing({ openingCents: 0, receipts, countedCashCents: 5000, declared: { cardDebitCents: 650 } });
    expect(diff.hasDivergence).toBe(true);
    expect(diff.declared.card_debit).toEqual({ declaredCents: 650, expectedCents: 700, differenceCents: -50 });
    expect(diff.declared.pix).toBeUndefined();
  });

  it("sem recebimentos: esperado é o saldo inicial", () => {
    expect(computeClosing({ openingCents: 2500, receipts: [], countedCashCents: 2500 })).toMatchObject({ expectedCashCents: 2500, hasDivergence: false, receiptCount: 0 });
    expect(methodTotals([]).every((m) => m.grossCents === 0 && m.receiptCount === 0)).toBe(true);
  });

  it("estorno total de recebimento em dinheiro zera o esperado daquele recebimento (não sobra nem falta)", () => {
    expect(computeClosing({ openingCents: 0, receipts: [line("topup:a", "cash", 5000, 5000)], countedCashCents: 0 }).hasDivergence).toBe(false);
  });
});

describe("F20 — movimentos posteriores ao fechamento são IDENTIFICADOS, nunca reescritos", () => {
  const closed = [line("topup:a", "cash", 5000), line("topup:c", "pix", 3000)];

  it("recebimento novo e estorno que cresceu depois aparecem; o resto não", () => {
    const now = [line("topup:a", "cash", 5000, 1000), line("topup:c", "pix", 3000), line("topup:z", "cash", 800)];
    const after = movementsAfterClose(closed, now);
    expect(after.newReceipts).toEqual([{ ref: "topup:z", method: "cash", grossCents: 800 }]);
    expect(after.newReversals).toEqual([{ ref: "topup:a", method: "cash", addedCents: 1000 }]);
    expect(after.count).toBe(2);
  });

  it("nada novo = nenhum movimento posterior", () => {
    expect(movementsAfterClose(closed, closed).count).toBe(0);
  });
});

describe("F20 — operador, ponto e data", () => {
  it("o ID da sessão carrega o UID: um operador não consegue montar o ID do caixa de outro", () => {
    expect(sessionIdOf("2026-10-09", "secretaria", "uidA")).toBe("2026-10-09__secretaria__uidA");
    expect(sessionIdOf("2026-10-09", "secretaria", "uidA")).not.toBe(sessionIdOf("2026-10-09", "secretaria", "uidB"));
    expect(sessionIdOf("2026-10-09", "counter", "uidA")).not.toBe(sessionIdOf("2026-10-09", "secretaria", "uidA"));
  });

  it("secretaria na secretaria, cantina no balcão, administração em ambos; guardião e aluno em nenhum", () => {
    expect(pointAllowed("secretaria", "secretaria")).toBe(true);
    expect(pointAllowed("secretaria", "counter")).toBe(false);
    expect(pointAllowed("cantina", "counter")).toBe(true);
    expect(pointAllowed("cantina", "secretaria")).toBe(false);
    expect(pointAllowed("admin", "secretaria") && pointAllowed("admin", "counter")).toBe(true);
    expect(pointAllowed("guardian", "counter") || pointAllowed("student", "secretaria") || pointAllowed(null, "counter")).toBe(false);
  });

  it("abertura retroativa só até 7 dias", () => {
    expect(backfillRange("2026-10-09")).toEqual({ min: "2026-10-02", max: "2026-10-09" });
  });
});

describe("F20 — entradas dos comandos de caixa", () => {
  const open = { key: "chave-1234", point: "secretaria", openingCents: 5000, openingConfirmed: true };

  it("abertura exige confirmação do saldo inicial e aceita só centavos inteiros", () => {
    expect(openSchema.safeParse(open).success).toBe(true);
    expect(openSchema.safeParse({ ...open, openingConfirmed: false }).success).toBe(false);
    expect(openSchema.safeParse({ ...open, openingConfirmed: undefined }).success).toBe(false);
    expect(openSchema.safeParse({ ...open, openingCents: 12.5 }).success).toBe(false);
    expect(openSchema.safeParse({ ...open, openingCents: -1 }).success).toBe(false);
    expect(openSchema.safeParse({ ...open, point: "online" }).success).toBe(false);
    expect(openSchema.safeParse({ ...open, operatorUid: "outro" }).success).toBe(false); // esquema estrito: o UID nunca vem do cliente
  });

  it("fechamento conta pelo TOTAL (sem cédulas) e recusa campos extras", () => {
    const close = { key: "chave-1234", sessionId: "2026-10-09__secretaria__u1", countedCashCents: 15_000 };
    expect(closeSchema.safeParse(close).success).toBe(true);
    expect(closeSchema.safeParse({ ...close, notes: { 100: 3 } }).success).toBe(false);
    expect(closeSchema.safeParse({ ...close, countedCashCents: -5 }).success).toBe(false);
  });

  it("revisão exige decisão conhecida e nota", () => {
    const review = { key: "chave-1234", sessionId: "2026-10-09__secretaria__u1", closureNo: 1, decision: "approved", note: "Conferido com o operador" };
    expect(reviewSchema.safeParse(review).success).toBe(true);
    expect(reviewSchema.safeParse({ ...review, decision: "adjust" }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...review, note: "ok" }).success).toBe(false);
  });
});
