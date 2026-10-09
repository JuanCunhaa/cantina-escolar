import { createHash } from "node:crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { addDays, localInstant, type LocalDate } from "@/lib/dates/school-time";
import type { ReadMeter } from "./sales-meter";
import type { AdjustmentFact, CancellationFact, LedgerFact, LossFact, PurchaseFact, PurchaseReversalFact, RetainedFact, SaleFact } from "./sales-model";

/**
 * Projeção diária PERSISTIDA dos relatórios de vendas (F21) — `reportDays/{AAAA-MM-DD}` (+ `parts/pNNN`).
 *
 * Por quê: reler todas as fontes do período a cada abertura custa milhares de leituras do Firestore (a cota gratuita é de 50 000
 * por dia e a homologação já a estourou numa rodada de testes). Um DIA FECHADO é imutável — todo fato nasce com o carimbo do
 * servidor do momento do commit, então depois da meia-noite local nenhum fato novo pode cair nele —, então seus fatos são
 * materializados UMA vez e as próximas aberturas leem poucos documentos por dia.
 *
 * Por que o dia fechado não recebe evento: movimento de estoque, lançamento de carteira, cancelamento, entrada e resolução nascem
 * com `serverTimestamp()` do commit — reembolso, estorno, troca ou conferência feitos DEPOIS caem no dia em que acontecem; a conferência
 * de taxa/liquidação (F20) mexe nos recebimentos, que são lidos ao vivo. Só dados que não mudam entram no cache (por isso o valor pago do
 * pedido, mutável por troca, NÃO é gravado: só a contagem de violações medida na materialização).
 *
 * Contrato (projeção, não fonte): (1) as fontes continuam a verdade; apagar `reportDays` não muda nenhum número, só o custo da
 * próxima leitura; (2) a gravação é determinística e idempotente (mesmo conteúdo ⇒ mesmo digest, repetir/concorrer não duplica);
 * (3) cada fato mantém o caminho do documento de origem; (4) `digest` (SHA-256 dos fatos ordenados) detecta parte adulterada ou
 * truncada — a leitura então descarta o cache e reconstrói; (5) dia com fonte truncada ou documento ilegível NUNCA é gravado como
 * se fosse completo; (6) o dia só é gravado se as fontes não mudaram DURANTE a leitura e só é reaproveitado se a contagem atual das
 * fontes ainda é a da materialização (um documento tardio, mesmo que o código nunca o produza, invalida o dia); (7) `verifyDay` compara cache × fontes (reconciliação) e `rebuildDay` reaplica (replay). O dia corrente e as
 * posições (pedidos a realizar, reversões, recebimentos da F20, saldo das carteiras) seguem ao vivo.
 */
export const SCHEMA_VERSION = 2;
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
  /** Pedidos/vendas do dia cujas baixas somam MAIS que o valor pago registrado neles (conferência entre fontes, medida na leitura). */
  paidViolations: number;
};

export const FACT_KEYS = ["sales", "losses", "adjustments", "purchases", "purchaseReversals", "cancellations", "ledger", "retained"] as const;
type FactKey = (typeof FACT_KEYS)[number];

export const emptyDayFacts = (): DayFacts => ({ sales: [], losses: [], adjustments: [], purchases: [], purchaseReversals: [], cancellations: [], ledger: [], retained: [], unreadable: {}, truncated: [], paidViolations: 0 });

