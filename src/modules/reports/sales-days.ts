import { createHash } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { LocalDate } from "@/lib/dates/school-time";
import type { AdjustmentFact, CancellationFact, LedgerFact, LossFact, PurchaseFact, PurchaseReversalFact, RetainedFact, SaleFact } from "./sales-model";

/**
 * Projeção diária PERSISTIDA dos relatórios de vendas (F21) — `reportDays/{AAAA-MM-DD}` (+ `parts/pNNN`).
 *
 * Por quê: reler todas as fontes do período a cada abertura custa milhares de leituras do Firestore (a cota gratuita é de 50 000
 * por dia e a homologação já a estourou numa rodada de testes). Um DIA FECHADO é imutável — todo fato nasce com o carimbo do
 * servidor do momento do commit, então depois da meia-noite local nenhum fato novo pode cair nele —, então seus fatos são
 * materializados UMA vez e as próximas aberturas leem poucos documentos por dia.
 *
 * Contrato (projeção, não fonte): (1) as fontes continuam a verdade; apagar `reportDays` não muda nenhum número, só o custo da
 * próxima leitura; (2) a gravação é determinística e idempotente (mesmo conteúdo ⇒ mesmo digest, repetir/concorrer não duplica);
 * (3) cada fato mantém o caminho do documento de origem; (4) `digest` (SHA-256 dos fatos ordenados) detecta parte adulterada ou
 * truncada — a leitura então descarta o cache e reconstrói; (5) dia com fonte truncada ou documento ilegível NUNCA é gravado como
 * se fosse completo; (6) `verifyDay` compara cache × fontes (reconciliação) e `rebuildDay` reaplica (replay). O dia corrente e as
 * posições (pedidos a realizar, reversões, recebimentos da F20, saldo das carteiras) seguem ao vivo.
 */
export const SCHEMA_VERSION = 1;
/** Um dia fecha 10 minutos depois da meia-noite local (folga para relógio e transações em andamento). */
export const CLOSE_GRACE_MS = 10 * 60_000;
/** Teto de bytes do texto JSON de cada parte (o documento do Firestore aceita ~1 MiB). */
export const PART_MAX_BYTES = 700_000;

export type DayFacts = {
  sales: SaleFact[];
  losses: LossFact[];
  adjustments: AdjustmentFact[];
  purchases: PurchaseFact[];
  purchaseReversals: PurchaseReversalFact[];
  cancellations: CancellationFact[];
  ledger: LedgerFact[];
  retained: RetainedFact[];
  /** Documentos de origem ilegíveis, por fonte. */
  unreadable: Record<string, number>;
  /** Fontes que bateram no teto de leitura. */
  truncated: string[];
};

export const FACT_KEYS = ["sales", "losses", "adjustments", "purchases", "purchaseReversals", "cancellations", "ledger", "retained"] as const;
type FactKey = (typeof FACT_KEYS)[number];

export const emptyDayFacts = (): DayFacts => ({ sales: [], losses: [], adjustments: [], purchases: [], purchaseReversals: [], cancellations: [], ledger: [], retained: [], unreadable: {}, truncated: [] });

export function mergeDayFacts(list: readonly DayFacts[]): DayFacts {
  const out = emptyDayFacts();
  for (const f of list) {
    for (const k of FACT_KEYS) (out[k] as { id: string }[]).push(...(f[k] as { id: string }[]));
    for (const [source, n] of Object.entries(f.unreadable)) out.unreadable[source] = (out.unreadable[source] ?? 0) + n;
    for (const t of f.truncated) if (!out.truncated.includes(t)) out.truncated.push(t);
  }
  return out;
}

export const isComplete = (f: DayFacts): boolean => f.truncated.length === 0 && Object.values(f.unreadable).every((n) => n === 0);
export const countsOf = (f: DayFacts): Record<FactKey, number> => Object.fromEntries(FACT_KEYS.map((k) => [k, f[k].length])) as Record<FactKey, number>;

/** Forma canônica: listas ordenadas pelo ID do fato, chaves de objeto em ordem fixa (a ordem de leitura do Firestore não importa). */
export function canonical(f: DayFacts): string {
  const sorted = (list: readonly { id: string }[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, stable(v)]));
    return value;
  };
  return JSON.stringify(stable({ ...Object.fromEntries(FACT_KEYS.map((k) => [k, sorted(f[k] as { id: string }[])])), unreadable: f.unreadable, truncated: [...f.truncated].sort() }));
}

