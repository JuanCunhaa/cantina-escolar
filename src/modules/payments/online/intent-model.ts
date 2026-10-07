import { z } from "zod";
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from "../topup-model";
import type { PixData, ProviderCharge } from "./provider";

/**
 * Intenção de recarga online (F18), regras puras. Estados persistidos:
 * - `creating`: intenção gravada; criação externa em curso;
 * - `creation_uncertain`: a resposta do provedor não chegou/foi ilegível — a cobrança PODE existir; só a conciliação por
 *   consulta decide (nunca uma nova cobrança automática);
 * - `awaiting_payment`: Pix gerado (QR, copia e cola, validade);
 * - `processing`: cartão enviado ao provedor (aprovado ou em análise) — ainda não é recebimento confirmado;
 * - `failed`: o provedor recusou, ou a conciliação concluiu que a cobrança não foi criada.
 * `expired` é DERIVADO (Pix vencido pela validade local) e não descarta nada: um pagamento confirmado depois é conciliado
 * pela F19, que também cria `confirmed`, `in_review` e `reversed`. Nenhum estado daqui credita a carteira.
 */
export const INTENT_STATUSES = ["creating", "creation_uncertain", "awaiting_payment", "processing", "failed"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];
export type DisplayStatus = IntentStatus | "expired";
export const OPEN_STATUSES: readonly IntentStatus[] = ["creating", "creation_uncertain", "awaiting_payment"];

export const CHANNELS = ["pix", "card"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Validade do Pix gerado (o provedor real pode ter mínimo próprio; o adapter respeita o maior dos dois). */
export const PIX_TTL_MS = 30 * 60 * 1000;
/** Intenções abertas por aluno (evita gerar cobranças em série por cliques/abas). */
export const MAX_OPEN_INTENTS = 3;
/** `creating` parado além disto (processo interrompido entre gravar e chamar o provedor) é tratado como incerto. */
export const STALE_CREATING_MS = 60 * 1000;
/** Sem cobrança encontrada depois disto, a conciliação encerra como "não criada" (a família pode iniciar outra recarga). */
export const GIVE_UP_UNCERTAIN_MS = 30 * 60 * 1000;

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  creating: "Gerando cobrança…",
  creation_uncertain: "Verificando a cobrança",
  awaiting_payment: "Aguardando pagamento",
  processing: "Pagamento em análise",
  failed: "Não concluída",
  expired: "Expirada",
};

const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const studentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const amountCents = z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS);

/**
 * Entrada da tela. `strict`: qualquer campo extra (ex.: número do cartão, CVV, validade) é RECUSADO — o cartão só chega como
 * token do componente do provedor. Parcelamento: somente 1.
 */
export const createIntentSchema = z.discriminatedUnion("channel", [
  z.object({ key, studentId, amountCents, channel: z.literal("pix") }).strict(),
  z
    .object({
      key,
      studentId,
      amountCents,
      channel: z.literal("card"),
      installments: z.literal(1),
      cardToken: z.string().regex(/^[A-Za-z0-9_.:-]{8,512}$/),
      // Bandeira e pagador vêm do componente do provedor (não são dados do cartão); documento nunca é persistido.
      paymentMethodId: z.string().regex(/^[a-z_]{2,30}$/),
      payer: z
        .object({
          email: z.string().email().max(254),
          identification: z.discriminatedUnion("type", [
            z.object({ type: z.literal("CPF"), number: z.string().regex(/^\d{11}$/) }).strict(),
            z.object({ type: z.literal("CNPJ"), number: z.string().regex(/^\d{14}$/) }).strict(),
          ]),
        })
        .strict(),
    })
    .strict(),
]);
export type CreateIntentInput = z.infer<typeof createIntentSchema>;

export const reconcileSchema = z.object({ resend: z.boolean().optional() }).strict();

/** Payload que identifica a operação para idempotência: SEM token, bandeira nem documento (vêm do componente; nunca persistidos). */
export function idempotentPayload(input: CreateIntentInput) {
  return { studentId: input.studentId, amountCents: input.amountCents, channel: input.channel, installments: 1 };
}

const PIX_IMAGE_MAX = 300_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Resposta do provedor só é aceita se for coerente; o contrário é tratado como incerta (a cobrança pode existir). */
export function checkCharge(channel: Channel, charge: ProviderCharge): string | null {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(charge.chargeId)) return "invalid_charge_id";
  if (typeof charge.providerStatus !== "string" || charge.providerStatus.length > 64) return "invalid_provider_status";
  if (channel === "card") return charge.outcome === "awaiting_payment" ? "unexpected_outcome" : null;
  // Pix já informado como pago pelo provedor (ex.: consulta depois do pagamento): "em análise" até a confirmação (F19).
  if (charge.outcome === "processing" || charge.outcome === "declined") return null;
  const pix = charge.pix;
  if (!pix || typeof pix.copyPaste !== "string" || pix.copyPaste.length < 10 || pix.copyPaste.length > 1024) return "invalid_pix_payload";
  if (pix.qrImagePngBase64 !== null && (pix.qrImagePngBase64.length > PIX_IMAGE_MAX || !BASE64.test(pix.qrImagePngBase64))) return "invalid_pix_image";
  if (Number.isNaN(Date.parse(pix.expiresAt))) return "invalid_pix_expiry";
  return null;
}

/** Estado exibido: Pix aguardando com validade vencida aparece "Expirada" (sem apagar nem descartar a intenção). */
export function displayStatusOf(status: IntentStatus, pix: PixData | null, now: Date): DisplayStatus {
  if (status === "awaiting_payment" && pix && Date.parse(pix.expiresAt) <= now.getTime()) return "expired";
  return status;
}

/** Intenção que ainda conta para o teto de abertas. */
export function isOpen(status: IntentStatus, pix: PixData | null, now: Date): boolean {
  return OPEN_STATUSES.includes(status) && displayStatusOf(status, pix, now) !== "expired";
}

/** Precisa de conciliação: incerta, ou `creating` parada (processo interrompido). */
export function needsReconcile(status: IntentStatus, updatedAtMs: number, now: Date): boolean {
  return status === "creation_uncertain" || (status === "creating" && now.getTime() - updatedAtMs >= STALE_CREATING_MS);
}

export type ReconcileDecision = "apply_found" | "resend" | "give_up" | "keep_uncertain";

/**
 * Decisão da conciliação depois da consulta. Reenvio SÓ quando pedido explicitamente pela família, para Pix (o token do
 * cartão é de uso único e não é guardado), dentro da janela de deduplicação do provedor e com a MESMA chave.
 */
export function decideReconcile(input: { found: boolean; channel: Channel; resend: boolean; createdAtMs: number; now: Date; idempotencyWindowMs: number }): ReconcileDecision {
  if (input.found) return "apply_found";
  const age = input.now.getTime() - input.createdAtMs;
  if (input.resend && input.channel === "pix" && age < input.idempotencyWindowMs) return "resend";
  if (age >= GIVE_UP_UNCERTAIN_MS) return "give_up";
  return "keep_uncertain";
}