export function mergeDayFacts(list: readonly DayFacts[]): DayFacts {
  const out = emptyDayFacts();
  for (const f of list) {
    for (const k of FACT_KEYS) (out[k] as { id: string }[]).push(...(f[k] as { id: string }[]));
    for (const [source, n] of Object.entries(f.unreadable)) out.unreadable[source] = (out.unreadable[source] ?? 0) + n;
    for (const t of f.truncated) if (!out.truncated.includes(t)) out.truncated.push(t);
    out.paidViolations += f.paidViolations ?? 0;
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
  return JSON.stringify(stable({ ...Object.fromEntries(FACT_KEYS.map((k) => [k, sorted(f[k] as { id: string }[])])), unreadable: f.unreadable, truncated: [...f.truncated].sort(), paidViolations: f.paidViolations ?? 0 }));
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
  // Ilegíveis/truncados (vazios em dia gravado) e as violações medidas acompanham a primeira parte.
  parts[0]!.unreadable = { ...f.unreadable };
  parts[0]!.truncated = [...f.truncated];
  parts[0]!.paidViolations = f.paidViolations ?? 0;
  return parts;
}

/* ------------------------------------------------------------------------------------------------- persistência */

const dayRef = (db: Firestore, date: LocalDate) => db.doc(`reportDays/${date}`);
const partsRef = (db: Firestore, date: LocalDate) => db.collection(`reportDays/${date}/parts`);
const partId = (i: number) => `p${String(i).padStart(3, "0")}`;

/** Contagem de documentos de cada fonte no dia (consultas de agregação: ~1 leitura por 1 000 documentos). */
export type SourceCounts = { movements: number; cancellations: number; entries: number; receipts: number; resolved: number };
export const sameCounts = (a: SourceCounts, b: SourceCounts): boolean => a.movements === b.movements && a.cancellations === b.cancellations && a.entries === b.entries && a.receipts === b.receipts && a.resolved === b.resolved;

/** Conta as fontes do dia. Serve para detectar mudança durante a materialização e documento tardio depois dela. */
export async function countSources(db: Firestore, date: LocalDate, meter?: ReadMeter): Promise<SourceCounts> {
  const start = Timestamp.fromDate(localInstant(date, "00:00"));
  const end = Timestamp.fromDate(localInstant(addDays(date, 1), "00:00"));
  const count = async (label: string, query: { count(): { get(): Promise<{ data(): { count: number } }> } }): Promise<number> => {
    const n = (await query.count().get()).data().count;
    meter?.aggregate(`contagem: ${label}`, n);
    return n;
  };
  const inDay = (name: string) => db.collectionGroup(name).where("createdAt", ">=", start).where("createdAt", "<", end);
  const [movements, cancellations, entries, receipts, resolved] = await Promise.all([
    count("movimentos", inDay("movements")),
    count("cancelamentos", inDay("cancellations")),
    count("lançamentos", inDay("entries")),
    count("entradas", db.collection("stockReceipts").where("createdAt", ">=", start).where("createdAt", "<", end)),
    count("resoluções", db.collection("orders").where("nonPickup.resolution.resolvedAt", ">=", start).where("nonPickup.resolution.resolvedAt", "<", end)),
  ]);
  return { movements, cancellations, entries, receipts, resolved };
}

export type DayMeta = { schemaVersion: number; date: string; parts: number; digest: string; counts: Record<string, number>; sourceCounts: SourceCounts };

export type DayRead = { status: "hit"; facts: DayFacts; digest: string; sourceCounts: SourceCounts } | { status: "absent" } | { status: "invalid"; reason: string };

/**
 * Lê o dia materializado. `absent` = nunca gravado; `invalid` = de outra versão, incompleto, ilegível ou com digest que não confere
 * (o chamador descarta e reconstrói). A conferência com a contagem atual das fontes é do chamador (`countSources`).
 */
export async function readDay(db: Firestore, date: LocalDate, meter?: ReadMeter): Promise<DayRead> {
  const meta = await dayRef(db, date).get();
  meter?.read("cache: resumo do dia", 1);
  if (!meta.exists) return { status: "absent" };
  const m = meta.data() as Partial<DayMeta>;
  if (m.schemaVersion !== SCHEMA_VERSION) return { status: "invalid", reason: "versão antiga" };
  if (m.date !== date || typeof m.parts !== "number" || m.parts < 1 || typeof m.digest !== "string" || !m.sourceCounts) return { status: "invalid", reason: "resumo incompleto" };
  const snaps = await partsRef(db, date).get();
  meter?.query("cache: partes do dia", snaps.size);
  if (snaps.size < m.parts) return { status: "invalid", reason: "parte ausente" };
  try {
    const byId = new Map(snaps.docs.map((d) => [d.id, d]));
    const loaded = Array.from({ length: m.parts }, (_, i) => {
      const d = byId.get(partId(i));
      if (!d || typeof d.get("json") !== "string") throw new Error("parte ausente");
      return JSON.parse(d.get("json") as string) as DayFacts;
    });
    const facts = mergeDayFacts(loaded);
    if (digestOf(facts) !== m.digest) return { status: "invalid", reason: "digest não confere" };
    return { status: "hit", facts, digest: m.digest, sourceCounts: m.sourceCounts };
  } catch {
    return { status: "invalid", reason: "parte ilegível" };
  }
}

/**
 * Grava o dia (partes primeiro, resumo por último: o resumo presente = dia completo). Idempotente. Recusa dia incompleto.
 * `hooks.beforeMeta` existe só para os testes simularem queda entre as partes e o resumo.
 */
export async function writeDay(db: Firestore, date: LocalDate, facts: DayFacts, sourceCounts: SourceCounts, meter?: ReadMeter, hooks?: { beforeMeta?: () => Promise<void> }): Promise<{ digest: string; parts: number }> {
  if (!isComplete(facts)) throw new Error("Dia incompleto não é materializado.");
  const parts = chunkFacts(facts);
  const digest = digestOf(facts);
  const existing = await partsRef(db, date).listDocuments();
  meter?.read("cache: partes existentes (listagem)", existing.length);
  const batch = db.batch();
  parts.forEach((p, i) => batch.set(partsRef(db, date).doc(partId(i)), { json: JSON.stringify(p) }));
  const keep = new Set(parts.map((_, i) => partId(i)));
  for (const ref of existing) if (!keep.has(ref.id)) batch.delete(ref);
  await batch.commit();
  await hooks?.beforeMeta?.();
  const meta: DayMeta = { schemaVersion: SCHEMA_VERSION, date, parts: parts.length, digest, counts: countsOf(facts), sourceCounts };
  await dayRef(db, date).set({ ...meta, builtAt: FieldValue.serverTimestamp() });
  meter?.write(parts.length + 1);
  return { digest, parts: parts.length };
}
