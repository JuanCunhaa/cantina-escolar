import { AggregateField, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { z } from "zod";
import { addDays, isLocalDate, localDateOf, type LocalDate } from "@/lib/dates/school-time";
import { conflict } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { ForbiddenError } from "@/modules/access/errors";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { averageUnitMicros } from "@/modules/inventory/cost";
import { OPEN_STATUSES } from "@/modules/orders/fulfillment-model";
import { buildReport, readReceiptsInRange } from "./finance-report";
import {
  CHANNELS,
  MAX_SALES_DAYS,
  buildSalesReport,
  filtersSchema,
  saleMatches,
  toOperational,
  type Filters,
  type OperationalReport,
  type PendingOrderFact,
  type ProjectionStats,
  type ReversalFact,
  type SaleFact,
  type SalesInput,
  type SalesReport,
} from "./sales-model";
import { CLOSE_GRACE_MS, countSources, countsOf, digestOf, emptyDayFacts, isComplete, mergeDayFacts, readDay, sameCounts, writeDay, type DayFacts, type DayRead, type SourceCounts } from "./sales-days";
import { ReadMeter } from "./sales-meter";
import { ProductDirectory, getMany, readFacts } from "./sales-read";
import { pendingOrderOf, reversalFactOf } from "./sales-sources";
import { buildSalesTables, SALES_VIEWS, type SalesView } from "./sales-tables";
import { tableCsv } from "./table";
import { tableXlsx } from "./xlsx";

/**
 * Relatórios de vendas, CMV, margens, perdas, compras, pedidos a realizar, cancelamentos e carteira (F21).
 *
 * Projeção RECONSTRUÍVEL a partir das fontes (movimentos de estoque, pedidos/vendas diretas de origem, cancelamentos, livro, entradas):
 * - dia CORRENTE (e o que ainda não fechou há 10 min) é lido AO VIVO das fontes;
 * - dia FECHADO é imutável: é materializado UMA vez em `reportDays/{data}` (`sales-days.ts`) e as próximas aberturas leem poucos
 *   documentos por dia (a cota gratuita de leituras do Firestore não comporta reler o período inteiro a cada abertura);
 * - apagar `reportDays` não muda nenhum número (reconstrói das fontes); o digest detecta cache adulterado; `verify`/`rebuild` da
 *   administração comparam e reaplicam; dia com fonte truncada ou documento ilegível NÃO é gravado como se estivesse completo;
 * - posições de hoje (pedidos a realizar, reversões externas, recebimentos/taxas da F20, saldo das carteiras) são sempre ao vivo.
 * Limite honesto: período ≤ 93 dias, teto de leitura por fonte e orçamento de tempo para materializar dias novos; acima deles o
 * relatório diz "parcial" (pendência) e a exportação é RECUSADA (nunca truncada em silêncio).
 */
export const SOURCE_CAP = 20_000;
/** Tempo máximo (ms) gasto materializando dias novos numa só chamada; o resto fica "em construção" e termina nas próximas. */
export const BUILD_BUDGET_MS = 40_000;
/**
 * Posição de pedidos a realizar: lê os abertos com data de consumo a partir de hoje − esta janela. Pedido aberto ANTERIOR à janela
 * (esquecido, sem resolução) não é lido documento a documento — seria leitura sem limite a cada abertura —, mas é CONTADO por agregação
 * e vira pendência visível (`pending_older`).
 */
export const PENDING_LOOKBACK_DAYS = 45;
const BUILD_CONCURRENCY = 4;

const RANGE = z.object({ from: z.string().refine(isLocalDate), to: z.string().refine(isLocalDate) }).strict();
const QUERY = RANGE.merge(filtersSchema).strict();
export type SalesQuery = { from: LocalDate; to: LocalDate; filters: Filters };

/** Entrada da query string/corpo: valores vazios (filtro "todos") são descartados antes da validação estrita. */
export function parseSalesQuery(raw: unknown): SalesQuery {
  const clean = Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).filter(([, v]) => v !== "" && v !== undefined && v !== null));
  const q = QUERY.parse(clean);
  if (q.from > q.to) throw conflict("invalid_range", "Período invertido.");
  if (q.to > addDays(q.from, MAX_SALES_DAYS - 1)) throw conflict("range_too_long", "Período máximo de ~3 meses.", { maxDays: MAX_SALES_DAYS });
  const filters: Filters = {};
  for (const k of ["shiftId", "productId", "categoryId", "channel"] as const) if (q[k] !== undefined) (filters as Record<string, unknown>)[k] = q[k];
  return { from: q.from, to: q.to, filters: filtersSchema.parse(filters) };
}

