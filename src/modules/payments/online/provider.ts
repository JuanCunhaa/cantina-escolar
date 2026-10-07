/**
 * Fronteira com o provedor de pagamento online (F18): UM contrato para Pix e UM para cartão 1x, escolhidos por canal na
 * configuração (o mesmo provedor pode atender os dois). Não é um framework de gateways: cada adapter real implementa só
 * estes métodos, conforme a documentação oficial do provedor escolhido.
 *
 * Regras da fronteira:
 * - toda criação externa recebe `idempotencyKey` ESTÁVEL (= ID da intenção local) e `externalReference` (= mesmo ID);
 *   repetir a mesma intenção nunca pode gerar outra cobrança no provedor;
 * - `findCharge` consulta pelo `externalReference` e é o caminho de conciliação depois de timeout/resposta perdida;
 * - nada aqui confirma pagamento nem credita carteira: confirmação confiável (webhook autenticado + consulta) é da F19;
 * - o cartão chega TOKENIZADO pelo componente do provedor no navegador; número/CVV nunca passam pelo servidor.
 */

export type ProviderMode = "demo" | "live";

/** Dados do Pix exibidos à família: QR (imagem PNG em base64, quando o provedor fornece), copia e cola e validade. */
export type PixData = { copyPaste: string; qrImagePngBase64: string | null; expiresAt: string };

/**
 * Cobrança conhecida pelo provedor. `outcome`:
 * - `awaiting_payment`: Pix gerado, aguardando o pagador;
 * - `processing`: cartão enviado (aprovado ou em análise no provedor) ou Pix já informado como pago pelo provedor — ainda NÃO é
 *   recebimento confirmado (a confirmação confiável é da F19);
 * - `declined`: o provedor recusou definitivamente (cartão negado, dados inválidos).
 */
export type ProviderCharge = {
  chargeId: string;
  providerStatus: string;
  outcome: "awaiting_payment" | "processing" | "declined";
  pix: PixData | null;
  declineCode?: string;
};

/**
 * Estado NORMALIZADO da order/cobrança no provedor, lido pelo servidor (nunca o que veio na notificação):
 * - `paid`: recebimento confirmado pelo provedor (única base de crédito);
 * - `pending`: ainda a pagar/em análise; `failed`/`expired`: encerrada sem pagamento;
 * - `refunded`/`partially_refunded`/`chargeback`: valor devolvido ou contestado (`reversedCents` acumulado, ≤ total);
 * - `unknown`: status que o adapter não reconhece — NUNCA credita nem muda uma intenção por isso (falha segura).
 */
export type ProviderOrderState = "pending" | "paid" | "failed" | "expired" | "refunded" | "partially_refunded" | "chargeback" | "unknown";

export type ProviderOrder = {
  orderId: string;
  /** `external_reference` da order (= ID da intenção); `null` se o provedor não devolveu. */
  externalReference: string | null;
  /** Conta recebedora dona da order (no Mercado Pago, `user_id`). */
  accountId: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  state: ProviderOrderState;
  providerStatus: string;
  reversedCents: number;
  paymentId: string | null;
  updatedAt: string | null;
};

export type ChargeRequest = {
  intentId: string;
  idempotencyKey: string;
  externalReference: string;
  amountCents: number;
  currency: "BRL";
  description: string;
  /** Pagador informado ao provedor. Documento (CPF) só no cartão, vindo do formulário do provedor; nunca persistido. */
  payer: { name: string; email: string; identification?: { type: "CPF" | "CNPJ"; number: string } };
};

/**
 * Falha da chamada ao provedor:
 * - `rejected`: resposta definitiva de que a cobrança NÃO foi criada (ex.: 4xx de validação);
 * - `uncertain`: timeout, rede, 5xx, 409 de idempotência concorrente ou resposta ilegível — a cobrança PODE existir;
 *   só a conciliação (`findCharge`) decide, nunca uma nova cobrança automática.
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: "rejected" | "uncertain",
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

type ProviderBase = {
  id: string;
  mode: ProviderMode;
  /**
   * Consulta pela referência externa (= ID da intenção), a partir do instante de criação local (provedores exigem janela de
   * datas na busca). `null` = o provedor afirma não conhecer a cobrança.
   */
  findCharge(externalReference: string, createdAt: Date): Promise<ProviderCharge | null>;
  /**
   * Consulta confirmatória (F19): a order pelo ID do provedor, estado atual e valores. `null` = o provedor afirma que não
   * existe (404). Falha de rede/5xx/resposta ilegível = `ProviderError("uncertain")`. Chamada FORA de qualquer transação.
   */
  getOrder(orderId: string): Promise<ProviderOrder | null>;
  /** Conta recebedora das credenciais configuradas (comparada com a dona da order e com a notificação). */
  accountId(): Promise<string>;
};

export type PixProvider = ProviderBase & {
  /**
   * Janela em que o provedor garante a deduplicação pela mesma chave de idempotência. Reenvio explícito (pedido pela família
   * depois de a consulta não encontrar a cobrança) só acontece dentro dela, com a MESMA chave.
   */
  idempotencyWindowMs: number;
  createPixCharge(request: ChargeRequest & { expiresAt: Date }): Promise<ProviderCharge>;
};

export type CardProvider = ProviderBase & {
  /** Configuração pública do componente de tokenização (ex.: chave pública); nunca segredo. */
  publicConfig: Record<string, string>;
  /** `paymentMethodId` = bandeira devolvida pelo componente do provedor (ex.: "visa"); só crédito, 1 parcela. */
  createCardCharge(request: ChargeRequest & { cardToken: string; installments: 1; paymentMethodId: string }): Promise<ProviderCharge>;
};

export type OnlineProviders = { pix: PixProvider | null; card: CardProvider | null };
