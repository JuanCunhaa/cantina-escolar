import { describe, expect, it } from "vitest";
import { weekEndOf, weekStartOf } from "@/lib/dates/school-time";
import { evaluatePurchasePolicy, type EvaluateInput, type PurchaseLine } from "@/modules/policies/evaluate";
import { parsePolicy, setPolicySchema, type PolicyException, type StudentPolicy } from "@/modules/policies/model";

// 2026-10-05 é segunda-feira; 2026-10-11 é domingo; 2026-10-12 é segunda.
const POLICY: StudentPolicy = {
  allowSitePurchase: true,
  allowCounterPurchase: true,
  dailyLimitCents: 1000,
  weeklyLimitCents: null,
  blockedProductIds: [],
  blockedCategoryIds: [],
  configVersion: 1,
};
const line = (consumptionDate: string, amountCents: number, productId = "prd_a", categoryId = "cat_a"): PurchaseLine => ({ consumptionDate, productId, categoryId, amountCents });

function evaluate(over: Partial<EvaluateInput> & { lines: PurchaseLine[] }) {
  return evaluatePurchasePolicy({
    channel: "advance",
    actorKind: "student",
    permitted: true,
    policy: POLICY,
    usage: { days: {}, weeks: {} },
    ...over,
  });
}

describe("semana padrão segunda a domingo no fuso da escola", () => {
  it("a semana começa na segunda e termina no domingo; domingo pertence à semana que termina nele", () => {
    expect(weekStartOf("2026-10-05")).toBe("2026-10-05");
    expect(weekStartOf("2026-10-07")).toBe("2026-10-05");
    expect(weekStartOf("2026-10-11")).toBe("2026-10-05");
    expect(weekStartOf("2026-10-12")).toBe("2026-10-12");
    expect(weekEndOf("2026-10-05")).toBe("2026-10-11");
  });
  it("atravessa mês e ano", () => {
    expect(weekStartOf("2026-12-31")).toBe("2026-12-28");
    expect(weekStartOf("2027-01-03")).toBe("2026-12-28");
    expect(weekEndOf("2026-12-28")).toBe("2027-01-03");
  });
});

describe("A10 — limite diário por DATA DO CONSUMO", () => {
  it("R$ 10 em cada dia diferente é permitido: cada data tem o próprio teto, não o dia do pagamento", () => {
    const result = evaluate({ lines: [line("2026-10-05", 1000), line("2026-10-06", 1000), line("2026-10-07", 1000)] });
    expect(result).toMatchObject({ allowed: true, violations: [], totalCents: 3000, override: null });
    expect(result.days.map((d) => [d.key, d.afterCents, d.exceeds])).toEqual([
      ["2026-10-05", 1000, false],
      ["2026-10-06", 1000, false],
      ["2026-10-07", 1000, false],
    ]);
  });
  it("R$ 10 + R$ 1 na MESMA data excede só aquela data", () => {
    const result = evaluate({ lines: [line("2026-10-05", 1000), line("2026-10-05", 1), line("2026-10-06", 1000)] });
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([{ kind: "daily_limit_exceeded", date: "2026-10-05", limitCents: 1000, committedCents: 0, requestedCents: 1001 }]);
  });
  it("sem teto configurado = sem teto parental (não é saldo infinito: o saldo é verificado pelo comando)", () => {
    const result = evaluate({ policy: { ...POLICY, dailyLimitCents: null }, lines: [line("2026-10-05", 99_999)] });
    expect(result.allowed).toBe(true);
    expect(result.days[0]).toMatchObject({ limitCents: null, remainingBeforeCents: null, exceeds: false });
  });
});