export const digestOf = (f: DayFacts): string => createHash("sha256").update(canonical(f)).digest("hex");

/** Divide os fatos em partes cujo JSON não passa de `maxBytes` (uma lista nunca é cortada no meio de um fato). */
export function chunkFacts(f: DayFacts, maxBytes: number = PART_MAX_BYTES): DayFacts[] {
  const parts: DayFacts[] = [];
  let current = emptyDayFacts();
  let size = 0;
  const flush = () => {
    if (FACT_KEYS.some((k) => current[k].length > 0)) parts.push(current);
    current = emptyDayFacts();
    size = 0;
  };
  for (const k of FACT_KEYS) {
    for (const fact of f[k] as { id: string }[]) {
      const bytes = Buffer.byteLength(JSON.stringify(fact), "utf8") + 1;
      if (bytes > maxBytes) throw new RangeError("Um fato passa do tamanho máximo de uma parte.");
      if (size + bytes > maxBytes) flush();
      (current[k] as { id: string }[]).push(fact);
      size += bytes;
    }
  }
  flush();
  if (parts.length === 0) parts.push(emptyDayFacts());
  // Ilegíveis/truncados (vazios em dia gravado) acompanham a primeira parte.
  parts[0]!.unreadable = { ...f.unreadable };
  parts[0]!.truncated = [...f.truncated];
  return parts;
}

/* ------------------------------------------------------------------------------------------------- persistência */

const dayRef = (db: Firestore, date: LocalDate) => db.doc(`reportDays/${date}`);
const partsRef = (db: Firestore, date: LocalDate) => db.collection(`reportDays/${date}/parts`);
const partId = (i: number) => `p${String(i).padStart(3, "0")}`;

export type DayMeta = { schemaVersion: number; date: string; parts: number; digest: string; counts: Record<string, number> };

/** Lê o dia materializado. `null` = ausente, de outra versão, incompleto ou com digest que não confere (o chamador reconstrói). */
export async function readDay(db: Firestore, date: LocalDate): Promise<{ facts: DayFacts; digest: string } | null> {
  const meta = await dayRef(db, date).get();
  if (!meta.exists) return null;
  const m = meta.data() as Partial<DayMeta>;
  if (m.schemaVersion !== SCHEMA_VERSION || m.date !== date || typeof m.parts !== "number" || typeof m.digest !== "string" || m.parts < 1) return null;
  const snaps = await partsRef(db, date).get();
  if (snaps.size < m.parts) return null;
  try {
    const wanted = Array.from({ length: m.parts }, (_, i) => partId(i));
    const byId = new Map(snaps.docs.map((d) => [d.id, d]));
    const loaded = wanted.map((id) => {
      const d = byId.get(id);
      if (!d || typeof d.get("json") !== "string") throw new Error("parte ausente");
      return JSON.parse(d.get("json") as string) as DayFacts;
    });
    const facts = mergeDayFacts(loaded);
    return digestOf(facts) === m.digest ? { facts, digest: m.digest } : null;
  } catch {
    return null;
  }
}

/** Grava o dia (partes primeiro, resumo por último: o resumo presente = dia completo). Idempotente. Recusa dia incompleto. */
export async function writeDay(db: Firestore, date: LocalDate, facts: DayFacts): Promise<{ digest: string; parts: number }> {
  if (!isComplete(facts)) throw new Error("Dia incompleto não é materializado.");
  const parts = chunkFacts(facts);
  const digest = digestOf(facts);
  const existing = await partsRef(db, date).listDocuments();
  const batch = db.batch();
  parts.forEach((p, i) => batch.set(partsRef(db, date).doc(partId(i)), { json: JSON.stringify(p) }));
  const keep = new Set(parts.map((_, i) => partId(i)));
  for (const ref of existing) if (!keep.has(ref.id)) batch.delete(ref);
  await batch.commit();
  const meta: DayMeta = { schemaVersion: SCHEMA_VERSION, date, parts: parts.length, digest, counts: countsOf(facts) };
  await dayRef(db, date).set({ ...meta, builtAt: FieldValue.serverTimestamp() });
  return { digest, parts: parts.length };
}
