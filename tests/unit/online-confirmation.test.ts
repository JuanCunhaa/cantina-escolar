// Confirmação confiável da recarga online (F19) — regras PURAS e contratos, sem Firebase nem rede.
// Prova: assinatura do webhook conforme a documentação oficial (manifesto, HMAC-SHA256, tempo constante, janela de ts, corpo
// incoerente); mapeamento da order do Mercado Pago (formato medido no sandbox em 07/10/2026) para estados normalizados;
// decisão única (crédito só com pago + identidade + conta + moeda + valor; nada regride; divergência vai para revisão;
// estado desconhecido nunca credita); recuperação limitada ao saldo (nunca negativo). A integração com o emulador está em
// tests/integration/online-confirmation-api.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { amountProblem, decide, identityProblem, splitRecovery, type DecisionContext, type IntentFacts } from "@/modules/payments/online/confirmation-model";
import { classifyOrder, normalizeOrder, toCents } from "@/modules/payments/online/mercadopago";
import { computeSignature, parseNotification, parseSignatureHeader, signatureManifest, verifyWebhookSignature, WEBHOOK_TOLERANCE_MS } from "@/modules/payments/online/mercadopago-webhook";
import type { ProviderOrder } from "@/modules/payments/online/provider";

const SECRET = `wh-teste-${randomUUID()}`; // gerado a cada execução
const NOW = Date.UTC(2026, 9, 7, 15, 0, 0);

function signed(over: { dataId?: string | null; requestId?: string | null; ts?: number; secret?: string } = {}) {
  const ts = String(over.ts ?? NOW);
  const dataId = over.dataId === undefined ? "ORDTST01ABC" : over.dataId;
  const requestId = over.requestId === undefined ? "req-123" : over.requestId;
  const v1 = computeSignature(over.secret ?? SECRET, signatureManifest({ dataId, requestId, ts }));
  return { signature: `ts=${ts},v1=${v1}`, requestId, dataId };
}