describe("A11 — comprometimento e balcão", () => {
  const usage = { days: { "2026-10-05": 800 }, weeks: { "2026-10-05": 800 } };
  it("R$ 8 comprometidos deixam R$ 2 no balcão: R$ 2 cabem (teto exato), R$ 3 são rejeitados", () => {
    const base = { channel: "counter" as const, actorKind: "staff" as const, usage };
    const fits = evaluate({ ...base, lines: [line("2026-10-05", 200)] });
    expect(fits.allowed).toBe(true);
    expect(fits.days[0]).toMatchObject({ committedCents: 800, remainingBeforeCents: 200, afterCents: 1000 });
    const denied = evaluate({ ...base, lines: [line("2026-10-05", 300)] });
    expect(denied).toMatchObject({ allowed: false, needsConfirmation: false });
    expect(denied.violations).toEqual([{ kind: "daily_limit_exceeded", date: "2026-10-05", limitCents: 1000, committedCents: 800, requestedCents: 300 }]);
  });
  it("limite semanal considera a semana do consumo: outra semana não é afetada e o intervalo é informado", () => {
    const policy = { ...POLICY, dailyLimitCents: null, weeklyLimitCents: 2000 };
    const weekUsage = { days: {}, weeks: { "2026-10-05": 1800 } };
    const inFull = evaluate({ policy, usage: weekUsage, lines: [line("2026-10-09", 300)] });
    expect(inFull.allowed).toBe(false);
    expect(inFull.violations).toEqual([
      { kind: "weekly_limit_exceeded", weekStart: "2026-10-05", weekEnd: "2026-10-11", limitCents: 2000, committedCents: 1800, requestedCents: 300 },
    ]);
    // Domingo ainda é a mesma semana; segunda seguinte é outra semana, com o próprio teto.
    expect(evaluate({ policy, usage: weekUsage, lines: [line("2026-10-11", 300)] }).allowed).toBe(false);
    expect(evaluate({ policy, usage: weekUsage, lines: [line("2026-10-12", 2000)] }).allowed).toBe(true);
  });
  it("reembolso libera: o mesmo pedido volta a caber quando o comprometimento cai", () => {
    expect(evaluate({ usage, lines: [line("2026-10-05", 300)] }).allowed).toBe(false);
    expect(evaluate({ usage: { days: { "2026-10-05": 500 }, weeks: {} }, lines: [line("2026-10-05", 300)] }).allowed).toBe(true);
  });
  it("reagendar para outro dia/semana revalida o destino: dia cheio nega, dia livre permite", () => {
    const full = { days: { "2026-10-06": 1000 }, weeks: {} };
    expect(evaluate({ usage: full, lines: [line("2026-10-06", 100)] }).allowed).toBe(false);
    expect(evaluate({ usage: full, lines: [line("2026-10-07", 100)] }).allowed).toBe(true);
  });
});