/** `full` (custos, margens, resultado) só com finance.manage + costs.read + profit.read; `operational` com reports.operational; senão 403. */
export function reportScope(actor: Actor): "full" | "operational" {
  if (can(actor, "finance.manage") && can(actor, "costs.read") && can(actor, "profit.read")) return "full";
  authorize(actor, "reports.operational");
  return "operational";
}

/* ------------------------------------------------------------------------------------------------------- leitura */

/** `hooks` existe SÓ para os testes (mudança durante a leitura, queda entre as partes e o resumo, falha de gravação). */
export type LoadOptions = {
  cap?: number;
  buildBudgetMs?: number;
  hooks?: { afterRead?: (date: LocalDate) => Promise<void>; beforeMeta?: (date: LocalDate) => Promise<void>; failWrite?: (date: LocalDate) => boolean };
};

export type LoadedSales = {
  input: SalesInput;
  /** Baixas já filtradas, para o detalhe exportado conferir com os totais. */
  sales: SaleFact[];
  scope: "full" | "operational";
};

const eachDay = (from: LocalDate, to: LocalDate): LocalDate[] => {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Primeiro dia que AINDA não fechou: ontem só fecha 10 minutos depois da meia-noite local. */
export const closedBefore = (now: Date): LocalDate => localDateOf(new Date(now.getTime() - CLOSE_GRACE_MS));

/** Executa `fn` sobre `items` com no máximo `limit` em paralelo, preservando a ordem do resultado. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const emptyProjection = (): ProjectionStats => ({ cachedDays: 0, builtDays: 0, liveDays: 0, building: [], staleDays: 0, repairedDays: 0, unstableDays: 0, cacheErrors: 0 });

/**
 * Fatos do período: dias fechados pelo cache (se ainda válido) ou materializando; dia corrente ao vivo.
 * Um dia do cache só vale se (a) versão/partes/digest conferem E (b) a contagem atual das fontes é a da materialização — senão é
 * descartado e reconstruído. Reconstruir mede as fontes antes e depois da leitura: se mudaram no meio, o dia é usado mas NÃO gravado.
 * Falha ao ler ou gravar o cache nunca derruba o relatório: segue pelas fontes.
 */
async function loadFacts(db: Firestore, range: { from: LocalDate; to: LocalDate }, now: Date, cap: number, budgetMs: number, products: () => Promise<ProductDirectory>, meter: ReadMeter, hooks: LoadOptions["hooks"]): Promise<{ facts: DayFacts; projection: ProjectionStats }> {
  const projection = emptyProjection();
  const before = closedBefore(now);
  const days = eachDay(range.from, range.to);
  const closed = days.filter((d) => d < before);
  const open = days.filter((d) => d >= before);
  const deadline = Date.now() + budgetMs;

  const perDay = await pool(closed, BUILD_CONCURRENCY, async (date): Promise<DayFacts | null> => {
    let cached: DayRead = { status: "absent" };
    try {
      cached = await readDay(db, date, meter);
    } catch {
      projection.cacheErrors += 1;
    }
    let known: SourceCounts | null = null; // contagem fresca já obtida (reaproveitada como "antes" da reconstrução)
    if (cached.status === "hit") {
      known = await countSources(db, date, meter);
      if (sameCounts(known, cached.sourceCounts)) {
        projection.cachedDays += 1;
        return cached.facts;
      }
      projection.staleDays += 1; // documento tardio (ou removido) depois da materialização: descarta e reconstrói
    } else if (cached.status === "invalid") projection.repairedDays += 1;

    if (Date.now() > deadline) {
      projection.building.push(date);
      return null;
    }
    const first = known ?? (await countSources(db, date, meter));
    const facts = await readFacts(db, { from: date, to: date }, { cap, products: await products(), meter });
    await hooks?.afterRead?.(date);
    const second = await countSources(db, date, meter);
    if (!sameCounts(first, second)) {
      projection.unstableDays += 1; // as fontes mudaram durante a leitura: usa agora, não grava
      projection.liveDays += 1;
      return facts;
    }
    if (!isComplete(facts)) {
      projection.liveDays += 1; // incompleto: usado agora, nunca gravado como completo
      return facts;
    }
    try {
      if (hooks?.failWrite?.(date)) throw new Error("falha de gravação simulada");
      await writeDay(db, date, facts, second, meter, { beforeMeta: () => hooks?.beforeMeta?.(date) ?? Promise.resolve() });
      projection.builtDays += 1;
    } catch {
      projection.cacheErrors += 1;
      projection.liveDays += 1;
    }
    return facts;
  });
  projection.building.sort();

  const live = open.length > 0 ? await readFacts(db, { from: open[0]!, to: open.at(-1)! }, { cap, products: await products(), meter }) : emptyDayFacts();
  projection.liveDays += open.length;
  return { facts: mergeDayFacts([...perDay.filter((f): f is DayFacts => f !== null), live]), projection };
}

/** Pedidos ainda em aberto com data de consumo ANTERIOR à janela: só a contagem (agregação), nunca os documentos. */
async function countOlderOpenOrders(db: Firestore, before: LocalDate, meter: ReadMeter): Promise<number> {
  const counts = await Promise.all(
    [...OPEN_STATUSES, "not_picked_up"].map(async (status) => {
      const n = (await db.collection("orders").where("status", "==", status).where("consumptionDate", "<", before).count().get()).data().count;
      meter.aggregate("pedidos em aberto antigos (contagem)", n);
      return n;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

const labelsOf = (docs: QueryDocumentSnapshot[]) => Object.fromEntries(docs.map((d) => [d.id, typeof d.get("name") === "string" ? (d.get("name") as string) : d.id]));

/** Lê as fontes do período e monta a entrada pura da projeção. */
export async function loadSalesSources(db: Firestore, query: SalesQuery, scope: "full" | "operational", clock: () => Date = () => new Date(), opts: LoadOptions = {}): Promise<LoadedSales> {
  const cap = opts.cap ?? SOURCE_CAP;
  const now = clock();
  const today = localDateOf(now);
  const full = scope === "full";
  const meter = new ReadMeter();
  const pendingFrom = addDays(today, -PENDING_LOOKBACK_DAYS);
  let directory: Promise<ProductDirectory> | null = null;
  const products = () => (directory ??= ProductDirectory.load(db, meter));

  const [{ facts, projection }, categoriesSnap, shiftsSnap, openSnaps] = await Promise.all([
    loadFacts(db, query, now, cap, opts.buildBudgetMs ?? BUILD_BUDGET_MS, products, meter, opts.hooks),
    db.collection("categories").limit(1000).get(),
    db.collection("shifts").limit(200).get(),
    // Posição de HOJE: pedidos pagos ainda não realizados (sempre ao vivo), só da janela; os mais antigos são apenas contados.
    Promise.all([...OPEN_STATUSES, "not_picked_up"].map((status) => db.collection("orders").where("status", "==", status).where("consumptionDate", ">=", pendingFrom).limit(cap + 1).get())),
  ]);
  const olderOpen = await countOlderOpenOrders(db, pendingFrom, meter);
  const dir = await products();
  meter.query("categorias", categoriesSnap.size);
  meter.query("turnos", shiftsSnap.size);
  for (const snap of openSnaps) meter.query("pedidos em aberto (posição de hoje)", snap.size);
  const truncated = [...facts.truncated];
  if (openSnaps.some((s) => s.size > cap)) truncated.push("pedidos a realizar");
  const unreadable: Record<string, number> = { ...facts.unreadable };
  const bad = (source: string) => (unreadable[source] = (unreadable[source] ?? 0) + 1);

  const pending: PendingOrderFact[] = [];
  for (const snap of openSnaps) {
    for (const d of snap.docs.slice(0, cap)) {
      const f = pendingOrderOf(d.id, d.data(), dir.map);
      if (f) {
        if (f.lines.length > 0) pending.push(f);
      } else bad("pedidos a realizar");
    }
  }

  const reversals: ReversalFact[] = [];
  let receiptsSummary: SalesInput["receipts"] = null;
  let fees: SalesInput["fees"] = { effectiveCents: 0, unknownCount: 0, unknownGrossCents: 0, fictitiousCount: 0 };
  let walletBalanceCents: number | null = null;
  let walletCount: number | null = null;
  let avgCost: Map<string, number | null> | null = null;
  const production = process.env.APP_ENV === "production";
  if (full) {
    const [receipts, pendencyDocs, wallets] = await Promise.all([
      readReceiptsInRange(db, query),
      db.collection("paymentPendencies").limit(cap + 1).get(),
      db
        .collection("wallets")
        .aggregate({ total: AggregateField.sum("balanceCents"), count: AggregateField.count() })
        .get()
        .then((s) => s.data())
        .catch(() => null),
    ]);
    meter.read("recebimentos (F20, estimado)", receipts.receipts.length);
    meter.query("pendências de reversão", pendencyDocs.size);
    meter.aggregate("carteiras (saldo agregado)", wallets?.count ?? 0);
    if (receipts.truncated) truncated.push("recebimentos");
    if (pendencyDocs.size > cap) truncated.push("pendências de reversão");
    for (const d of pendencyDocs.docs.slice(0, cap)) {
      const f = reversalFactOf(d.id, d.data());
      if (f) reversals.push(f);
      else bad("pendências de reversão");
    }
    const finance = buildReport(receipts.receipts, query, today, { truncated: receipts.truncated, production }).totals;
    const { count, grossCents, reversedCents, feeConfirmedCents, feeInformedCents, feeEstimatedCents, feeUnknownCount, feeEffectiveCents, netExpectedCents, netRealCents, settledGrossCents, pendingGrossCents, overdueGrossCents } = finance;
    receiptsSummary = { count, grossCents, reversedCents, feeConfirmedCents, feeInformedCents, feeEstimatedCents, feeUnknownCount, feeEffectiveCents, netExpectedCents, netRealCents, settledGrossCents, pendingGrossCents, overdueGrossCents };
    fees = { effectiveCents: finance.feeEffectiveCents, unknownCount: finance.feeUnknownCount, unknownGrossCents: finance.feeUnknownGrossCents, fictitiousCount: finance.fictitiousCount };
    if (wallets) {
      walletBalanceCents = typeof wallets.total === "number" ? wallets.total : 0;
      walletCount = wallets.count;
    }
    // Custo médio ATUAL, só para ESTIMAR a margem dos pedidos a realizar (não é histórico: o CMV real nasce na baixa).
    const ids = [...new Set(pending.flatMap((o) => o.lines.map((l) => l.productId)))].filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id));
    avgCost = new Map();
    const docs = await getMany(db, ids.flatMap((id) => [db.doc(`stockCosts/${id}`), db.doc(`stockBalances/${id}`)]), meter, "custo médio atual");
    for (let i = 0; i < ids.length; i += 1) {
      const value = docs[i * 2]!.get("valueMicros");
      const onHand = docs[i * 2 + 1]!.get("onHand");
      avgCost.set(ids[i]!, typeof value === "number" && typeof onHand === "number" && onHand > 0 && value > 0 ? averageUnitMicros(value, onHand) : null);
    }
  }

  const input: SalesInput = {
    from: query.from,
    to: query.to,
    today,
    filters: query.filters,
    production,
    labels: { categories: labelsOf(categoriesSnap.docs), shifts: labelsOf(shiftsSnap.docs) },
    catalog: dir.active,
    sales: facts.sales,
    losses: facts.losses,
    adjustments: facts.adjustments,
    purchases: facts.purchases,
    purchaseReversals: facts.purchaseReversals,
    pending,
    retained: facts.retained,
    cancellations: facts.cancellations,
    ledger: facts.ledger,
    reversals,
    fees,
    receipts: receiptsSummary,
    avgCost,
    walletBalanceCents,
    walletCount,
    truncated,
    unreadable: Object.entries(unreadable).map(([source, count]) => ({ source, count })),
    projection: full ? { ...projection, reads: meter.snapshot() } : projection,
    paidViolations: facts.paidViolations,
    pendingOlder: { count: olderOpen, before: pendingFrom },
  };
  return { input, sales: facts.sales.filter((f) => saleMatches(f, query.filters)), scope };
}

export type SalesResponse = SalesReport | OperationalReport;

export async function salesReport(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date(), opts: LoadOptions = {}): Promise<SalesResponse> {
  const scope = reportScope(actor);
  const query = parseSalesQuery(raw);
  const { input } = await loadSalesSources(db, query, scope, clock, opts);
  const report = buildSalesReport(input);
  return scope === "full" ? report : toOperational(report);
}

/* --------------------------------------------------------------------------------- projeção diária: conferir e reaplicar */

const MAINTENANCE = z.object({ mode: z.enum(["verify", "rebuild"]) }).merge(RANGE).strict();
export type DayMaintenance = {
  date: LocalDate;
  /**
   * `open_day` = dia ainda não fechado (ao vivo, sem cache). `incomplete` = fonte truncada/ilegível: nada foi gravado.
   * `invalid` = cache de outra versão/incompleto/adulterado (verify) · `unstable` = as fontes mudaram durante a leitura: nada foi gravado.
   */
  status: "equal" | "diverged" | "missing" | "invalid" | "rebuilt" | "unchanged" | "open_day" | "incomplete" | "unstable";
  cachedDigest: string | null;
  sourceDigest: string | null;
  counts: Record<string, number>;
};

/**
 * Administração (`finance.manage`): `verify` compara o cache de cada dia fechado com uma releitura das fontes (reconciliação, sem
 * escrever); `rebuild` reaplica (replay): regrava o dia pelas fontes — o mesmo conteúdo dá o mesmo digest, então repetir não muda nada.
 */
export async function maintainDays(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date(), opts: LoadOptions = {}): Promise<{ mode: "verify" | "rebuild"; days: DayMaintenance[]; estimatedReads: number }> {
  authorize(actor, "finance.manage");
  const q = MAINTENANCE.parse(raw);
  parseSalesQuery({ from: q.from, to: q.to });
  const cap = opts.cap ?? SOURCE_CAP;
  const before = closedBefore(clock());
  const meter = new ReadMeter();
  const directory = await ProductDirectory.load(db, meter);
  const days = await pool(eachDay(q.from, q.to), BUILD_CONCURRENCY, async (date): Promise<DayMaintenance> => {
    if (date >= before) return { date, status: "open_day", cachedDigest: null, sourceDigest: null, counts: {} };
    const cached = await readDay(db, date, meter);
    const first = await countSources(db, date, meter);
    const facts = await readFacts(db, { from: date, to: date }, { cap, products: directory, meter });
    await opts.hooks?.afterRead?.(date);
    const second = await countSources(db, date, meter);
    const sourceDigest = digestOf(facts);
    const cachedDigest = cached.status === "hit" ? cached.digest : null;
    const base = { date, cachedDigest, sourceDigest, counts: countsOf(facts) as Record<string, number> };
    if (!sameCounts(first, second)) return { ...base, status: "unstable" };
    if (!isComplete(facts)) return { ...base, status: "incomplete" };
    if (q.mode === "verify") {
      if (cached.status === "absent") return { ...base, status: "missing" };
      if (cached.status === "invalid") return { ...base, status: "invalid" };
      return { ...base, status: cached.digest === sourceDigest && sameCounts(cached.sourceCounts, second) ? "equal" : "diverged" };
    }
    if (cached.status === "hit" && cached.digest === sourceDigest && sameCounts(cached.sourceCounts, second)) return { ...base, status: "unchanged" };
    await writeDay(db, date, facts, second, meter);
    return { ...base, status: "rebuilt" };
  });
  return { mode: q.mode, days, estimatedReads: meter.snapshot().estimatedReads };
}

/* ---------------------------------------------------------------------------------------------------- exportação */

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
const EXPORT_OPTIONS = z.object({ view: z.enum(SALES_VIEWS), format: z.enum(EXPORT_FORMATS).default("csv") }).strict();

export type SalesExport = { filename: string; contentType: string; body: string | Uint8Array; dateBasis: string; scope: "full" | "operational"; fictitious: boolean };

/** Exportação do período. RECUSA (409) quando alguma fonte foi truncada ou há dia em construção: nunca entrega arquivo parcial como completo. */
export async function exportSales(db: Firestore, actor: Actor, raw: Record<string, unknown>, clock: () => Date = () => new Date(), opts: LoadOptions = {}): Promise<SalesExport> {
  const scope = reportScope(actor);
  const { view, format } = EXPORT_OPTIONS.parse({ view: raw.view, format: raw.format === "" ? undefined : raw.format });
  const query = parseSalesQuery(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "view" && k !== "format")));
  if (scope === "operational" && (view === "purchases" || view === "ledger")) throw new ForbiddenError("Sem permissão para esta exportação.");
  const loaded = await loadSalesSources(db, query, scope, clock, opts);
  if (loaded.input.truncated.length > 0) throw conflict("export_truncated", "Há registros demais no período para uma exportação completa. Reduza o intervalo.", { sources: loaded.input.truncated });
  const unreadable = loaded.input.unreadable.filter((u) => u.count > 0);
  if (unreadable.length > 0) throw conflict("export_incomplete", "Há documentos de origem ilegíveis no período: a exportação ficaria incompleta. Corrija-os ou reduza o intervalo.", { sources: unreadable.map((u) => u.source) });
  const building = loaded.input.projection?.building ?? [];
  if (building.length > 0) throw conflict("projection_building", "Alguns dias do período ainda estão sendo preparados. Tente de novo em instantes.", { days: building });
  const report = buildSalesReport(loaded.input);
  const table = buildSalesTables(report, loaded.sales, scope)[view as SalesView];
  if (!table) throw conflict("view_unavailable", "Esta exportação não está disponível com os filtros ativos.");
  const stem = `relatorio-${view}-${query.from}_${query.to}`;
  const fictitious = !report.production && (report.fees?.fictitiousCount ?? 0) > 0;
  const dateBasis = "datas no fuso America/Sao_Paulo; veja a base de cada secao no resumo";
  if (format === "xlsx") {
    return { filename: `${stem}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: tableXlsx(table), dateBasis, scope, fictitious };
  }
  return { filename: `${stem}.csv`, contentType: "text/csv; charset=utf-8", body: tableCsv(table), dateBasis, scope, fictitious };
}

export { CHANNELS };
