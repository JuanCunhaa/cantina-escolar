import { AggregateField, Timestamp, type DocumentData, type DocumentReference, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { z } from "zod";
import { addDays, isLocalDate, localDateOf, localInstant, type LocalDate } from "@/lib/dates/school-time";
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
  type AdjustmentFact,
  type CancellationFact,
  type CatalogProduct,
  type Filters,
  type LedgerFact,
  type LossFact,
  type OperationalReport,
  type PendingOrderFact,
  type PurchaseFact,
  type RetainedFact,
  type ReversalFact,
  type SaleFact,
  type SalesInput,
  type SalesReport,
} from "./sales-model";
import {
  adjustmentFactOf,
  cancellationFactOf,
  ledgerFactOf,
  lossFactOf,
  originKey,
  originOfDirectSale,
  originOfOrder,
  orderOfCancellationPath,
  pendingOrderOf,
  productOfMovementPath,
  purchaseFactOf,
  retainedFactOf,
  reversalFactOf,
  saleFactOf,
  type OriginInfo,
  type ProductInfo,
} from "./sales-sources";
import { buildSalesTables, SALES_VIEWS, type SalesView } from "./sales-tables";
import { tableCsv } from "./table";
import { tableXlsx } from "./xlsx";

/**
 * Relatórios de vendas, CMV, margens, perdas, compras, pedidos a realizar, cancelamentos e carteira (F21).
 *
 * Projeção SEM estado próprio: cada chamada relê os documentos de origem do período e reconstrói tudo (reconstrução = repetir a
 * leitura; nada a "reaplicar", então uma entrega duplicada de evento não existe e um documento repetido é descartado pelo ID).
 * Isso casa com o padrão da F20 e com docs/firebase/queries.md (projeções reconstruíveis; o livro e os snapshots continuam a fonte).
 * Limite honesto: período ≤ 93 dias e teto de leitura por fonte; acima dele o relatório diz "parcial" e a exportação é RECUSADA
 * (nunca truncada em silêncio). Se o volume real crescer, o próximo passo é persistir agregados diários — esta contagem é o oráculo.
 */
export const SOURCE_CAP = 20_000;

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

const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

async function getMany(db: Firestore, refs: readonly DocumentReference[]) {
  const parts = await Promise.all(chunks(refs, 300).map((c) => db.getAll(...c)));
  return parts.flat();
}

const dataOf = (d: QueryDocumentSnapshot): DocumentData => d.data();

export type LoadedSales = {
  input: SalesInput;
  /** Baixas já filtradas, para o detalhe exportado conferir com os totais. */
  sales: SaleFact[];
  scope: "full" | "operational";
};

