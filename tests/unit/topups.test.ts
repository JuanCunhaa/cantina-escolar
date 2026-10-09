import { describe, expect, it } from "vitest";
import { amountsOf, familyOf, normalizeReference, planReversal, reversalEntryReason, settlementOf, topupEntryReason, topupSchema } from "@/modules/payments/topup-model";
import { DomainError } from "@/lib/domain-error";
import { referenceKeyId } from "@/modules/payments/topup-keys";

const base = { key: "k-12345678", studentId: "stu_1", amountCents: 5000, method: "pix" as const, receivedConfirmed: true as const, reference: "E2E-0001" };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : "other";
  }
  return null;
};

describe("recarga manual — regras puras (F17)", () => {
  it("A04: crédito = bruto; taxa só reduz o líquido (R$ 50 − R$ 1,50 = R$ 48,50)", () => {
    expect(amountsOf({ amountCents: 5000, method: "pix", feeCents: 150 })).toEqual({ grossCents: 5000, creditedCents: 5000, fee: { status: "informed", cents: 150, source: "operator" }, netCents: 4850 });
    expect(amountsOf({ amountCents: 5000, method: "card_credit" })).toMatchObject({ creditedCents: 5000, fee: { status: "pending", cents: null }, netCents: null });
    expect(amountsOf({ amountCents: 5000, method: "cash" })).toMatchObject({ creditedCents: 5000, fee: { status: "none", cents: 0 }, netCents: 5000 });
  });

  it("aprovação de cartão ≠ liquidação; Pix conferido liquidado; dinheiro no caixa", () => {
    expect(settlementOf("card_debit", "2026-10-05", "2026-10-06")).toEqual({ status: "pending", expectedOn: "2026-10-06", settledOn: null, expectedSource: "operator" });
    expect(settlementOf("card_credit", "2026-10-05", undefined)).toEqual({ status: "pending", expectedOn: null, settledOn: null, expectedSource: null });
    expect(settlementOf("pix", "2026-10-05", undefined)).toEqual({ status: "settled", expectedOn: null, settledOn: "2026-10-05", expectedSource: null });
    // F20: sem data do operador, a previsão vem da regra em vigor
    const rule = { on: "2026-11-04", days: 30, basis: "calendar_days" as const, ruleVersion: 1 };
    expect(settlementOf("card_credit", "2026-10-05", undefined, rule)).toEqual({ status: "pending", expectedOn: "2026-11-04", settledOn: null, expectedSource: "rule", expectedBasis: "calendar_days", expectedDays: 30, expectedRuleVersion: 1 });
    expect(settlementOf("card_credit", "2026-10-05", "2026-10-20", rule)).toEqual({ status: "pending", expectedOn: "2026-10-20", settledOn: null, expectedSource: "operator" }); // a data digitada vale e não carrega base
    expect(settlementOf("card_credit", "2026-10-05", undefined, null)).toEqual({ status: "pending", expectedOn: null, settledOn: null, expectedSource: null }); // sem prazo configurado: pendente
    expect(settlementOf("cash", "2026-10-05", undefined).status).toBe("cash_on_hand");
  });

  it("referência: normalização estável e escopo por família de meio (débito e crédito juntos)", () => {
    expect(normalizeReference(" e2e-12 34/ab ")).toBe("E2E1234AB");
    expect(familyOf("card_debit")).toBe(familyOf("card_credit"));
    expect(referenceKeyId("pix", "ABC1")).toBe(referenceKeyId("pix", normalizeReference("abc-1")));
    expect(referenceKeyId("pix", "ABC1")).not.toBe(referenceKeyId("card", "ABC1"));
    expect(referenceKeyId("pix", "ABC1")).toMatch(/^topupRef_[0-9a-f]{40}$/);
  });

  it("schema: confirmação obrigatória, referência em Pix/cartão, taxa ≤ valor e nunca em dinheiro, sem campos extras", () => {
    expect(topupSchema.safeParse(base).success).toBe(true);
    expect(topupSchema.safeParse({ ...base, method: "cash", reference: undefined }).success).toBe(true);
    for (const bad of [
      { ...base, receivedConfirmed: false },
      { ...base, reference: undefined },
      { ...base, reference: "--" },
      { ...base, method: "cash", reference: "ab" },
      { ...base, feeCents: 5001 },
      { ...base, method: "cash", reference: undefined, feeCents: 1 },
      { ...base, amountCents: 99 },
      { ...base, amountCents: 200_001 },
      { ...base, expectedSettlementOn: "2026-10-10" },
      { ...base, balanceCents: 1 },
    ]) {
      expect(topupSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(topupSchema.safeParse({ ...base, method: "card_credit", expectedSettlementOn: "2026-11-04" }).success).toBe(true);
  });

  it("estorno: ≤ restante, ≤ saldo (sem negativo), tela desatualizada, total libera referência só por lançamento incorreto", () => {
    const t = { amountCents: 5000, reversedCents: 0, hasReference: true };
    expect(planReversal(t, 5000, { amountCents: 5000, reasonCode: "registration_error", expectedReversedCents: 0 })).toEqual({ reversedAfterCents: 5000, reversibleAfterCents: 0, status: "reversed", releaseReference: true });
    expect(planReversal(t, 5000, { amountCents: 5000, reasonCode: "payment_returned", expectedReversedCents: 0 }).releaseReference).toBe(false);
    expect(planReversal(t, 5000, { amountCents: 2000, reasonCode: "registration_error", expectedReversedCents: 0 })).toMatchObject({ status: "partially_reversed", releaseReference: false, reversibleAfterCents: 3000 });
    expect(code(() => planReversal(t, 5000, { amountCents: 5001, reasonCode: "registration_error", expectedReversedCents: 0 }))).toBe("exceeds_reversible");
    expect(code(() => planReversal(t, 1200, { amountCents: 2000, reasonCode: "registration_error", expectedReversedCents: 0 }))).toBe("insufficient_balance");
    expect(code(() => planReversal({ ...t, reversedCents: 1000 }, 5000, { amountCents: 1, reasonCode: "registration_error", expectedReversedCents: 0 }))).toBe("stale_topup");
    expect(code(() => planReversal({ ...t, reversedCents: 5000 }, 5000, { amountCents: 1, reasonCode: "registration_error", expectedReversedCents: 5000 }))).toBe("already_reversed");
  });

  it("propriedade: qualquer sequência de estornos aceitos nunca passa do valor nem do saldo", () => {
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n) + 1;
    for (let round = 0; round < 200; round++) {
      const amount = rand(20000);
      let reversed = 0;
      let balance = amount + rand(5000) - rand(5000);
      balance = Math.max(0, balance);
      for (let step = 0; step < 6; step++) {
        const ask = rand(amount);
        try {
          const plan = planReversal({ amountCents: amount, reversedCents: reversed, hasReference: false }, balance, { amountCents: ask, reasonCode: "payment_not_received", expectedReversedCents: reversed });
          reversed = plan.reversedAfterCents;
          balance -= ask;
        } catch {
          /* recusa: nada muda */
        }
        expect(reversed).toBeLessThanOrEqual(amount);
        expect(balance).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("textos do extrato da família: meio e data, sem referência nem motivo interno", () => {
    expect(topupEntryReason("pix")).toBe("Recarga na secretaria · Pix");
    expect(reversalEntryReason("2026-10-05")).toBe("Estorno de recarga de 05/10/2026");
  });
});
