import { Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { localDateOf, type LocalDate } from "@/lib/dates/school-time";
import type { FeeRecord, PaymentMethod } from "@/modules/payments/methods";
import { feeRecordOf } from "@/modules/payments/methods";
import { settlementOf, type Settlement } from "@/modules/payments/topup-model";
import { DEFAULT_SOURCE_ID, ONLINE_SOURCE_ID, type FeeEstimate } from "./fee-model";

/**
 * Recebimento EXTERNO normalizado (F20): dinheiro, Pix ou cartão que entrou na escola. Três origens, cada uma no seu documento
 * (a projeção é reconstruível e nunca duplica estado): recarga manual (`topups`), recarga online confirmada (`topupIntents`) e
 * venda direta sem aluno (`directSales`). Compra com saldo da carteira NÃO é recebimento: não aparece aqui.
 */
export { POINTS, POINT_LABEL, RECEIPT_KINDS, RECEIPT_KIND_LABEL, type Point, type ReceiptKind } from "./receipt-labels";
import type { Point, ReceiptKind } from "./receipt-labels";

export type Receipt = {
  kind: ReceiptKind;
  id: string;
  ref: string;
  point: Point;
  operatorUid: string | null;
  operatorName: string | null;
  method: PaymentMethod;
  sourceId: string;
  receivedOn: LocalDate;
  receivedAtIso: string | null;
  grossCents: number;
  /** Devolvido/estornado até agora (estorno manual ou reversão externa contabilizada). */
  reversedCents: number;
  fee: FeeRecord;
  feeEstimate: FeeEstimate | null;
  settlement: Settlement;
  financeVersion: number;
  label: string;
  reference: string | null;
  status: string;
};

type Data = Record<string, unknown>;
const int = (v: unknown): number => (Number.isSafeInteger(v) ? (v as number) : 0);
const iso = (v: unknown): string | null => (v instanceof Timestamp ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);
const feeOf = (method: PaymentMethod, raw: unknown): FeeRecord => (raw && typeof raw === "object" ? (raw as FeeRecord) : feeRecordOf(method, undefined));

export const refOf = (kind: ReceiptKind, id: string): string => `${kind}:${id}`;

export function receiptOfTopup(id: string, d: Data): Receipt {
  const method = d.method as PaymentMethod;
  const operator = (d.operator ?? {}) as { uid?: string; name?: string };
  const receivedOn = String(d.receivedOn ?? "");
  const reference = d.reference as { raw?: string } | null;
  return {
    kind: "topup",
    id,
    ref: refOf("topup", id),
    point: "secretaria",
    operatorUid: operator.uid ?? null,
    operatorName: operator.name ?? null,
    method,
    sourceId: typeof d.sourceId === "string" ? d.sourceId : DEFAULT_SOURCE_ID,
    receivedOn,
    receivedAtIso: iso(d.receivedAt),
    grossCents: int(d.amountCents),
    reversedCents: int(d.reversedCents),
    fee: feeOf(method, d.fee),
    feeEstimate: (d.feeEstimate as FeeEstimate | null | undefined) ?? null,
    settlement: (d.settlement as Settlement | undefined) ?? settlementOf(method, receivedOn, undefined),
    financeVersion: int(d.financeVersion),
    label: `${String(d.studentName ?? "")}`.trim() || "Recarga",
    reference: reference?.raw ?? null,
    status: String(d.status ?? "confirmed"),
  };
}

export function receiptOfIntent(id: string, d: Data): Receipt | null {
  const confirmation = d.confirmation as { confirmedAt?: unknown } | undefined;
  const confirmedAt = confirmation?.confirmedAt instanceof Timestamp ? confirmation.confirmedAt.toDate() : null;
  if (!confirmation || !confirmedAt) return null; // sem crédito lançado = ainda não é recebimento
  const method: PaymentMethod = d.channel === "pix" ? "pix" : "card_credit";
  const receivedOn = localDateOf(confirmedAt);
  const reversal = d.reversal as { accountedCents?: number } | undefined;
  return {
    kind: "online_topup",
    id,
    ref: refOf("online_topup", id),
    point: "online",
    operatorUid: null,
    operatorName: null,
    method,
    sourceId: typeof d.feeSourceId === "string" ? d.feeSourceId : ONLINE_SOURCE_ID,
    receivedOn,
    receivedAtIso: confirmedAt.toISOString(),
    grossCents: int(d.amountCents),
    reversedCents: int(reversal?.accountedCents),
    fee: d.fee && typeof d.fee === "object" ? (d.fee as FeeRecord) : { status: "pending", cents: null, source: "provider" },
    feeEstimate: (d.feeEstimate as FeeEstimate | null | undefined) ?? null,
    settlement: (d.settlement as Settlement | undefined) ?? { status: "pending", expectedOn: null, settledOn: null, expectedSource: null },
    financeVersion: int(d.financeVersion),
    label: `${String(d.studentName ?? "")}`.trim() || "Recarga online",
    reference: typeof (d.confirmation as { orderId?: string }).orderId === "string" ? (d.confirmation as { orderId: string }).orderId : null,
    status: String(d.status ?? "confirmed"),
  };
}

export function receiptOfDirectSale(id: string, d: Data): Receipt {
  const payment = (d.payment ?? {}) as Data;
  const method = payment.method as PaymentMethod;
  const receivedOn = String(d.consumptionDate ?? "");
  return {
    kind: "direct_sale",
    id,
    ref: refOf("direct_sale", id),
    point: "counter",
    operatorUid: typeof d.createdByUid === "string" ? d.createdByUid : null,
    operatorName: null,
    method,
    sourceId: typeof payment.sourceId === "string" ? payment.sourceId : DEFAULT_SOURCE_ID,
    receivedOn,
    receivedAtIso: iso(d.createdAt),
    grossCents: int(payment.receivedCents ?? d.totalCents),
    reversedCents: 0,
    fee: feeOf(method, payment.fee),
    feeEstimate: (payment.feeEstimate as FeeEstimate | null | undefined) ?? null,
    settlement: (payment.settlement as Settlement | undefined) ?? settlementOf(method, receivedOn, undefined),
    financeVersion: int(payment.financeVersion),
    label: "Venda direta",
    reference: null,
    status: String(d.status ?? "completed"),
  };
}

/** Onde cada origem guarda taxa/liquidação: a venda direta aninha em `payment`. */
export const receiptDocRef = (db: Firestore, kind: ReceiptKind, id: string): DocumentReference => db.doc(`${kind === "topup" ? "topups" : kind === "online_topup" ? "topupIntents" : "directSales"}/${id}`);
export const receiptPath = (kind: ReceiptKind, field: string): string => (kind === "direct_sale" ? `payment.${field}` : field);

export function parseReceipt(kind: ReceiptKind, id: string, d: Data): Receipt | null {
  return kind === "topup" ? receiptOfTopup(id, d) : kind === "online_topup" ? receiptOfIntent(id, d) : receiptOfDirectSale(id, d);
}
