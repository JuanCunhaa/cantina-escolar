import type { DocumentReference, DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { conflict } from "@/lib/domain-error";
import type { LocalDate } from "@/lib/dates/school-time";
import type { PaymentMethod } from "@/modules/payments/methods";
import { DEFAULT_SOURCE_ID, applyRule, isFeeMethod, seriesIdOf, type FeeMethod, type RuleApplication, type RuleVersion, type SourceKind } from "./fee-model";

/**
 * Leitura das regras DENTRO da transação do recebimento (F20). O chamador junta `feeRefs` ao seu `getAll` (leituras antes de
 * qualquer escrita) e chama `feeApplicationOf` com os snapshots: a regra aplicada fica congelada no lançamento.
 */
export const isProductionEnv = (): boolean => process.env.APP_ENV === "production";

export type FeeRefs = { sourceId: string; method: FeeMethod; series: DocumentReference; source: DocumentReference | null };

/** `null` quando o meio não tem taxa (dinheiro): nada a ler. */
export function feeRefs(db: Firestore, method: PaymentMethod, sourceId: string | undefined): FeeRefs | null {
  if (!isFeeMethod(method)) return null;
  const id = sourceId ?? DEFAULT_SOURCE_ID;
  return { sourceId: id, method, series: db.doc(`feeSeries/${seriesIdOf(id, method)}`), source: id === DEFAULT_SOURCE_ID ? null : db.doc(`paymentSources/${id}`) };
}

export function refsToRead(refs: FeeRefs | null): DocumentReference[] {
  return refs ? [refs.series, ...(refs.source ? [refs.source] : [])] : [];
}

export function parseVersions(snap: DocumentSnapshot | undefined): RuleVersion[] {
  const raw = snap?.exists ? snap.get("versions") : null;
  return Array.isArray(raw) ? (raw as RuleVersion[]) : [];
}

export type SourceDoc = { sourceId: string; kind: SourceKind; name: string; methods: FeeMethod[]; active: boolean; fictitious: boolean };

export function parseSource(snap: DocumentSnapshot | undefined): SourceDoc | null {
  if (!snap?.exists) return null;
  return {
    sourceId: snap.id,
    kind: snap.get("kind") as SourceKind,
    name: String(snap.get("name") ?? ""),
    methods: (snap.get("methods") as FeeMethod[]) ?? [],
    active: snap.get("active") === true,
    fictitious: snap.get("fictitious") === true,
  };
}

/**
 * Maquininha escolhida pelo operador: precisa existir, estar ativa e aceitar o meio. Fonte inexistente/inativa/de outro meio =
 * 409 (nada gravado): a taxa não é "adivinhada" para outra fonte.
 */
export function assertTerminalFor(refs: FeeRefs, sourceSnap: DocumentSnapshot | undefined): void {
  if (!refs.source) return;
  const source = parseSource(sourceSnap);
  if (!source || !source.active || source.kind !== "terminal" || !source.methods.includes(refs.method)) {
    throw conflict("invalid_source", "Maquininha inexistente, inativa ou que não aceita este meio.", { sourceId: refs.sourceId });
  }
}

/** Estimativa e previsão de liquidação para o recebimento, pela versão em vigor na data (nenhuma = taxa fica pendente). */
export function feeApplicationOf(refs: FeeRefs | null, seriesSnap: DocumentSnapshot | undefined, input: { grossCents: number; receivedOn: LocalDate }): RuleApplication {
  if (!refs) return { estimate: null, expectedSettlementOn: null, issue: null };
  return applyRule(refs.series.id, parseVersions(seriesSnap), input, { production: isProductionEnv() });
}