/** Lê as fontes do período. Tudo em consultas por intervalo de campo único (índices automáticos; o grupo de coleções tem `fieldOverrides`). */
export async function loadSalesSources(db: Firestore, query: SalesQuery, scope: "full" | "operational", clock: () => Date = () => new Date(), cap: number = SOURCE_CAP): Promise<LoadedSales> {
  const today = localDateOf(clock());
  const start = Timestamp.fromDate(localInstant(query.from, "00:00"));
  const end = Timestamp.fromDate(localInstant(addDays(query.to, 1), "00:00"));
  const full = scope === "full";
  const range = (name: string) => db.collectionGroup(name).where("createdAt", ">=", start).where("createdAt", "<", end).limit(cap + 1);

  const [movements, cancellations, productsSnap, categoriesSnap, shiftsSnap, openSnaps, closedSnap] = await Promise.all([
    range("movements").get(),
    range("cancellations").get(),
    db.collection("products").limit(5000).get(),
    db.collection("categories").limit(1000).get(),
    db.collection("shifts").limit(200).get(),
    Promise.all([...OPEN_STATUSES, "not_picked_up"].map((status) => db.collection("orders").where("status", "==", status).limit(cap + 1).get())),
    db.collection("orders").where("status", "==", "not_picked_up_closed").limit(cap + 1).get(),
  ]);
  const truncated: string[] = [];
  if (movements.size > cap) truncated.push("movimentos de estoque");
  if (cancellations.size > cap) truncated.push("cancelamentos");
  if (openSnaps.some((s) => s.size > cap)) truncated.push("pedidos a realizar");
  if (closedSnap.size > cap) truncated.push("não retirados encerrados");

  const products = new Map<string, ProductInfo>();
  const catalog: CatalogProduct[] = [];
  for (const d of productsSnap.docs) {
    const x = d.data();
    const info = { name: typeof x.name === "string" ? x.name : d.id, categoryId: typeof x.categoryId === "string" ? x.categoryId : null };
    products.set(d.id, info);
    if (x.status === "active") catalog.push({ productId: d.id, ...info });
  }
  const labelOf = (docs: QueryDocumentSnapshot[]) => Object.fromEntries(docs.map((d) => [d.id, typeof d.get("name") === "string" ? (d.get("name") as string) : d.id]));
  const labels = { categories: labelOf(categoriesSnap.docs), shifts: labelOf(shiftsSnap.docs) };

  // Movimentos: só os do livro de custos (`stockCosts/{produto}/movements/*`).
  const unreadable: Record<string, number> = {};
  const bad = (source: string) => (unreadable[source] = (unreadable[source] ?? 0) + 1);
  const moves = movements.docs.slice(0, cap).filter((d) => productOfMovementPath(d.ref.path) !== null);
  const saleDocs = moves.filter((d) => d.get("type") === "sale_exit");

  // Pedido/venda direta de origem das baixas (canal, turno e o snapshot de nome/categoria da época da venda).
  const wanted = new Map<string, DocumentReference>();
  for (const d of saleDocs) {
    const type = d.get("referenceType");
    const id = d.get("referenceId");
    if ((type === "order" || type === "directSale") && typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) wanted.set(originKey(dataOf(d)), db.doc(`${type === "order" ? "orders" : "directSales"}/${id}`));
  }
  const origins = new Map<string, OriginInfo>();
  const cancelledOrders = new Map<string, OriginInfo>();
  for (const snap of await getMany(db, [...wanted.values()])) {
    if (!snap.exists) continue;
    const isOrder = snap.ref.parent.id === "orders";
    origins.set(`${isOrder ? "order" : "directSale"}:${snap.id}`, isOrder ? originOfOrder(snap.data()!) : originOfDirectSale(snap.data()!));
  }

  const sales: SaleFact[] = [];
  const losses: LossFact[] = [];
  const adjustments: AdjustmentFact[] = [];
  for (const d of moves) {
    const type = d.get("type");
    if (type === "sale_exit") {
      const f = saleFactOf(d.ref.path, dataOf(d), origins, products);
      if (f) sales.push(f);
      else bad("baixas de venda");
    } else if (type === "loss") {
      const f = lossFactOf(d.ref.path, dataOf(d), products);
      if (f) losses.push(f);
      else bad("perdas");
    } else if ((type === "count_adjustment" || type === "adjustment") && full) {
      const f = adjustmentFactOf(d.ref.path, dataOf(d), products);
      if (f) adjustments.push(f);
      else bad("ajustes de estoque");
    }
  }

  // Cancelamentos: o turno vem do pedido (a leitura do cancelamento não o guarda).
  const cancelDocs = cancellations.docs.slice(0, cap).filter((d) => orderOfCancellationPath(d.ref.path) !== null);
  const orderRefs = [...new Set(cancelDocs.map((d) => orderOfCancellationPath(d.ref.path)!))].map((id) => db.doc(`orders/${id}`));
  for (const snap of await getMany(db, orderRefs)) if (snap.exists) cancelledOrders.set(snap.id, originOfOrder(snap.data()!));
  const cancellationFacts: CancellationFact[] = [];
  for (const d of cancelDocs) {
    const f = cancellationFactOf(d.ref.path, dataOf(d), cancelledOrders, products);
    if (f) cancellationFacts.push(f);
    else bad("cancelamentos");
  }

  const pending: PendingOrderFact[] = [];
  for (const snap of openSnaps) {
    for (const d of snap.docs.slice(0, cap)) {
      const f = pendingOrderOf(d.id, dataOf(d), products);
      if (f) {
        if (f.lines.length > 0) pending.push(f);
      } else bad("pedidos a realizar");
    }
  }
  const retained: RetainedFact[] = [];
  for (const d of closedSnap.docs.slice(0, cap)) {
    const res = (d.get("nonPickup") as { resolution?: { kind?: string } } | undefined)?.resolution;
    if (res?.kind !== "close_charged") continue;
    const f = retainedFactOf(d.id, dataOf(d));
    if (!f) bad("não retirados encerrados");
    else if (f.date >= query.from && f.date <= query.to) retained.push(f);
  }

  // Seções só da administração: compras, livro das carteiras, taxas e custo médio atual.
  const purchases: PurchaseFact[] = [];
  const ledger: LedgerFact[] = [];
  const reversals: ReversalFact[] = [];
  let fees: SalesInput["fees"] = { effectiveCents: 0, unknownCount: 0, unknownGrossCents: 0, fictitiousCount: 0 };
  let walletBalanceCents: number | null = null;
  let walletCount: number | null = null;
  let avgCost: Map<string, number | null> | null = null;
  const production = process.env.APP_ENV === "production";
  if (full) {
    const [receipts, entries, receiptDocs, pendencyDocs, wallets] = await Promise.all([
      readReceiptsInRange(db, query),
      range("entries").get(),
      db.collection("stockReceipts").where("createdAt", ">=", start).where("createdAt", "<", end).limit(cap + 1).get(),
      db.collection("paymentPendencies").limit(cap + 1).get(),
      db
        .collection("wallets")
        .aggregate({ total: AggregateField.sum("balanceCents"), count: AggregateField.count() })
        .get()
        .then((s) => s.data())
        .catch(() => null),
    ]);
    if (receipts.truncated) truncated.push("recebimentos");
    if (entries.size > cap) truncated.push("lançamentos das carteiras");
    if (receiptDocs.size > cap) truncated.push("entradas de estoque");
    if (pendencyDocs.size > cap) truncated.push("pendências de reversão");
    for (const d of pendencyDocs.docs.slice(0, cap)) {
      const f = reversalFactOf(d.id, dataOf(d));
      if (f) reversals.push(f);
      else bad("pendências de reversão");
    }
    const finance = buildReport(receipts.receipts, query, today, { truncated: receipts.truncated, production }).totals;
    fees = { effectiveCents: finance.feeEffectiveCents, unknownCount: finance.feeUnknownCount, unknownGrossCents: finance.feeUnknownGrossCents, fictitiousCount: finance.fictitiousCount };
    for (const d of receiptDocs.docs.slice(0, cap)) {
      const f = purchaseFactOf(d.id, dataOf(d), products);
      if (f) purchases.push(f);
      else bad("entradas de estoque");
    }
    for (const d of entries.docs.slice(0, cap)) {
      if (!/^wallets\/[^/]+\/entries\/[^/]+$/.test(d.ref.path)) continue;
      const f = ledgerFactOf(d.ref.path, dataOf(d));
      if (f) ledger.push(f);
      else bad("lançamentos das carteiras");
    }
    if (wallets) {
      walletBalanceCents = typeof wallets.total === "number" ? wallets.total : 0;
      walletCount = wallets.count;
    }
    // Custo médio ATUAL, só para ESTIMAR a margem dos pedidos a realizar (não é histórico: o CMV real nasce na baixa).
    const ids = [...new Set(pending.flatMap((o) => o.lines.map((l) => l.productId)))].filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id));
    avgCost = new Map();
    const docs = await getMany(db, ids.flatMap((id) => [db.doc(`stockCosts/${id}`), db.doc(`stockBalances/${id}`)]));
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
    labels,
    catalog,
    sales,
    losses,
    adjustments,
    purchases,
    pending,
    retained,
    cancellations: cancellationFacts,
    ledger,
    reversals,
    fees,
    avgCost,
    walletBalanceCents,
    walletCount,
    truncated,
    unreadable: Object.entries(unreadable).map(([source, count]) => ({ source, count })),
  };
  return { input, sales: sales.filter((f) => saleMatches(f, query.filters)), scope };
}

