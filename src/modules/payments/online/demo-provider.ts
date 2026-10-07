import type { CardProvider, PixProvider, ProviderCharge } from "./provider";
import { ProviderError } from "./provider";

/**
 * Provedor de DEMONSTRAÇÃO, aceito SOMENTE com APP_ENV=emulator (ver config.ts): não fala com nenhum provedor, não cobra
 * nada e NUNCA confirma pagamento — a intenção fica "aguardando pagamento"/"em análise" para sempre, porque a confirmação
 * confiável é da F19 e não existe "simular pagamento". Serve para provar a tela, a idempotência e a conciliação.
 *
 * Valores especiais (só aqui) para exercitar falhas pela interface:
 * - R$ 13,13: cria a cobrança e PERDE a resposta (timeout depois da criação) → a conciliação a encontra;
 * - R$ 14,14: falha incerta SEM criar → a conciliação não encontra (reenvio explícito com a mesma chave cria);
 * - R$ 15,15: recusa definitiva.
 * Cartão: token `demo_tok_approved` → em análise; `demo_tok_declined` → recusado.
 */
// Em `globalThis`: as rotas do `next dev` podem carregar cópias distintas do módulo; o "provedor" precisa ser um só no processo.
const store_ = globalThis as typeof globalThis & { __cantinaDemoProvider?: { charges: Map<string, ProviderCharge>; failedOnce: Set<string> } };
store_.__cantinaDemoProvider ??= { charges: new Map(), failedOnce: new Set() };
const { charges, failedOnce } = store_.__cantinaDemoProvider;

/** PNG 1×1 transparente: marca visual de demonstração (o adapter real devolve o QR do provedor). */
const DEMO_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function store(reference: string, charge: ProviderCharge): ProviderCharge {
  charges.set(reference, charge);
  return charge;
}

export const demoPixProvider: PixProvider = {
  id: "demo",
  mode: "demo",
  idempotencyWindowMs: 24 * 60 * 60 * 1000,
  async createPixCharge(request) {
    const existing = charges.get(request.externalReference);
    if (existing) return existing; // mesma chave → mesma cobrança
    if (request.amountCents === 1515) throw new ProviderError("rejected", "demo_rejected");
    if (request.amountCents === 1414 && !failedOnce.has(request.externalReference)) {
      failedOnce.add(request.externalReference);
      throw new ProviderError("uncertain", "demo_timeout_before_create");
    }
    const charge = store(request.externalReference, {
      chargeId: `demo_pix_${request.intentId}`,
      providerStatus: "pending",
      outcome: "awaiting_payment",
      pix: { copyPaste: `DEMONSTRACAO-SEM-COBRANCA-${request.intentId}`, qrImagePngBase64: DEMO_PNG, expiresAt: request.expiresAt.toISOString() },
    });
    if (request.amountCents === 1313) throw new ProviderError("uncertain", "demo_timeout_after_create");
    return charge;
  },
  async findCharge(reference) {
    return charges.get(reference) ?? null;
  },
  // A demonstração NUNCA confirma pagamento: não existe order paga para consultar (sem "simular pagamento").
  async getOrder() {
    return null;
  },
  async accountId() {
    return "demo";
  },
};

export const demoCardProvider: CardProvider = {
  id: "demo",
  mode: "demo",
  publicConfig: { kind: "demo" },
  async createCardCharge(request) {
    const existing = charges.get(request.externalReference);
    if (existing) return existing;
    if (request.cardToken === "demo_tok_declined") {
      return store(request.externalReference, { chargeId: `demo_card_${request.intentId}`, providerStatus: "rejected", outcome: "declined", pix: null, declineCode: "card_declined" });
    }
    if (request.cardToken !== "demo_tok_approved") throw new ProviderError("rejected", "invalid_card_token");
    return store(request.externalReference, { chargeId: `demo_card_${request.intentId}`, providerStatus: "approved", outcome: "processing", pix: null });
  },
  async findCharge(reference) {
    return charges.get(reference) ?? null;
  },
  async getOrder() {
    return null;
  },
  async accountId() {
    return "demo";
  },
};