describe("A08/A09 — permissões e bloqueios", () => {
  it("canal sem permissão (decisão canônica de autorização) nega sem sugerir confirmação nem aceitar exceção", () => {
    const ex: PolicyException = { id: "e1", studentId: "s", kind: "admin", status: "active", consumptionDate: "2026-10-05", maxCents: 5000 };
    const result = evaluate({ permitted: false, actorKind: "guardian", confirmed: true, exception: ex, lines: [line("2026-10-05", 100)] });
    expect(result).toMatchObject({ allowed: false, needsConfirmation: false, override: null });
    expect(result.violations).toEqual([{ kind: "channel_not_allowed", channel: "advance" }]);
  });
  it("produto e categoria bloqueados negam o aluno (site e balcão)", () => {
    const policy = { ...POLICY, blockedProductIds: ["prd_x"], blockedCategoryIds: ["cat_y"] };
    for (const channel of ["advance", "counter"] as const) {
      const result = evaluate({ channel, actorKind: channel === "advance" ? "student" : "staff", policy, lines: [line("2026-10-05", 100, "prd_x", "cat_a"), line("2026-10-05", 100, "prd_b", "cat_y")] });
      expect(result.allowed).toBe(false);
      expect(result.violations).toEqual([
        { kind: "product_blocked", productId: "prd_x" },
        { kind: "category_blocked", categoryId: "cat_y" },
      ]);
    }
    expect(evaluate({ policy, lines: [line("2026-10-05", 100, "prd_ok", "cat_ok")] }).allowed).toBe(true);
  });
  it("responsável: sem confirmação pede confirmação mostrando o efeito; com confirmação passa e continua contando como consumo", () => {
    const policy = { ...POLICY, blockedProductIds: ["prd_x"] };
    const usage = { days: { "2026-10-05": 900 }, weeks: {} };
    const lines = [line("2026-10-05", 300, "prd_x")];
    const ask = evaluate({ actorKind: "guardian", policy, usage, lines });
    expect(ask).toMatchObject({ allowed: false, needsConfirmation: true });
    expect(ask.days[0]).toMatchObject({ committedCents: 900, requestedCents: 300, afterCents: 1200, limitCents: 1000, exceeds: true });
    const done = evaluate({ actorKind: "guardian", policy, usage, lines, confirmed: true });
    expect(done).toMatchObject({ allowed: true, needsConfirmation: false, override: { via: "guardian_confirmation" } });
    expect(done.violations.map((v) => v.kind)).toEqual(["product_blocked", "daily_limit_exceeded"]);
    expect(done.days[0]!.afterCents).toBe(1200);
  });
  it("funcionário/aluno não superam a política só por confirmação; exceção ativa da data e do valor permite", () => {
    const policy = { ...POLICY, blockedProductIds: ["prd_x"] };
    const lines = [line("2026-10-05", 300, "prd_x")];
    expect(evaluate({ actorKind: "staff", channel: "counter", policy, lines, confirmed: true })).toMatchObject({ allowed: false, needsConfirmation: false });
    const ex = (over: Partial<PolicyException> = {}): PolicyException => ({ id: "e1", studentId: "s", kind: "guardian", status: "active", consumptionDate: "2026-10-05", maxCents: 300, ...over });
    expect(evaluate({ actorKind: "staff", channel: "counter", policy, lines, exception: ex() })).toMatchObject({ allowed: true, override: { via: "exception", exceptionId: "e1", kind: "guardian" } });
    // Fora de escopo: outra data, valor acima, já usada, revogada.
    for (const bad of [ex({ consumptionDate: "2026-10-06" }), ex({ maxCents: 299 }), ex({ status: "used" }), ex({ status: "revoked" })]) {
      expect(evaluate({ actorKind: "staff", channel: "counter", policy, lines, exception: bad }).allowed).toBe(false);
    }
  });
  it("valor inválido ou carrinho vazio nunca é permitido", () => {
    expect(evaluate({ lines: [] }).allowed).toBe(false);
    expect(evaluate({ lines: [line("2026-10-05", 0)] }).allowed).toBe(false);
    expect(evaluate({ lines: [line("2026-10-05", 1.5)] }).allowed).toBe(false);
  });
});

describe("modelo de política", () => {
  it("documento ausente ou parcial = tudo negado, sem tetos e sem bloqueios", () => {
    expect(parsePolicy(undefined)).toEqual({
      allowSitePurchase: false,
      allowCounterPurchase: false,
      dailyLimitCents: null,
      weeklyLimitCents: null,
      blockedProductIds: [],
      blockedCategoryIds: [],
      configVersion: 0,
    });
    expect(parsePolicy({ allowSitePurchase: true, dailyLimitCents: -5, weeklyLimitCents: 12.5, blockedProductIds: ["b", "a", "a", 3] })).toMatchObject({
      allowSitePurchase: true,
      dailyLimitCents: null,
      weeklyLimitCents: null,
      blockedProductIds: ["a", "b"],
    });
  });
  it("o comando valida limites inteiros positivos, aceita null para remover e exige alguma alteração", () => {
    const base = { key: "chave-12345", studentId: "stu_1" };
    expect(setPolicySchema.safeParse({ ...base, dailyLimitCents: 1000 }).success).toBe(true);
    expect(setPolicySchema.safeParse({ ...base, weeklyLimitCents: null }).success).toBe(true);
    for (const bad of [{ dailyLimitCents: 0 }, { dailyLimitCents: 10.5 }, { dailyLimitCents: -1 }, { weeklyLimitCents: 1_000_001 }, {}, { blockedProductIds: ["../x"] }]) {
      expect(setPolicySchema.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });
});
