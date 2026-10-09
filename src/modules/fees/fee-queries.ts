import type { Firestore, Query } from "firebase-admin/firestore";
import { z } from "zod";
import { localDateOf, type LocalDate } from "@/lib/dates/school-time";
import { notFound } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { can } from "@/modules/access/permissions";
import type { FeeRecord, PaymentMethod } from "@/modules/payments/methods";
import type { Settlement } from "@/modules/payments/topup-model";
import { DEFAULT_SOURCE_ID, FEE_METHODS, FICTITIOUS_PREFIX, effectiveFee, resolveRule, seriesIdOf, type FeeEstimate, type FeeMethod, type RuleVersion, type SourceKind } from "./fee-model";
import { isProductionEnv, parseSource } from "./fee-store";
import { RECEIPT_KINDS, parseReceipt, receiptDocRef, type Point, type Receipt, type ReceiptKind } from "./receipts";

/** Leituras da administração (`finance.manage`) sobre cadastro de taxas e conferência de recebimentos (F20). */
export type SourceView = { sourceId: string; kind: SourceKind | "default"; name: string; methods: FeeMethod[]; active: boolean; fictitious: boolean };
export type VersionView = RuleVersion & { state: "withdrawn" | "future" | "in_effect" | "superseded" };
export type SeriesView = { seriesId: string; sourceId: string; method: FeeMethod; versions: VersionView[]; current: VersionView | null; blockedInProduction: boolean };
export type FeeConfig = { sources: SourceView[]; series: SeriesView[]; production: boolean; today: LocalDate };

const displayName = (name: string, fictitious: boolean) => (fictitious && !name.startsWith(FICTITIOUS_PREFIX) ? `${FICTITIOUS_PREFIX}${name}` : name);

export async function listFeeConfig(db: Firestore, actor: Actor, clock: () => Date = () => new Date()): Promise<FeeConfig> {
  authorize(actor, "finance.manage");
  const today = localDateOf(clock());
  const production = isProductionEnv();
  const [sourcesSnap, seriesSnap] = await Promise.all([db.collection("paymentSources").limit(200).get(), db.collection("feeSeries").limit(400).get()]);
  const sources: SourceView[] = [
    { sourceId: DEFAULT_SOURCE_ID, kind: "default", name: "Padrão (sem maquininha/provedor informado)", methods: [...FEE_METHODS], active: true, fictitious: false },
    ...sourcesSnap.docs.flatMap((d) => {
      const s = parseSource(d);
      return s ? [{ sourceId: s.sourceId, kind: s.kind, name: displayName(s.name, s.fictitious), methods: s.methods, active: s.active, fictitious: s.fictitious }] : [];
    }),
  ];
  const series: SeriesView[] = seriesSnap.docs
    .map((d) => {
      const versions = ((d.get("versions") as RuleVersion[] | undefined) ?? []).slice();
      const resolved = resolveRule(versions, today, { production: false });
      const inEffect = resolved.rule?.n ?? (versions.filter((v) => !v.withdrawn && v.effectiveFrom <= today).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.n ?? null);
      const view = versions.map((v): VersionView => ({ ...v, state: v.withdrawn ? "withdrawn" : v.effectiveFrom > today ? "future" : v.n === inEffect ? "in_effect" : "superseded" }));
      const current = view.find((v) => v.state === "in_effect") ?? null;
      return { seriesId: d.id, sourceId: String(d.get("sourceId")), method: d.get("method") as FeeMethod, versions: view, current, blockedInProduction: production && current?.fictitious === true };
    })
    .sort((a, b) => a.seriesId.localeCompare(b.seriesId));
  return { sources, series, production, today };
}

/* ---------------------------------------------------------------------------------------- conferência */

export type ReceiptAdminView = {
  ref: string;
  kind: ReceiptKind;
  point: Point;
  label: string;
  operatorName: string | null;
  method: PaymentMethod;
  sourceId: string;
  receivedOn: LocalDate;
  grossCents: number;
  reversedCents: number;
  fee: FeeRecord;
  estimate: FeeEstimate | null;
  effective: { basis: string; cents: number | null; estimatedCents: number | null; differenceCents: number | null };
  settlement: Settlement;
  overdue: boolean;
  financeVersion: number;
  reference: string | null;
};

export function adminViewOf(r: Receipt, today: LocalDate): ReceiptAdminView {
  const eff = effectiveFee(r.fee, r.feeEstimate);
  return {
    ref: r.ref,
    kind: r.kind,
    point: r.point,
    label: r.label,
    operatorName: r.operatorName,
    method: r.method,
    sourceId: r.sourceId,
    receivedOn: r.receivedOn,
    grossCents: r.grossCents,
    reversedCents: r.reversedCents,
    fee: r.fee,
    estimate: r.feeEstimate,
    effective: { basis: eff.basis, cents: eff.cents, estimatedCents: eff.estimatedCents, differenceCents: eff.differenceCents },
    settlement: r.settlement,
    overdue: r.settlement.status === "pending" && r.settlement.expectedOn !== null && r.settlement.expectedOn < today,
    financeVersion: r.financeVersion,
    reference: r.reference,
  };
}

