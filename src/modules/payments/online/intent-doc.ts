import type { Timestamp } from "firebase-admin/firestore";
import type { FeeEstimate } from "@/modules/fees/fee-model";
import type { FeeRecord } from "../methods";
import type { Settlement } from "../topup-model";
import type { DisputeStatus, ReviewReason } from "./confirmation-model";
import type { Channel, IntentStatus } from "./intent-model";
import type { PixData } from "./provider";

/**
 * Documento `topupIntents/{tpi_…}` (só servidor; Rules fecham ao cliente). F18 cria e conduz até a cobrança; F19 acrescenta a
 * confirmação (`confirmation`), a revisão (`review`), a reversão externa (`reversal`), taxa e liquidação pendentes.
 */
export type IntentDoc = {
  intentId: string;
  channel: Channel;
  status: IntentStatus;
  studentId: string;
  studentName: string;
  amountCents: number;
  currency: "BRL";
  provider: { id: string; mode: "demo" | "live"; accountId?: string };
  payer: { name: string; email: string };
  charge: { id: string; providerStatus: string } | null;
  pix: PixData | null;
  failure: { code: string } | null;
  creation: { attempts: number; lastOutcome: string | null; lastCheckedAt: Timestamp | null };
  /** Crédito lançado (F19): existe só quando `status` foi `confirmed` alguma vez (`reversed` também mantém). */
  confirmation?: {
    orderId: string;
    paymentId: string | null;
    source: "webhook" | "reconcile" | "sweep" | "admin";
    paidCents: number;
    confirmedAt: Timestamp;
    /** Pagamento confirmado depois de a intenção já constar como expirada/falha ou o Pix vencer pela validade local. */
    afterExpiry: boolean;
    walletEntryId: string;
    walletSeq: number;
    balanceAfterCents: number;
  };
  /** Reversões externas contabilizadas (F19): `accountedCents` = recuperado da carteira + pendente. */
  reversal?: { accountedCents: number; recoveredCents: number; pendingCents: number; cause: "refund" | "chargeback"; lastEntryId: string | null };
  review?: { reason: ReviewReason; at: Timestamp };
  /** Contestação no provedor (F19): `open` não mexe na carteira; `lost` gerou a reversão; `won_after_reversal` pede decisão humana. */
  dispute?: { status: DisputeStatus; at: Timestamp };
  /**
   * Taxa e liquidação (F20): `fee`/`settlement` EFETIVOS (pendentes até a conferência da administração); `feeEstimate` é a estimativa
   * congelada com a regra aplicada no crédito. Nada disso altera o crédito (bruto integral).
   */
  fee?: FeeRecord;
  feeEstimate?: FeeEstimate | null;
  feeSourceId?: string;
  settlement?: Settlement;
  /** Versão da conferência financeira (F20), independente de `version` (ordem das notificações). */
  financeVersion?: number;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