describe("assinatura do webhook (A05)", () => {
  it("manifesto: id, request-id e ts; parte ausente é descartada", () => {
    expect(signatureManifest({ dataId: "ORDTST01ABC", requestId: "r1", ts: "1700000000000" })).toBe("id:ORDTST01ABC;request-id:r1;ts:1700000000000;");
    expect(signatureManifest({ dataId: null, requestId: "r1", ts: "5" })).toBe("request-id:r1;ts:5;");
    expect(signatureManifest({ dataId: "X", requestId: null, ts: "5" })).toBe("id:X;ts:5;");
  });

  it("ID da order: aceita a forma COMO RECEBIDA (observada na simulação do painel) e a forma em minúsculas documentada; mistura de caixa é recusada", () => {
    const ts = String(NOW);
    const at = (manifestId: string) => ({ signature: `ts=${ts},v1=${computeSignature(SECRET, `id:${manifestId};request-id:r1;ts:${ts};`)}` });
    const check = (manifestId: string, queryId = "ORDTST01M4EDRH87FT") => verifyWebhookSignature({ secret: SECRET, signature: at(manifestId).signature, requestId: "r1", dataId: queryId, nowMs: NOW });
    expect(check("ORDTST01M4EDRH87FT").ok).toBe(true); // como recebido (maiúsculas)
    expect(check("ordtst01m4edrh87ft").ok).toBe(true); // documentado (minúsculas)
    expect(check("OrdTst01M4EDRH87FT")).toEqual({ ok: false, reason: "bad_signature" }); // caixa mista nunca assinada
    expect(check("ORDTST01M4EDRH87FX")).toEqual({ ok: false, reason: "bad_signature" }); // outro ID
    expect(verifyWebhookSignature({ secret: "outra-chave", signature: at("ORDTST01M4EDRH87FT").signature, requestId: "r1", dataId: "ORDTST01M4EDRH87FT", nowMs: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("aceita assinatura correta (inclusive data.id em maiúsculas na query)", () => {
    const s = signed();
    expect(verifyWebhookSignature({ secret: SECRET, signature: s.signature, requestId: s.requestId, dataId: "ORDTST01ABC", nowMs: NOW })).toEqual({ ok: true, tsMs: NOW });
  });

  it("recusa: sem chave, sem cabeçalho, malformada, chave errada, data.id/request-id/ts adulterados", () => {
    const s = signed();
    const check = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]>) => verifyWebhookSignature({ secret: SECRET, signature: s.signature, requestId: s.requestId, dataId: s.dataId, nowMs: NOW, ...over });
    expect(check({ secret: undefined })).toEqual({ ok: false, reason: "missing_secret" });
    expect(check({ secret: "" })).toEqual({ ok: false, reason: "missing_secret" });
    expect(check({ signature: null })).toEqual({ ok: false, reason: "missing_signature" });
    expect(check({ signature: "lixo" })).toEqual({ ok: false, reason: "malformed_signature" });
    expect(check({ signature: `ts=${NOW},v1=zz` })).toEqual({ ok: false, reason: "malformed_signature" });
    expect(check({ secret: "outra-chave" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(check({ dataId: "ORDTST01ABD" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(check({ requestId: "req-999" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(check({ signature: s.signature.replace(`ts=${NOW}`, `ts=${NOW + 1}`) })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("janela de ts: dentro de 24 h passa; fora (passado ou futuro) é recusada mesmo com assinatura válida", () => {
    const old = signed({ ts: NOW - WEBHOOK_TOLERANCE_MS - 1 });
    const recent = signed({ ts: NOW - WEBHOOK_TOLERANCE_MS + 60_000 });
    const future = signed({ ts: NOW + WEBHOOK_TOLERANCE_MS + 1 });
    const v = (s: ReturnType<typeof signed>) => verifyWebhookSignature({ secret: SECRET, signature: s.signature, requestId: s.requestId, dataId: s.dataId, nowMs: NOW });
    expect(v(old)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(v(future)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(v(recent).ok).toBe(true);
  });

  it("cabeçalho: formato ts=,v1= e rejeita tamanhos/hex inválidos", () => {
    expect(parseSignatureHeader(`ts=1,v1=${"a".repeat(64)}`)).toEqual({ ts: "1", v1: "a".repeat(64) });
    expect(parseSignatureHeader(`v1=${"a".repeat(64)}`)).toBeNull();
    expect(parseSignatureHeader(`ts=1,v1=${"a".repeat(63)}`)).toBeNull();
    expect(parseSignatureHeader("x".repeat(600))).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
  });

  it("notificação: usa só IDs; descarta o status do corpo; data.id do corpo diferente da query é recusado", () => {
    const body = { action: "order.processed", type: "order", live_mode: false, user_id: 3745150346, data: { id: "ORDTST01ABC", status: "processed", version: 4, total_amount: "1.00" } };
    expect(parseNotification(body, "ORDTST01ABC", "order")).toEqual({ action: "order.processed", type: "order", orderId: "ORDTST01ABC", version: "4", liveMode: false, userId: "3745150346" });
    expect(JSON.stringify(parseNotification(body, null, null))).not.toContain("processed\"," + "\"status");
    expect(parseNotification(body, "ORDTST01XYZ", "order")).toBeNull();
    expect(parseNotification({ data: { id: "../etc" } }, null, null)).toBeNull();
    expect(parseNotification("texto", null, null)).toBeNull();
    expect(parseNotification({ data: {} }, null, null)).toBeNull();
  });
});

describe("mapeamento da order do Mercado Pago", () => {
  const paid = (over: Record<string, unknown> = {}, pay: Record<string, unknown> = {}) => ({
    id: "ORDTST01ABC",
    external_reference: "tpi_0123456789abcdef0123",
    total_amount: "50.00",
    total_paid_amount: "50.00",
    user_id: "3745150346",
    status: "processed",
    status_detail: "accredited",
    currency: "BRL",
    last_updated_date: "2026-10-07T00:39:06.403Z",
    transactions: { payments: [{ id: "PAY01", amount: "50.00", paid_amount: "50.00", status: "processed", status_detail: "accredited", ...pay }] },
    ...over,
  });

  it("valor em centavos exatos e formatos inválidos recusados", () => {
    expect(toCents("50.00")).toBe(5000);
    expect(toCents("0.5")).toBe(50);
    expect(toCents("12.34")).toBe(1234);
    expect(toCents("7")).toBe(700);
    for (const bad of ["-1.00", "1e3", "1.234", "", "abc", 50, null, undefined, "1,00"]) expect(toCents(bad)).toBeNull();
  });

  it("pago exige ORDER e PAGAMENTO processed/accredited", () => {
    expect(normalizeOrder(paid())).toMatchObject({ orderId: "ORDTST01ABC", externalReference: "tpi_0123456789abcdef0123", accountId: "3745150346", currency: "BRL", totalCents: 5000, paidCents: 5000, state: "paid", paymentId: "PAY01" });
    expect(classifyOrder(paid({ status_detail: "in_review" }), 5000).state).toBe("pending");
    expect(classifyOrder(paid({}, { status: "failed", status_detail: "failed" }), 5000).state).toBe("unknown");
    expect(classifyOrder(paid({}, { status_detail: "in_review" }), 5000).state).toBe("pending");
  });

  it("estados: pendente, falha, expirada, reembolso, chargeback e desconhecido (conservador)", () => {
    const base = { transactions: { payments: [{ id: "P", status: "action_required", status_detail: "waiting_transfer" }] } };
    expect(classifyOrder({ status: "action_required", status_detail: "waiting_transfer", ...base }, 5000).state).toBe("pending");
    expect(classifyOrder({ status: "failed", status_detail: "failed", transactions: { payments: [{ status: "failed", status_detail: "failed" }] } }, 5000).state).toBe("failed");
    expect(classifyOrder({ status: "expired", status_detail: "expired", transactions: { payments: [{ status: "expired", status_detail: "expired" }] } }, 5000).state).toBe("expired");
    expect(classifyOrder({ status: "refunded", status_detail: "refunded", transactions: { payments: [{ status: "refunded", status_detail: "refunded" }] } }, 5000)).toEqual({ state: "refunded", reversedCents: 5000 });
    // Chargeback — contrato oficial da API Orders (docs "Status da transação" e "Notificações de chargeback"; NÃO provado em
    // integração real, o sandbox não gera chargeback): `charged_back/in_process` = disputa EM ANDAMENTO (sem perda definitiva);
    // `settled` = perdida (valor da contestação); `reimbursed` = ganha pelo vendedor; detalhe desconhecido = não debita.
    const cb = (detail: string, chargebacks?: unknown[]) => ({ status: "charged_back", status_detail: detail, transactions: { payments: [{ status: "charged_back", status_detail: detail, amount: "50.00" }], ...(chargebacks ? { chargebacks } : {}) } });
    expect(classifyOrder(cb("in_process", [{ status: "opened", amount: "50.00" }]), 5000)).toEqual({ state: "dispute_open", reversedCents: 0 });
    expect(classifyOrder(cb("reimbursed", [{ status: "reimbursed", amount: "50.00" }]), 5000)).toEqual({ state: "dispute_won", reversedCents: 0 });
    expect(classifyOrder(cb("settled", [{ id: "CBK1", case_id: "123", status: "settled", amount: "50.00" }]), 5000)).toEqual({ state: "chargeback", reversedCents: 5000 });
    expect(classifyOrder(cb("settled", [{ status: "settled", amount: "20.00" }, { status: "opened", amount: "30.00" }]), 5000)).toEqual({ state: "chargeback", reversedCents: 2000 });
    expect(classifyOrder(cb("settled", [{ status: "settled", amount: "999.00" }]), 5000)).toEqual({ state: "chargeback", reversedCents: 5000 });
    expect(classifyOrder(cb("settled"), 5000).state).toBe("unknown"); // perdida sem valor confiável: não debita
    expect(classifyOrder(cb("settled", [{ status: "settled", amount: "abc" }]), 5000).state).toBe("unknown");
    expect(classifyOrder(cb("algo_novo", [{ status: "settled", amount: "50.00" }]), 5000).state).toBe("unknown");
    // Reembolso real do sandbox (07/10/2026): order e pagamento "refunded", `refunded_amount` e `transactions.refunds[]`.
    const sandboxRefund = { status: "refunded", status_detail: "refunded", transactions: { payments: [{ status: "refunded", status_detail: "refunded", amount: "50.00", paid_amount: "50.00", refunded_amount: "50.00" }], refunds: [{ id: "REF1", status: "processed", amount: "50.00" }] } };
    expect(classifyOrder(sandboxRefund, 5000)).toEqual({ state: "refunded", reversedCents: 5000 });
    // Parcial: o valor devolvido vem do pagamento (ou da soma dos reembolsos processados); sem valor confiável = desconhecido.
    expect(classifyOrder({ status: "processed", status_detail: "partially_refunded", transactions: { payments: [{ status: "processed", status_detail: "partially_refunded", refunded_amount: "20.00" }] } }, 5000)).toEqual({ state: "partially_refunded", reversedCents: 2000 });
    expect(classifyOrder({ status: "processed", status_detail: "partially_refunded", transactions: { payments: [{ status: "processed" }], refunds: [{ status: "processed", amount: "10.00" }, { status: "processed", amount: "5.50" }, { status: "failed", amount: "99.00" }] } }, 5000)).toEqual({ state: "partially_refunded", reversedCents: 1550 });
    expect(classifyOrder({ status: "processed", status_detail: "partially_refunded", transactions: { payments: [{ status: "processed" }] } }, 5000).state).toBe("unknown");
    expect(classifyOrder({ status: "refunded", transactions: { payments: [{ status: "refunded", refunded_amount: "abc" }] } }, 5000)).toEqual({ state: "refunded", reversedCents: 5000 });
    expect(classifyOrder({ status: "refunded", transactions: { payments: [{ status: "refunded", refunded_amount: "999.00" }] } }, 5000)).toEqual({ state: "refunded", reversedCents: 5000 });
    expect(classifyOrder({ status: "algo_novo", transactions: { payments: [{ status: "algo_novo" }] } }, 5000).state).toBe("unknown");
    expect(classifyOrder({ status: "processed", status_detail: "accredited", transactions: { payments: [] } }, 5000).state).toBe("unknown");
    expect(classifyOrder({ status: "processed", status_detail: "accredited", transactions: { payments: [{ status: "processed", status_detail: "accredited" }, { status: "processed", status_detail: "accredited" }] } }, 5000).state).toBe("unknown");
  });

  it("order ilegível (sem id, valor inválido ou sem conta) é incerta, nunca crédito por palpite", () => {
    for (const body of [null, {}, paid({ id: undefined }), paid({ total_amount: "abc" }), paid({ total_paid_amount: "1.999" }), paid({ user_id: undefined })]) {
      expect(() => normalizeOrder(body as Record<string, unknown> | null)).toThrow(/unreadable_order/);
    }
  });
});

describe("decisão de confirmação (A05/A06/A31)", () => {
  const ctx: DecisionContext = { accountId: "3745150346", providerId: "mercadopago" };
  const facts = (over: Partial<IntentFacts> = {}): IntentFacts => ({ intentId: "tpi_0123456789abcdef0123", status: "awaiting_payment", amountCents: 5000, chargeId: "ORD1", providerId: "mercadopago", accountedReversalCents: 0, reviewReason: null, dispute: null, reversalCause: null, ...over });
  const order = (over: Partial<ProviderOrder> = {}): ProviderOrder => ({ orderId: "ORD1", externalReference: "tpi_0123456789abcdef0123", accountId: "3745150346", currency: "BRL", totalCents: 5000, paidCents: 5000, state: "paid", providerStatus: "processed/accredited", reversedCents: 0, paymentId: "PAY1", updatedAt: null, ...over });

  it("credita só pago + identidade + conta + moeda + valor; vale para pendente, incerta, falha e expirada (A06)", () => {
    for (const status of ["creating", "creation_uncertain", "awaiting_payment", "processing", "failed", "expired", "in_review"] as const) {
      expect(decide(facts({ status, chargeId: status === "creating" || status === "creation_uncertain" ? null : "ORD1" }), order(), ctx)).toEqual({ kind: "credit" });
    }
  });

  it("nunca credita duas vezes nem regride: confirmada/revertida + paga = noop; pendente depois de paga = noop", () => {
    expect(decide(facts({ status: "confirmed" }), order(), ctx)).toEqual({ kind: "noop", reason: "already_credited" });
    expect(decide(facts({ status: "reversed" }), order(), ctx)).toEqual({ kind: "noop", reason: "already_reversed" });
    expect(decide(facts({ status: "confirmed" }), order({ state: "pending" }), ctx).kind).toBe("noop");
    expect(decide(facts({ status: "confirmed" }), order({ state: "failed" }), ctx).kind).toBe("noop");
    expect(decide(facts({ status: "confirmed" }), order({ state: "expired" }), ctx).kind).toBe("noop");
    expect(decide(facts({ status: "confirmed" }), order({ state: "unknown" }), ctx).kind).toBe("noop");
  });

  it("divergência com dinheiro recebido vai para revisão (valor, moeda, conta, ambiente, outra order) e nunca credita", () => {
    expect(decide(facts(), order({ paidCents: 4000 }), ctx)).toEqual({ kind: "review", reason: "amount_mismatch" });
    expect(decide(facts(), order({ totalCents: 6000, paidCents: 6000 }), ctx)).toEqual({ kind: "review", reason: "amount_mismatch" });
    expect(decide(facts(), order({ totalCents: 5000, paidCents: 5001 }), ctx)).toEqual({ kind: "review", reason: "amount_mismatch" });
    expect(decide(facts(), order({ currency: "USD" }), ctx)).toEqual({ kind: "review", reason: "currency_mismatch" });
    expect(decide(facts(), order({ currency: "" }), ctx)).toEqual({ kind: "review", reason: "currency_mismatch" });
    expect(decide(facts(), order({ accountId: "999" }), ctx)).toEqual({ kind: "review", reason: "account_mismatch" });
    expect(decide(facts(), order({ orderId: "ORD2" }), ctx)).toEqual({ kind: "review", reason: "order_mismatch" });
    expect(decide(facts({ providerId: "outro" }), order(), ctx)).toEqual({ kind: "review", reason: "environment_mismatch" });
  });

  it("a mesma revisão não é reescrita; um pagamento correto depois da revisão credita", () => {
    expect(decide(facts({ status: "in_review", reviewReason: "amount_mismatch" }), order({ paidCents: 4000 }), ctx)).toEqual({ kind: "noop", reason: "review_unchanged" });
    expect(decide(facts({ status: "in_review", reviewReason: "amount_mismatch" }), order(), ctx)).toEqual({ kind: "credit" });
  });

  it("falha/expiração só encerram intenção ainda em aberto, e só com identidade confirmada", () => {
    expect(decide(facts(), order({ state: "failed" }), ctx)).toEqual({ kind: "fail", code: "provider_rejected" });
    expect(decide(facts(), order({ state: "expired" }), ctx)).toEqual({ kind: "expire" });
    expect(decide(facts({ status: "failed" }), order({ state: "expired" }), ctx).kind).toBe("noop");
    expect(decide(facts({ status: "in_review" }), order({ state: "failed" }), ctx).kind).toBe("noop");
    expect(decide(facts(), order({ state: "failed", accountId: "999" }), ctx).kind).toBe("noop");
  });

  it("reversão: só de crédito já lançado, monotônica, limitada ao valor e sem repetir o já contabilizado", () => {
    expect(decide(facts({ status: "confirmed" }), order({ state: "refunded", reversedCents: 5000 }), ctx)).toEqual({ kind: "reverse", targetCents: 5000, cause: "refund" });
    expect(decide(facts({ status: "confirmed" }), order({ state: "chargeback", reversedCents: 5000 }), ctx)).toEqual({ kind: "reverse", targetCents: 5000, cause: "chargeback" });
    expect(decide(facts({ status: "confirmed" }), order({ state: "refunded", reversedCents: 9999 }), ctx)).toMatchObject({ kind: "reverse", targetCents: 5000 });
    expect(decide(facts({ status: "confirmed", accountedReversalCents: 5000 }), order({ state: "refunded", reversedCents: 5000 }), ctx)).toEqual({ kind: "noop", reason: "reversal_already_accounted" });
    expect(decide(facts({ status: "confirmed", accountedReversalCents: 2000 }), order({ state: "partially_refunded", reversedCents: 1000 }), ctx).kind).toBe("noop");
    expect(decide(facts({ status: "confirmed" }), order({ state: "refunded", reversedCents: 5000 }), { ...ctx, accountId: "999" }).kind).toBe("noop");
  });

  it("contestação: aberta só SINALIZA (nenhum débito); perdida debita; ganha limpa o sinal; ganha depois de debitada vai para a administração", () => {
    const confirmed = (over: Partial<IntentFacts> = {}) => facts({ status: "confirmed", ...over });
    expect(decide(confirmed(), order({ state: "dispute_open" }), ctx)).toEqual({ kind: "dispute", status: "open" });
    expect(decide(confirmed({ dispute: "open" }), order({ state: "dispute_open" }), ctx)).toEqual({ kind: "noop", reason: "dispute_already_known" });
    // aberta depois de perdida/debitada não regride nada
    expect(decide(confirmed({ dispute: "lost", accountedReversalCents: 5000, reversalCause: "chargeback" }), order({ state: "dispute_open" }), ctx).kind).toBe("noop");
    expect(decide(confirmed(), order({ state: "chargeback", reversedCents: 5000 }), ctx)).toEqual({ kind: "reverse", targetCents: 5000, cause: "chargeback" });
    expect(decide(confirmed({ dispute: "open" }), order({ state: "dispute_won" }), ctx)).toEqual({ kind: "dispute", status: "won" });
    expect(decide(confirmed({ dispute: "won" }), order({ state: "dispute_won" }), ctx).kind).toBe("noop");
    // ganha DEPOIS de já termos debitado: nenhuma devolução automática
    expect(decide(confirmed({ accountedReversalCents: 5000, reversalCause: "chargeback", dispute: "lost" }), order({ state: "dispute_won" }), ctx)).toEqual({ kind: "dispute", status: "won_after_reversal" });
    expect(decide(confirmed({ accountedReversalCents: 5000, reversalCause: "chargeback", dispute: "won_after_reversal" }), order({ state: "dispute_won" }), ctx).kind).toBe("noop");
    // pagamento disputado SEM crédito: revisão humana (nem crédito nem devolução); identidade divergente = ignora
    expect(decide(facts({ status: "awaiting_payment" }), order({ state: "dispute_open" }), ctx)).toEqual({ kind: "review", reason: "reversal_before_credit" });
    expect(decide(facts({ status: "in_review" }), order({ state: "dispute_won" }), ctx).kind).toBe("noop");
    expect(decide(confirmed(), order({ state: "dispute_open", accountId: "999" }), ctx).kind).toBe("noop");
    // reembolso (não chargeback) debitado não conta como 'perdida'
    expect(decide(confirmed({ accountedReversalCents: 2000, reversalCause: "refund" }), order({ state: "dispute_won" }), ctx)).toEqual({ kind: "dispute", status: "won" });
  });

  it("reembolso/chargeback ANTES do crédito: total = sem crédito; parcial ou chargeback = revisão humana", () => {
    expect(decide(facts({ status: "awaiting_payment" }), order({ state: "refunded", reversedCents: 5000 }), ctx)).toEqual({ kind: "fail", code: "refunded_before_credit" });
    expect(decide(facts({ status: "awaiting_payment" }), order({ state: "partially_refunded", reversedCents: 1000 }), ctx)).toEqual({ kind: "review", reason: "reversal_before_credit" });
    expect(decide(facts({ status: "processing" }), order({ state: "chargeback", reversedCents: 5000 }), ctx)).toEqual({ kind: "review", reason: "reversal_before_credit" });
  });

  it("identidade e valor isolados", () => {
    expect(identityProblem(facts({ chargeId: null }), order(), ctx)).toBeNull();
    expect(amountProblem(facts(), order({ totalCents: 5000.5 }))).toBe("amount_mismatch");
  });

  it("recuperação nunca passa do saldo; o resto vira pendência (nunca negativo)", () => {
    expect(splitRecovery(5000, 5000)).toEqual({ recoveredCents: 5000, pendingCents: 0 });
    expect(splitRecovery(5000, 8000)).toEqual({ recoveredCents: 5000, pendingCents: 0 });
    expect(splitRecovery(5000, 1200)).toEqual({ recoveredCents: 1200, pendingCents: 3800 });
    expect(splitRecovery(5000, 0)).toEqual({ recoveredCents: 0, pendingCents: 5000 });
    for (let added = 1; added <= 60; added += 7) for (let balance = 0; balance <= 70; balance += 5) {
      const r = splitRecovery(added, balance);
      expect(r.recoveredCents + r.pendingCents).toBe(added);
      expect(r.recoveredCents).toBeLessThanOrEqual(balance);
      expect(r.pendingCents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("contestação ganha depois de a recarga ser totalmente revertida", () => {
  it("vai para a administração (nenhum crédito automático) mesmo com a intenção 'revertida'", () => {
    const f: IntentFacts = { intentId: "tpi_0123456789abcdef0123", status: "reversed", amountCents: 5000, chargeId: "ORD1", providerId: "mercadopago", accountedReversalCents: 5000, reviewReason: null, dispute: "lost", reversalCause: "chargeback" };
    const won = { orderId: "ORD1", externalReference: "tpi_0123456789abcdef0123", accountId: "3745150346", currency: "BRL", totalCents: 5000, paidCents: 5000, state: "dispute_won", providerStatus: "charged_back/reimbursed", reversedCents: 0, paymentId: "P", updatedAt: null } as const;
    const c = { accountId: "3745150346", providerId: "mercadopago" };
    expect(decide(f, won, c)).toEqual({ kind: "dispute", status: "won_after_reversal" });
    expect(decide({ ...f, dispute: "won_after_reversal" }, won, c).kind).toBe("noop");
    expect(decide(f, { ...won, state: "dispute_open" }, c).kind).toBe("noop");
    expect(decide(f, { ...won, state: "paid" }, c).kind).toBe("noop");
  });
});
