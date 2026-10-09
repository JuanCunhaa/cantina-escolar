import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/school-time";
import { applyRule, expectedSettlementOf, checkNewVersion, effectiveFee, estimateFee, percentFeeCents, resolveRule, ruleSchema, sourceSchema, type RuleVersion } from "@/modules/fees/fee-model";

const version = (n: number, effectiveFrom: string, over: Partial<RuleVersion> = {}): RuleVersion => ({
  n,
  effectiveFrom,
  enabled: true,
  percentBp: 300,
  fixedCents: 0,
  settlementDays: 30,
  settlementBasis: "calendar_days",
  fictitious: true,
  reason: "Regra FICTÍCIA de teste",
  createdByUid: "admin",
  createdOn: "2026-09-01",
  createdAtIso: "2026-09-01T00:00:00.000Z",
  withdrawn: null,
  ...over,
});

describe("F20 — cálculo da taxa estimada (inteiro exato, meio para cima)", () => {
  it("R$ 50,00 a 3,00% = R$ 1,50 (o exemplo do contrato): líquido R$ 48,50", () => {
    expect(percentFeeCents(5000, 300)).toBe(150);
    const out = estimateFee(5000, { percentBp: 300, fixedCents: 0 });
    expect(out).toEqual({ ok: true, cents: 150, percentCents: 150, fixedCents: 0 });
    expect(5000 - (out.ok ? out.cents : 0)).toBe(4850);
  });

  it("arredonda MEIO PARA CIMA: 0,5 centavo vira 1; 0,49 vira 0; 0,9999 vira 1", () => {
    expect(percentFeeCents(50, 100)).toBe(1); // 0,50
    expect(percentFeeCents(49, 100)).toBe(0); // 0,49
    expect(percentFeeCents(101, 99)).toBe(1); // 0,9999
    expect(percentFeeCents(1, 5000)).toBe(1); // 0,50
    expect(percentFeeCents(3333, 199)).toBe(66); // 66,3267
    expect(percentFeeCents(3334, 199)).toBe(66); // 66,3466
    expect(percentFeeCents(3350, 199)).toBe(67); // 66,665
  });

  it("soma o fixo ao percentual arredondado; taxa maior que o valor não vira estimativa", () => {
    expect(estimateFee(1000, { percentBp: 100, fixedCents: 39 })).toEqual({ ok: true, cents: 49, percentCents: 10, fixedCents: 39 });
    expect(estimateFee(30, { percentBp: 0, fixedCents: 39 })).toEqual({ ok: false, issue: "exceeds_amount" });
  });

  it("é exato nos extremos permitidos (R$ 2.000,00 a 30,00% + R$ 100,00) sem ponto flutuante", () => {
    expect(estimateFee(200_000, { percentBp: 3000, fixedCents: 10_000 })).toEqual({ ok: true, cents: 70_000, percentCents: 60_000, fixedCents: 10_000 });
  });
});