const CAP = 150;
const COLLECTION: Record<ReceiptKind, string> = { topup: "topups", online_topup: "topupIntents", direct_sale: "directSales" };
const PREFIX: Record<ReceiptKind, string> = { topup: "", online_topup: "", direct_sale: "payment." };

export type ReconcileList = { today: LocalDate; items: ReceiptAdminView[]; truncated: boolean };

/** Recebimentos com taxa sem valor real/informado OU liquidação pendente, do mais antigo ao mais novo; vencidas sinalizadas. */
export async function listPendingReconciliation(db: Firestore, actor: Actor, clock: () => Date = () => new Date()): Promise<ReconcileList> {
  authorize(actor, "finance.manage");
  const today = localDateOf(clock());
  const queries: { kind: ReceiptKind; query: Query }[] = RECEIPT_KINDS.flatMap((kind) => [
    { kind, query: db.collection(COLLECTION[kind]).where(`${PREFIX[kind]}fee.status`, "==", "pending").limit(CAP + 1) },
    { kind, query: db.collection(COLLECTION[kind]).where(`${PREFIX[kind]}settlement.status`, "==", "pending").limit(CAP + 1) },
  ]);
  const snaps = await Promise.all(queries.map((q) => q.query.get()));
  const seen = new Map<string, ReceiptAdminView>();
  let truncated = false;
  snaps.forEach((snap, i) => {
    const kind = queries[i]!.kind;
    if (snap.size > CAP) truncated = true;
    for (const d of snap.docs.slice(0, CAP)) {
      const r = parseReceipt(kind, d.id, d.data());
      if (r && r.method !== "cash" && !seen.has(r.ref)) seen.set(r.ref, adminViewOf(r, today));
    }
  });
  return { today, items: [...seen.values()].sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.ref.localeCompare(b.ref)), truncated };
}

export type ReconciliationEvent = { seq: number; correction: boolean; reason: string | null; byName: string; on: string; before: { fee: FeeRecord; settlement: Settlement }; after: { fee: FeeRecord; settlement: Settlement } };
const refQuery = z.string().regex(/^(topup|online_topup|direct_sale):[A-Za-z0-9_-]{1,128}$/);

/** Um recebimento com o histórico de conferências (o valor anterior é preservado em cada evento). */
export async function getReceiptForAdmin(db: Firestore, actor: Actor, rawRef: unknown, clock: () => Date = () => new Date()): Promise<{ receipt: ReceiptAdminView; events: ReconciliationEvent[] }> {
  authorize(actor, "finance.manage");
  const ref = refQuery.parse(rawRef);
  const [kind, id] = ref.split(":") as [ReceiptKind, string];
  const snap = await receiptDocRef(db, kind, id).get();
  const receipt = snap.exists ? parseReceipt(kind, id, snap.data()!) : null;
  if (!receipt) throw notFound("receipt_not_found", "Recebimento não encontrado.");
  const events = await db.collection(`${snap.ref.path}/reconciliations`).orderBy("seq", "asc").limit(100).get();
  return {
    receipt: adminViewOf(receipt, localDateOf(clock())),
    events: events.docs.map((d) => ({ seq: Number(d.get("seq")), correction: d.get("correction") === true, reason: (d.get("reason") as string | null) ?? null, byName: String(d.get("operator.name") ?? ""), on: String(d.get("createdOn") ?? ""), before: d.get("before"), after: d.get("after") })),
  };
}

export { seriesIdOf };

/* ------------------------------------------------------------------------- maquininhas para o operador */

export type TerminalOption = { sourceId: string; name: string; methods: FeeMethod[] };

/** Só o necessário para escolher a maquininha no recebimento; regras de taxa e prazos ficam com a administração. */
export async function listTerminals(db: Firestore, actor: Actor): Promise<{ terminals: TerminalOption[] }> {
  if (!can(actor, "topup.register") && !can(actor, "pos.operate") && !can(actor, "finance.manage")) throw new ForbiddenError("Sem permissão: maquininhas.");
  const snap = await db.collection("paymentSources").where("kind", "==", "terminal").where("active", "==", true).limit(100).get();
  const terminals = snap.docs.flatMap((d) => {
    const s = parseSource(d);
    return s ? [{ sourceId: s.sourceId, name: displayName(s.name, s.fictitious), methods: s.methods }] : [];
  });
  return { terminals: terminals.sort((a, b) => a.name.localeCompare(b.name)) };
}
