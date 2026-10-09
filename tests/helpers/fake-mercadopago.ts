import type { CardProvider, ChargeRequest, PixProvider, ProviderCharge, ProviderOrder } from "@/modules/payments/online/provider";
import { ProviderError } from "@/modules/payments/online/provider";

/**
 * Provedor roteirizado para os testes de integração da F19: guarda as ORDERS que o "Mercado Pago" conheceria, deixa o teste
 * mudar o estado (pagar, recusar, expirar, reembolsar, contestar) e CONTA as chamadas, para provar que o callback
 * transacional nunca chama o provedor. NÃO prova nenhum provedor real (o sandbox real é tests/staging/online-topup-sandbox).
 */
export const FAKE_ACCOUNT = "3745150346";

export function fakeMercadoPago(options: { accountId?: string } = {}) {
  const accountId = options.accountId ?? FAKE_ACCOUNT;
  const orders = new Map<string, ProviderOrder>();
  const charges = new Map<string, ProviderCharge>();
  const calls = { create: 0, getOrder: 0, accountId: 0, find: 0, getOrderIds: [] as string[] };
  const script = { failGet: 0, loseCreateResponse: false, getDelayMs: 0 };

  const orderIdOf = (intentId: string) => `ORDFAKE${intentId.slice(4).toUpperCase()}`;
  const base = (req: ChargeRequest): ProviderOrder => ({
    orderId: orderIdOf(req.intentId),
    externalReference: req.externalReference,
    accountId,
    currency: "BRL",
    totalCents: req.amountCents,
    paidCents: 0,
    state: "pending",
    providerStatus: "action_required/waiting_transfer",
    reversedCents: 0,
    paymentId: `PAYFAKE${req.intentId.slice(4).toUpperCase()}`,
    updatedAt: null,
  });

  const create = async (req: ChargeRequest & { expiresAt?: Date }, channel: "pix" | "card"): Promise<ProviderCharge> => {
    calls.create += 1;
    const known = charges.get(req.externalReference);
    if (known) return known;
    const order = base(req);
    orders.set(order.orderId, order);
    const charge: ProviderCharge =
      channel === "pix"
        ? { chargeId: order.orderId, providerStatus: order.providerStatus, outcome: "awaiting_payment", pix: { copyPaste: `00020126PIX${req.intentId}`, qrImagePngBase64: "iVBORw0KGgo=", expiresAt: (req.expiresAt ?? new Date(Date.now() + 1_800_000)).toISOString() } }
        : { chargeId: order.orderId, providerStatus: "processed/in_review", outcome: "processing", pix: null };
    charges.set(req.externalReference, charge);
    if (script.loseCreateResponse) {
      script.loseCreateResponse = false;
      throw new ProviderError("uncertain", "network_or_timeout"); // a cobrança FOI criada, a resposta se perdeu
    }
    return charge;
  };

  const common = {
    id: "mercadopago",
    mode: "live" as const,
    async findCharge(reference: string) {
      calls.find += 1;
      return charges.get(reference) ?? null;
    },
    async getOrder(orderId: string): Promise<ProviderOrder | null> {
      calls.getOrder += 1;
      calls.getOrderIds.push(orderId);
      if (script.getDelayMs) await new Promise((r) => setTimeout(r, script.getDelayMs));
      if (script.failGet > 0) {
        script.failGet -= 1;
        throw new ProviderError("uncertain", "http_503");
      }
      const found = orders.get(orderId) ?? orders.get(orderId.toUpperCase());
      return found ? { ...found } : null;
    },
    async accountId() {
      calls.accountId += 1;
      return accountId;
    },
  };

  const pix: PixProvider = { ...common, idempotencyWindowMs: 3_600_000, createPixCharge: (req) => create(req, "pix") };
  const card: CardProvider = { ...common, publicConfig: {}, createCardCharge: (req) => create(req, "card") };

  const patch = (intentId: string, over: Partial<ProviderOrder>) => {
    const key = orderIdOf(intentId);
    const current = orders.get(key);
    if (!current) throw new Error("order inexistente no provedor falso");
    orders.set(key, { ...current, ...over });
  };

  return {
    pix,
    card,
    providers: { pix, card },
    calls,
    script,
    orderIdOf,
    orders,
    /** Pagamento aprovado (processed/accredited) no valor da order, salvo `over`. */
    pay(intentId: string, over: Partial<ProviderOrder> = {}) {
      const order = orders.get(orderIdOf(intentId))!;
      patch(intentId, { state: "paid", paidCents: order.totalCents, providerStatus: "processed/accredited", ...over });
    },
    fail: (intentId: string) => patch(intentId, { state: "failed", providerStatus: "failed/failed" }),
    expire: (intentId: string) => patch(intentId, { state: "expired", providerStatus: "expired/expired" }),
    pending: (intentId: string) => patch(intentId, { state: "pending", paidCents: 0, providerStatus: "action_required/waiting_transfer" }),
    refund: (intentId: string, cents?: number) => patch(intentId, { state: "refunded", providerStatus: "refunded/refunded", reversedCents: cents ?? orders.get(orderIdOf(intentId))!.totalCents }),
    /** Contestação PERDIDA (`charged_back/settled`): valor efetivamente debitado pelo provedor. */
    chargeback: (intentId: string, cents?: number) => patch(intentId, { state: "chargeback", providerStatus: "charged_back/settled", reversedCents: cents ?? orders.get(orderIdOf(intentId))!.totalCents }),
    /** Contestação em andamento (`charged_back/in_process`) e ganha (`charged_back/reimbursed`): sem perda definitiva. */
    disputeOpen: (intentId: string) => patch(intentId, { state: "dispute_open", providerStatus: "charged_back/in_process", reversedCents: 0 }),
    disputeWon: (intentId: string) => patch(intentId, { state: "dispute_won", providerStatus: "charged_back/reimbursed", reversedCents: 0 }),
    unknownStatus: (intentId: string) => patch(intentId, { state: "unknown", providerStatus: "novo/novo" }),
    set: patch,
    /** Uma order de OUTRA cobrança com o mesmo `external_reference` (duplicidade/forjada): nunca deve creditar. */
    plantForeignOrder(intentId: string, over: Partial<ProviderOrder> = {}) {
      const id = `ORDOUTRA${intentId.slice(4).toUpperCase()}`;
      orders.set(id, { ...orders.get(orderIdOf(intentId))!, orderId: id, paymentId: "PAYOUTRA", state: "paid", paidCents: orders.get(orderIdOf(intentId))!.totalCents, providerStatus: "processed/accredited", ...over });
      return id;
    },
  };
}
export type FakeMercadoPago = ReturnType<typeof fakeMercadoPago>;