export type SalesResponse = SalesReport | OperationalReport;

export async function salesReport(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date(), cap: number = SOURCE_CAP): Promise<SalesResponse> {
  const scope = reportScope(actor);
  const query = parseSalesQuery(raw);
  const { input } = await loadSalesSources(db, query, scope, clock, cap);
  const report = buildSalesReport(input);
  return scope === "full" ? report : toOperational(report);
}

/* ---------------------------------------------------------------------------------------------------- exportação */

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
const EXPORT_OPTIONS = z.object({ view: z.enum(SALES_VIEWS), format: z.enum(EXPORT_FORMATS).default("csv") }).strict();

export type SalesExport = { filename: string; contentType: string; body: string | Uint8Array; dateBasis: string; scope: "full" | "operational"; fictitious: boolean };

/** Exportação do período. RECUSA (409) quando alguma fonte foi truncada: nunca entrega arquivo parcial como se fosse completo. */
export async function exportSales(db: Firestore, actor: Actor, raw: Record<string, unknown>, clock: () => Date = () => new Date(), cap: number = SOURCE_CAP): Promise<SalesExport> {
  const scope = reportScope(actor);
  const { view, format } = EXPORT_OPTIONS.parse({ view: raw.view, format: raw.format === "" ? undefined : raw.format });
  const query = parseSalesQuery(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "view" && k !== "format")));
  if (scope === "operational" && (view === "purchases" || view === "ledger")) throw new ForbiddenError("Sem permissão para esta exportação.");
  const loaded = await loadSalesSources(db, query, scope, clock, cap);
  if (loaded.input.truncated.length > 0) throw conflict("export_truncated", "Há registros demais no período para uma exportação completa. Reduza o intervalo.", { sources: loaded.input.truncated });
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