describe("F20 — vigência e versões", () => {
  const v = [version(1, "2026-10-01", { percentBp: 100 }), version(2, "2026-11-01", { percentBp: 250 })];

  it("a versão em vigor é a de maior vigência ≤ a data do recebimento", () => {
    expect(resolveRule(v, "2026-09-30", { production: false })).toEqual({ rule: null, issue: "no_rule" });
    expect(resolveRule(v, "2026-10-01", { production: false }).rule?.n).toBe(1);
    expect(resolveRule(v, "2026-10-31", { production: false }).rule?.n).toBe(1);
    expect(resolveRule(v, "2026-11-01", { production: false }).rule?.n).toBe(2);
  });

  it("versão encerrada (enabled=false) deixa de estimar a partir da vigência; versão retirada é ignorada", () => {
    const ended = [...v, version(3, "2026-12-01", { enabled: false })];
    expect(resolveRule(ended, "2026-12-15", { production: false })).toEqual({ rule: null, issue: "rule_disabled" });
    const withdrawn = [version(1, "2026-10-01"), version(2, "2026-11-01", { withdrawn: { byUid: "a", on: "2026-10-05", reason: "publicada por engano" } })];
    expect(resolveRule(withdrawn, "2026-11-20", { production: false }).rule?.n).toBe(1);
  });

  it("regra FICTÍCIA nunca vale em produção (nem estimativa nem previsão de liquidação)", () => {
    expect(resolveRule(v, "2026-10-10", { production: true })).toEqual({ rule: null, issue: "fictitious_in_production" });
    const real = [version(1, "2026-10-01", { fictitious: false })];
    expect(resolveRule(real, "2026-10-10", { production: true }).rule?.n).toBe(1);
    expect(applyRule("s__pix", v, { grossCents: 5000, receivedOn: "2026-10-10" }, { production: true })).toEqual({ estimate: null, expectedSettlement: null, issue: "fictitious_in_production" });
  });

  it("aplicar congela a versão usada e a previsão de liquidação (dias corridos)", () => {
    const out = applyRule("term_x__card_credit", v, { grossCents: 10_000, receivedOn: "2026-10-09" }, { production: false });
    expect(out.estimate).toMatchObject({ cents: 100, ruleVersion: 1, percentBp: 100, fictitious: true, computedOn: "2026-10-09", seriesId: "term_x__card_credit" });
    expect(out.expectedSettlement).toEqual({ on: addDays("2026-10-09", 30), days: 30, basis: "calendar_days", ruleVersion: 1 }); // a base usada é gravada junto da data
    expect(out.estimate).toMatchObject({ settlementDays: 30, settlementBasis: "calendar_days" });
    // depois da virada, o MESMO valor usa a versão 2 — o lançamento antigo continua guardando a versão 1
    expect(applyRule("term_x__card_credit", v, { grossCents: 10_000, receivedOn: "2026-11-01" }, { production: false }).estimate).toMatchObject({ cents: 250, ruleVersion: 2 });
  });

  it("SEM prazo configurado a previsão fica PENDENTE (sem data); a estimativa da taxa segue valendo", () => {
    const none = [version(1, "2026-10-01", { settlementDays: null, settlementBasis: null })];
    const out = applyRule("s__card_credit", none, { grossCents: 10_000, receivedOn: "2026-10-09" }, { production: false });
    expect(out.expectedSettlement).toBeNull();
    expect(out.estimate).toMatchObject({ cents: 300, settlementDays: null, settlementBasis: null });
    expect(expectedSettlementOf(none[0]!, "2026-10-09")).toBeNull();
  });

  it("versão ANTIGA sem a base gravada não assume dias corridos: previsão pendente", () => {
    const legacy = { ...version(1, "2026-10-01"), settlementBasis: undefined } as RuleVersion;
    expect(expectedSettlementOf(legacy, "2026-10-09")).toBeNull();
    const withDaysOnly = { ...version(1, "2026-10-01"), settlementBasis: null };
    expect(expectedSettlementOf(withDaysOnly, "2026-10-09")).toBeNull();
    expect(applyRule("s__card_credit", [legacy], { grossCents: 1000, receivedOn: "2026-10-09" }, { production: false }).expectedSettlement).toBeNull();
  });

  it("publicar: nunca retroativa, estritamente depois das vigentes/futuras, limite de versões", () => {
    expect(checkNewVersion(v, { effectiveFrom: "2026-10-08" }, "2026-10-09")?.code).toBe("effective_in_past");
    expect(checkNewVersion(v, { effectiveFrom: "2026-11-01" }, "2026-10-09")?.code).toBe("effective_not_after_last");
    expect(checkNewVersion(v, { effectiveFrom: "2026-10-20" }, "2026-10-09")?.code).toBe("effective_not_after_last");
    expect(checkNewVersion(v, { effectiveFrom: "2026-11-02" }, "2026-10-09")).toBeNull();
    // uma versão retirada não conta como "última"
    const withdrawnLast = [v[0]!, { ...v[1]!, withdrawn: { byUid: "a", on: "2026-10-09", reason: "publicada por engano" } }];
    expect(checkNewVersion(withdrawnLast, { effectiveFrom: "2026-10-20" }, "2026-10-09")).toBeNull();
    expect(checkNewVersion(Array.from({ length: 100 }, (_, i) => version(i + 1, addDays("2026-01-01", i))), { effectiveFrom: "2030-01-01" }, "2026-10-09")?.code).toBe("too_many_versions");
  });

  it("validação de entrada: percentual, fixo e prazo dentro dos tetos; cartão de débito não é online", () => {
    const ok = { key: "chave-1234", sourceId: "default", method: "pix", effectiveFrom: "2026-10-10", enabled: true, percentBp: 99, fixedCents: 0, settlementDays: 0, settlementBasis: "calendar_days", fictitious: true, reason: "regra fictícia de teste" };
    expect(ruleSchema.safeParse(ok).success).toBe(true);
    expect(ruleSchema.safeParse({ ...ok, percentBp: 3001 }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...ok, percentBp: 1.5 }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...ok, fixedCents: 10_001 }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...ok, settlementDays: 91 }).success).toBe(false);
    // prazo e base andam juntos; dias úteis NÃO é aceito (depende de decisão da escola e de calendário bancário)
    expect(ruleSchema.safeParse({ ...ok, settlementDays: null, settlementBasis: null }).success).toBe(true);
    expect(ruleSchema.safeParse({ ...ok, settlementBasis: null }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...ok, settlementDays: null }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...ok, settlementBasis: "business_days" }).success).toBe(false);
    const withoutBasis: Record<string, unknown> = { ...ok };
    delete withoutBasis.settlementBasis;
    expect(ruleSchema.safeParse(withoutBasis).success).toBe(false); // sem base explícita não há padrão silencioso
    expect(ruleSchema.safeParse({ ...ok, method: "cash" }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...ok, reason: "curto" }).success).toBe(false);
    const src = { key: "chave-1234", kind: "provider", code: "mercadopago", name: "Provedor fictício", methods: ["pix", "card_credit"], fictitious: true };
    expect(sourceSchema.safeParse(src).success).toBe(true);
    expect(sourceSchema.safeParse({ ...src, methods: ["card_debit"] }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...src, kind: "terminal", methods: ["card_debit", "card_credit"] }).success).toBe(true);
    expect(sourceSchema.safeParse({ ...src, methods: ["pix", "pix"] }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...src, code: "Mercado Pago" }).success).toBe(false);
  });
});

describe("F20 — UMA taxa por recebimento (conferida > informada > estimada)", () => {
  const estimate = { cents: 150, fictitious: true };

  it("sem valor real a estimativa vale; sem estimativa nem valor é desconhecida", () => {
    expect(effectiveFee({ status: "pending", cents: null, source: "operator" }, estimate)).toMatchObject({ basis: "estimated", cents: 150, actualCents: null });
    expect(effectiveFee({ status: "pending", cents: null, source: "provider" }, null)).toMatchObject({ basis: "unknown", cents: null });
    expect(effectiveFee(undefined, null).basis).toBe("unknown");
  });

  it("com valor real, só o real entra; a diferença aparece e a estimativa não soma", () => {
    const informed = effectiveFee({ status: "informed", cents: 160, source: "operator" }, estimate);
    expect(informed).toMatchObject({ basis: "informed", cents: 160, estimatedCents: 150, differenceCents: 10 });
    const confirmed = effectiveFee({ status: "confirmed", cents: 148, source: "operator" }, estimate);
    expect(confirmed).toMatchObject({ basis: "confirmed", cents: 148, differenceCents: -2 });
    expect(confirmed.cents).not.toBe(148 + 150);
  });

  it("dinheiro é sem taxa mesmo havendo estimativa gravada", () => {
    expect(effectiveFee({ status: "none", cents: 0, source: "not_applicable" }, estimate)).toMatchObject({ basis: "none", cents: 0 });
  });
});
