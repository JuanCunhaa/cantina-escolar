import { z } from "zod";
import type { LocalDate } from "@/lib/dates/school-time";
import { microsToCents } from "@/modules/inventory/cost";

/**
 * Projeção de vendas realizadas, CMV, margens, perdas, compras de estoque, pedidos a realizar e cancelamentos (F21,
 * docs/domains/reports-cash.md §16). Regras PURAS: nada aqui lê Firebase. A projeção NÃO tem estado próprio: é reconstruída a cada
 * leitura dos documentos de origem (movimentos de estoque, pedidos, vendas diretas, cancelamentos, livro das carteiras), então
 * reconstruir e repetir a leitura dão sempre o mesmo resultado, e uma notificação/leitura duplicada de um mesmo documento de
 * origem é descartada pelo ID (`dedupeById`) sem contar duas vezes.
 *
 * Contas (a mesma fonte alimenta todos os agrupamentos, então os totais conferem entre si — ver `reconcileSales`):
 *   - receita realizada = valor PAGO das unidades entregues/vendidas, gravado no movimento da baixa (`revenueCents`); nunca o preço atual;
 *   - CMV = custo HISTÓRICO da mesma baixa (micro-centavos exatos); arredondado para centavos UMA vez, sobre cada total exibido;
 *   - lucro bruto = receita − CMV, SÓ sobre as baixas com receita E custo conhecidos; sem um deles a baixa vira PENDÊNCIA (nunca zero);
 *   - perdas (movimento `loss`) ficam fora do CMV; compras de estoque ficam fora do resultado (aplicação de caixa/mercadoria);
 *   - recarga, reserva, transferência e compra com saldo NÃO são receita: só a baixa de estoque é.
 */
export const MAX_SALES_DAYS = 93;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const CHANNELS = ["advance", "counter", "direct"] as const;
export type SaleChannel = (typeof CHANNELS)[number] | "unknown";
export const CHANNEL_LABEL: Record<SaleChannel, string> = {
  advance: "Pedido antecipado",
  counter: "Balcão (saldo da carteira)",
  direct: "Venda direta (recebida no ato)",
  unknown: "Origem não identificada",
};

export const filtersSchema = z
  .object({
    shiftId: z.string().regex(ID).optional(),
    productId: z.string().regex(ID).optional(),
    categoryId: z.string().regex(ID).optional(),
    channel: z.enum(CHANNELS).optional(),
  })
  .strict();
export type Filters = z.infer<typeof filtersSchema>;
export const hasFilters = (f: Filters): boolean => f.shiftId !== undefined || f.productId !== undefined || f.categoryId !== undefined || f.channel !== undefined;

/* ----------------------------------------------------------------------------------------------- fatos de origem */

/** Uma baixa de venda (movimento `sale_exit`) ligada ao pedido/venda direta de origem. `id` = caminho do movimento. */
export type SaleFact = {
  id: string;
  date: LocalDate;
  productId: string;
  productName: string;
  categoryId: string | null;
  channel: SaleChannel;
  shiftId: string | null;
  units: number;
  /** Valor pago pelas unidades; `null` = movimento sem receita registrada (pendência). */
  revenueCents: number | null;
  /** Custo histórico exato (micro-centavos, positivo); `null` = sem custo registrado (pendência). */
  costMicros: number | null;
  /** Documento de origem (`order:ID` ou `directSale:ID`). */
  origin: string;
  originFound: boolean;
  /** Valor TOTAL pago do pedido/venda de origem (para conferir que as baixas não passam do pago); `null` sem origem. */
  originPaidCents?: number | null;
};

export type LossFact = { id: string; date: LocalDate; productId: string; productName: string; categoryId: string | null; reasonCode: string; units: number; costMicros: number | null; origin: string };
/** Contagem/ajuste de estoque (assinado: negativo = falta). Não é perda nem CMV; aparece à parte. */
export type AdjustmentFact = { id: string; date: LocalDate; productId: string; productName: string; categoryId: string | null; type: string; units: number; costMicros: number };
/** Entrada de estoque na data em que foi registrada (imutável; o estorno é outro fato, na data do estorno). */
export type PurchaseFact = { id: string; date: LocalDate; productId: string; productName: string; categoryId: string | null; kind: string; units: number; costMicros: number };
/** Estorno de entrada (movimento `receipt_reversal`) na data em que aconteceu: abate no período do estorno, sem reescrever a compra. */
export type PurchaseReversalFact = { id: string; date: LocalDate; productId: string; productName: string; categoryId: string | null; units: number; costMicros: number };

export type PendingLine = { productId: string; name: string; categoryId: string | null; units: number; valueCents: number };
/** Pedido pago e ainda não realizado (restante a entregar). `bucket` é relativo ao dia de hoje. */
export type PendingOrderFact = { id: string; consumptionDate: LocalDate; shiftId: string | null; channel: SaleChannel; status: string; lines: PendingLine[] };
export type RetainedFact = { id: string; date: LocalDate; shiftId: string | null; channel: SaleChannel; amountCents: number; units: number };
export type CancellationFact = {
  id: string;
  date: LocalDate;
  orderId: string;
  kind: string;
  shiftId: string | null;
  channel: SaleChannel;
  lines: { productId: string; name: string; categoryId: string | null; units: number; refundCents: number }[];
};
/** Pendência de reversão externa (reembolso/chargeback que não coube no saldo): posição de HOJE, não do período. */
export type ReversalFact = { id: string; status: string; openedCents: number; outstandingCents: number; recoveredCents: number; writtenOffCents: number };
export type LedgerFact = { id: string; date: LocalDate; type: string; amountCents: number };

export type Labels = { categories: Record<string, string>; shifts: Record<string, string> };
export type CatalogProduct = { productId: string; name: string; categoryId: string | null };

/* ----------------------------------------------------------------------------------------------------- utilidades */

const SAFE = Number.MAX_SAFE_INTEGER;
function add(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n) || Math.abs(n) > SAFE) throw new RangeError("Total fora da faixa segura.");
  return n;
}

/** Divisão inteira arredondada meio para longe do zero (a mesma convenção de `microsToCents`). */
export function roundDiv(n: number, d: number): number {
  if (d === 0) throw new RangeError("Divisão por zero.");
  const negative = n < 0 !== d < 0;
  const q = Math.floor((Math.abs(n) * 2 + Math.abs(d)) / (2 * Math.abs(d)));
  return negative ? -q : q;
}

/** Descarta repetições do MESMO documento de origem (primeira ocorrência vale). Devolve também quantas foram ignoradas. */
export function dedupeById<T extends { id: string }>(facts: readonly T[]): { facts: T[]; ignored: number } {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of facts) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return { facts: out, ignored: facts.length - out.length };
}

/* ------------------------------------------------------------------------------------------------------ agregação */

export type Agg = {
  facts: number;
  units: number;
  /** Receita das baixas com receita conhecida. */
  revenueCents: number;
  /** Custo das baixas com custo conhecido (micro-centavos exatos). */
  costMicros: number;
  /** Subconjunto COMPLETO (receita E custo conhecidos): base do lucro. */
  completeUnits: number;
  completeRevenueCents: number;
  completeCostMicros: number;
  missingRevenueUnits: number;
  missingCostUnits: number;
  originMissingFacts: number;
};
const zeroAgg = (): Agg => ({ facts: 0, units: 0, revenueCents: 0, costMicros: 0, completeUnits: 0, completeRevenueCents: 0, completeCostMicros: 0, missingRevenueUnits: 0, missingCostUnits: 0, originMissingFacts: 0 });

export function accumulateSale(agg: Agg, f: SaleFact): void {
  agg.facts += 1;
  agg.units = add(agg.units, f.units);
  if (f.revenueCents !== null) agg.revenueCents = add(agg.revenueCents, f.revenueCents);
  else agg.missingRevenueUnits = add(agg.missingRevenueUnits, f.units);
  if (f.costMicros !== null) agg.costMicros = add(agg.costMicros, f.costMicros);
  else agg.missingCostUnits = add(agg.missingCostUnits, f.units);
  if (f.revenueCents !== null && f.costMicros !== null) {
    agg.completeUnits = add(agg.completeUnits, f.units);
    agg.completeRevenueCents = add(agg.completeRevenueCents, f.revenueCents);
    agg.completeCostMicros = add(agg.completeCostMicros, f.costMicros);
  }
  if (!f.originFound) agg.originMissingFacts += 1;
}

export type Derived = {
  /** CMV (centavos), arredondado uma vez sobre o total das baixas com custo conhecido. */
  cogsCents: number;
  /** Lucro bruto sobre o subconjunto completo; só é definitivo com `complete`. */
  grossProfitCents: number;
  complete: boolean;
  /** Margem bruta em pontos-base (1234 = 12,34 %); `null` sem receita completa. */
  marginBp: number | null;
  profitPerUnitCents: number | null;
};
export function derive(a: Agg): Derived {
  const profit = a.completeRevenueCents - microsToCents(a.completeCostMicros);
  return {
    cogsCents: microsToCents(a.costMicros),
    grossProfitCents: profit,
    complete: a.missingCostUnits === 0 && a.missingRevenueUnits === 0,
    marginBp: a.completeRevenueCents > 0 ? roundDiv(profit * 10_000, a.completeRevenueCents) : null,
    profitPerUnitCents: a.completeUnits > 0 ? roundDiv(profit, a.completeUnits) : null,
  };
}

export type ProductRow = Agg & Derived & { productId: string; name: string; categoryId: string | null };
export type GroupRow = Agg & Derived & { key: string; label: string };

function group(facts: readonly SaleFact[], keyOf: (f: SaleFact) => string, labelOf: (key: string) => string): GroupRow[] {
  const map = new Map<string, Agg>();
  for (const f of facts) {
    const k = keyOf(f);
    let a = map.get(k);
    if (!a) map.set(k, (a = zeroAgg()));
    accumulateSale(a, f);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, a]) => ({ ...a, ...derive(a), key, label: labelOf(key) }));
}

function byProduct(facts: readonly SaleFact[]): ProductRow[] {
  const map = new Map<string, { agg: Agg; name: string; categoryId: string | null }>();
  for (const f of facts) {
    let e = map.get(f.productId);
    if (!e) map.set(f.productId, (e = { agg: zeroAgg(), name: f.productName, categoryId: f.categoryId }));
    accumulateSale(e.agg, f);
  }
  return [...map.entries()].map(([productId, e]) => ({ ...e.agg, ...derive(e.agg), productId, name: e.name, categoryId: e.categoryId })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.productId.localeCompare(b.productId));
}

/* ---------------------------------------------------------------------------------------------------- rankings */

export const RANK_KEYS = ["units", "revenue", "profit", "profitPerUnit", "margin"] as const;
export type RankKey = (typeof RANK_KEYS)[number];

const RANK_VALUE: Record<RankKey, (r: ProductRow) => number | null> = {
  units: (r) => r.units,
  revenue: (r) => r.revenueCents,
  // Lucro absoluto, lucro por unidade e margem % são rankings DIFERENTES: nunca se confundem.
  profit: (r) => (r.completeUnits > 0 ? r.grossProfitCents : null),
  profitPerUnit: (r) => r.profitPerUnitCents,
  margin: (r) => r.marginBp,
};

/** Ranking determinístico (valor decrescente; empate por nome e ID). Linhas sem a medida (ex.: sem custo) ficam de fora. */
export function rankProducts(rows: readonly ProductRow[], by: RankKey, limit: number): ProductRow[] {
  const value = RANK_VALUE[by];
  return rows
    .filter((r) => r.units > 0 && value(r) !== null)
    .sort((a, b) => value(b)! - value(a)! || a.name.localeCompare(b.name, "pt-BR") || a.productId.localeCompare(b.productId))
    .slice(0, limit);
}

/** Baixo giro: menos unidades vendidas no período, incluindo produtos ativos SEM nenhuma venda (zero é informação, não ausência). */
export function lowTurnover(rows: readonly ProductRow[], catalog: readonly CatalogProduct[], limit: number): { productId: string; name: string; units: number }[] {
  const sold = new Map(rows.map((r) => [r.productId, r]));
  const all = new Map<string, { productId: string; name: string; units: number }>();
  for (const c of catalog) all.set(c.productId, { productId: c.productId, name: c.name, units: sold.get(c.productId)?.units ?? 0 });
  for (const r of rows) if (!all.has(r.productId)) all.set(r.productId, { productId: r.productId, name: r.name, units: r.units });
  return [...all.values()].sort((a, b) => a.units - b.units || a.name.localeCompare(b.name, "pt-BR") || a.productId.localeCompare(b.productId)).slice(0, limit);
}

/* ------------------------------------------------------------------------------------------------------- filtros */

/** Quais filtros cada seção suporta. Filtro ativo que a seção não conhece = seção omitida com motivo (nunca número enganoso). */
export const SECTION_FILTERS = {
  realized: ["shiftId", "productId", "categoryId", "channel"],
  losses: ["productId", "categoryId"],
  purchases: ["productId", "categoryId"],
  pending: ["shiftId", "productId", "categoryId", "channel"],
  retained: ["shiftId", "channel"],
  cancellations: ["shiftId", "productId", "categoryId", "channel"],
  ledger: [],
  reversals: [],
  fees: [],
  result: [],
} as const satisfies Record<string, readonly (keyof Filters)[]>;
export type SectionName = keyof typeof SECTION_FILTERS;
/** Seções que a visão da cantina conhece: as demais (custo, taxa, resultado, compras, carteira) nem são nomeadas para ela. */
export const OPERATIONAL_SECTIONS: readonly SectionName[] = ["realized", "losses", "pending", "retained", "cancellations"];
export const SECTION_LABEL: Record<SectionName, string> = {
  realized: "Vendas realizadas",
  losses: "Perdas",
  purchases: "Compras de estoque",
  pending: "Pedidos pagos a realizar",
  retained: "Cobrança retida (não retirado)",
  cancellations: "Cancelamentos e reembolsos",
  ledger: "Carteiras (livro)",
  reversals: "Reversões externas pendentes",
  fees: "Taxas",
  result: "Resultado após perdas e taxas",
};

const FILTER_LABEL: Record<keyof Filters, string> = { shiftId: "turno", productId: "produto", categoryId: "categoria", channel: "canal" };

/** `null` = a seção vale com os filtros ativos; senão o motivo (texto para a tela e o CSV). */
export function skippedReason(section: SectionName, filters: Filters): string | null {
  const supported = SECTION_FILTERS[section] as readonly (keyof Filters)[];
  const blocking = (Object.keys(filters) as (keyof Filters)[]).filter((k) => filters[k] !== undefined && !supported.includes(k));
  if (blocking.length === 0) return null;
  return `Seção da escola inteira: não segue o filtro de ${blocking.map((k) => FILTER_LABEL[k]).join(", ")}.`;
}

export function saleMatches(f: SaleFact, filters: Filters): boolean {
  return (
    (filters.shiftId === undefined || f.shiftId === filters.shiftId) &&
    (filters.productId === undefined || f.productId === filters.productId) &&
    (filters.categoryId === undefined || f.categoryId === filters.categoryId) &&
    (filters.channel === undefined || f.channel === filters.channel)
  );
}
const productMatches = (productId: string, categoryId: string | null, filters: Filters): boolean => (filters.productId === undefined || productId === filters.productId) && (filters.categoryId === undefined || categoryId === filters.categoryId);

/* ------------------------------------------------------------------------------------------------- seções do relatório */

export type LossRow = { productId: string; name: string; reasonCode: string; facts: number; units: number; costMicros: number; missingCostUnits: number };
export type LossSection = { rows: LossRow[]; totals: { facts: number; units: number; costMicros: number; costCents: number; missingCostUnits: number } };

function buildLosses(facts: readonly LossFact[], filters: Filters): LossSection {
  const map = new Map<string, LossRow>();
  for (const f of facts) {
    if (!productMatches(f.productId, f.categoryId, filters)) continue;
    const key = `${f.productId}|${f.reasonCode}`;
    let r = map.get(key);
    if (!r) map.set(key, (r = { productId: f.productId, name: f.productName, reasonCode: f.reasonCode, facts: 0, units: 0, costMicros: 0, missingCostUnits: 0 }));
    r.facts += 1;
    r.units = add(r.units, f.units);
    if (f.costMicros === null) r.missingCostUnits = add(r.missingCostUnits, f.units);
    else r.costMicros = add(r.costMicros, f.costMicros);
  }
  const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.productId.localeCompare(b.productId) || a.reasonCode.localeCompare(b.reasonCode));
  const totals = rows.reduce((t, r) => ({ facts: t.facts + r.facts, units: add(t.units, r.units), costMicros: add(t.costMicros, r.costMicros), costCents: 0, missingCostUnits: add(t.missingCostUnits, r.missingCostUnits) }), { facts: 0, units: 0, costMicros: 0, costCents: 0, missingCostUnits: 0 });
  totals.costCents = microsToCents(totals.costMicros);
  return { rows, totals };
}

export type AdjustmentSection = { rows: { type: string; facts: number; units: number; costMicros: number }[]; netUnits: number; netCostMicros: number; netCostCents: number };
function buildAdjustments(facts: readonly AdjustmentFact[], filters: Filters): AdjustmentSection {
  const map = new Map<string, { type: string; facts: number; units: number; costMicros: number }>();
  for (const f of facts) {
    if (!productMatches(f.productId, f.categoryId, filters)) continue;
    let r = map.get(f.type);
    if (!r) map.set(f.type, (r = { type: f.type, facts: 0, units: 0, costMicros: 0 }));
    r.facts += 1;
    r.units = add(r.units, f.units);
    r.costMicros = add(r.costMicros, f.costMicros);
  }
  const rows = [...map.values()].sort((a, b) => a.type.localeCompare(b.type));
  const netUnits = rows.reduce((n, r) => add(n, r.units), 0);
  const netCostMicros = rows.reduce((n, r) => add(n, r.costMicros), 0);
  return { rows, netUnits, netCostMicros, netCostCents: microsToCents(netCostMicros) };
}

export type PurchaseRow = { kind: string; facts: number; units: number; costMicros: number };
export type PurchaseSection = {
  rows: PurchaseRow[];
  byProduct: { productId: string; name: string; units: number; costMicros: number }[];
  /** Estornos de entrada ocorridos NO período (data do estorno); abatem do total, nunca reescrevem a compra do mês anterior. */
  reversals: { facts: number; units: number; costMicros: number };
  /** Entradas do período − estornos do período. */
  netCostMicros: number;
  netCostCents: number;
};
function buildPurchases(facts: readonly PurchaseFact[], reversalFacts: readonly PurchaseReversalFact[], filters: Filters): PurchaseSection {
  const kinds = new Map<string, PurchaseRow>();
  const products = new Map<string, { productId: string; name: string; units: number; costMicros: number }>();
  for (const f of facts) {
    if (!productMatches(f.productId, f.categoryId, filters)) continue;
    let k = kinds.get(f.kind);
    if (!k) kinds.set(f.kind, (k = { kind: f.kind, facts: 0, units: 0, costMicros: 0 }));
    k.facts += 1;
    k.units = add(k.units, f.units);
    k.costMicros = add(k.costMicros, f.costMicros);
    let p = products.get(f.productId);
    if (!p) products.set(f.productId, (p = { productId: f.productId, name: f.productName, units: 0, costMicros: 0 }));
    p.units = add(p.units, f.units);
    p.costMicros = add(p.costMicros, f.costMicros);
  }
  const reversals = { facts: 0, units: 0, costMicros: 0 };
  for (const f of reversalFacts) {
    if (!productMatches(f.productId, f.categoryId, filters)) continue;
    reversals.facts += 1;
    reversals.units = add(reversals.units, f.units);
    reversals.costMicros = add(reversals.costMicros, f.costMicros);
    let p = products.get(f.productId);
    if (!p) products.set(f.productId, (p = { productId: f.productId, name: f.productName, units: 0, costMicros: 0 }));
    p.units = add(p.units, -f.units);
    p.costMicros = add(p.costMicros, -f.costMicros);
  }
  const rows = [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind));
  const netCostMicros = add(
    rows.reduce((n, r) => add(n, r.costMicros), 0),
    -reversals.costMicros,
  );
  return { rows, reversals, byProduct: [...products.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.productId.localeCompare(b.productId)), netCostMicros, netCostCents: microsToCents(netCostMicros) };
}

export const PENDING_BUCKETS = ["overdue", "today", "next7", "later"] as const;
export type PendingBucket = (typeof PENDING_BUCKETS)[number];
export const PENDING_LABEL: Record<PendingBucket, string> = { overdue: "Data já passada (a resolver)", today: "Hoje", next7: "Próximos 7 dias", later: "Mais adiante" };

export function pendingBucket(date: LocalDate, today: LocalDate, plus7: LocalDate): PendingBucket {
  if (date < today) return "overdue";
  if (date === today) return "today";
  return date <= plus7 ? "next7" : "later";
}

export type PendingSection = {
  asOf: LocalDate;
  buckets: { bucket: PendingBucket; orders: number; units: number; valueCents: number }[];
  byProduct: { productId: string; name: string; units: number; valueCents: number; estimatedCostMicros: number | null }[];
  totals: { orders: number; units: number; valueCents: number };
  /** Custo ESTIMADO pelo custo médio ATUAL (não é histórico: só vira CMV na baixa); `null` onde não há custo médio. */
  estimate: { costMicros: number; costCents: number; missingCostUnits: number; marginCents: number } | null;
};

function buildPending(orders: readonly PendingOrderFact[], filters: Filters, today: LocalDate, plus7: LocalDate, avgCost: ReadonlyMap<string, number | null> | null): PendingSection {
  const buckets = new Map<PendingBucket, { orders: Set<string>; units: number; valueCents: number }>(PENDING_BUCKETS.map((b) => [b, { orders: new Set<string>(), units: 0, valueCents: 0 }]));
  const products = new Map<string, { productId: string; name: string; units: number; valueCents: number; estimatedCostMicros: number | null }>();
  const allOrders = new Set<string>();
  const estimate = avgCost ? { costMicros: 0, missingCostUnits: 0, valueCents: 0 } : null;
  for (const o of orders) {
    if (filters.shiftId !== undefined && o.shiftId !== filters.shiftId) continue;
    if (filters.channel !== undefined && o.channel !== filters.channel) continue;
    const bucket = buckets.get(pendingBucket(o.consumptionDate, today, plus7))!;
    for (const l of o.lines) {
      if (!productMatches(l.productId, l.categoryId, filters) || l.units <= 0) continue;
      bucket.orders.add(o.id);
      allOrders.add(o.id);
      bucket.units = add(bucket.units, l.units);
      bucket.valueCents = add(bucket.valueCents, l.valueCents);
      let p = products.get(l.productId);
      if (!p) products.set(l.productId, (p = { productId: l.productId, name: l.name, units: 0, valueCents: 0, estimatedCostMicros: avgCost ? 0 : null }));
      p.units = add(p.units, l.units);
      p.valueCents = add(p.valueCents, l.valueCents);
      if (avgCost && estimate) {
        const unit = avgCost.get(l.productId) ?? null;
        estimate.valueCents = add(estimate.valueCents, l.valueCents);
        if (unit === null) {
          estimate.missingCostUnits = add(estimate.missingCostUnits, l.units);
          p.estimatedCostMicros = null;
        } else {
          estimate.costMicros = add(estimate.costMicros, unit * l.units);
          if (p.estimatedCostMicros !== null) p.estimatedCostMicros = add(p.estimatedCostMicros, unit * l.units);
        }
      }
    }
  }
  const rows = PENDING_BUCKETS.map((b) => ({ bucket: b, orders: buckets.get(b)!.orders.size, units: buckets.get(b)!.units, valueCents: buckets.get(b)!.valueCents }));
  return {
    asOf: today,
    buckets: rows,
    byProduct: [...products.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.productId.localeCompare(b.productId)),
    totals: { orders: allOrders.size, units: rows.reduce((n, r) => add(n, r.units), 0), valueCents: rows.reduce((n, r) => add(n, r.valueCents), 0) },
    estimate: estimate ? { costMicros: estimate.costMicros, costCents: microsToCents(estimate.costMicros), missingCostUnits: estimate.missingCostUnits, marginCents: estimate.valueCents - microsToCents(estimate.costMicros) } : null,
  };
}

export type RetainedSection = { orders: number; units: number; amountCents: number };
function buildRetained(facts: readonly RetainedFact[], filters: Filters): RetainedSection {
  const picked = facts.filter((f) => (filters.shiftId === undefined || f.shiftId === filters.shiftId) && (filters.channel === undefined || f.channel === filters.channel));
  return { orders: picked.length, units: picked.reduce((n, f) => add(n, f.units), 0), amountCents: picked.reduce((n, f) => add(n, f.amountCents), 0) };
}

export type CancellationSection = {
  byKind: { kind: string; events: number; units: number; refundCents: number }[];
  byProduct: { productId: string; name: string; units: number; refundCents: number }[];
  totals: { events: number; units: number; refundCents: number };
};
function buildCancellations(facts: readonly CancellationFact[], filters: Filters): CancellationSection {
  const kinds = new Map<string, { kind: string; ids: Set<string>; units: number; refundCents: number }>();
  const products = new Map<string, { productId: string; name: string; units: number; refundCents: number }>();
  const events = new Set<string>();
  for (const c of facts) {
    if (filters.shiftId !== undefined && c.shiftId !== filters.shiftId) continue;
    if (filters.channel !== undefined && c.channel !== filters.channel) continue;
    for (const l of c.lines) {
      if (!productMatches(l.productId, l.categoryId, filters)) continue;
      events.add(c.id);
      let k = kinds.get(c.kind);
      if (!k) kinds.set(c.kind, (k = { kind: c.kind, ids: new Set<string>(), units: 0, refundCents: 0 }));
      k.ids.add(c.id);
      k.units = add(k.units, l.units);
      k.refundCents = add(k.refundCents, l.refundCents);
      let p = products.get(l.productId);
      if (!p) products.set(l.productId, (p = { productId: l.productId, name: l.name, units: 0, refundCents: 0 }));
      p.units = add(p.units, l.units);
      p.refundCents = add(p.refundCents, l.refundCents);
    }
  }
  const byKind = [...kinds.values()].map((k) => ({ kind: k.kind, events: k.ids.size, units: k.units, refundCents: k.refundCents })).sort((a, b) => a.kind.localeCompare(b.kind));
  return {
    byKind,
    byProduct: [...products.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.productId.localeCompare(b.productId)),
    totals: { events: events.size, units: byKind.reduce((n, k) => add(n, k.units), 0), refundCents: byKind.reduce((n, k) => add(n, k.refundCents), 0) },
  };
}

export type ReversalSection = { pendencies: number; open: number; openedCents: number; outstandingCents: number; recoveredCents: number; writtenOffCents: number };
function buildReversals(facts: readonly ReversalFact[]): ReversalSection {
  const open = facts.filter((f) => f.status === "open");
  const sum = (pick: (f: ReversalFact) => number) => facts.reduce((n, f) => add(n, pick(f)), 0);
  return { pendencies: facts.length, open: open.length, openedCents: sum((f) => f.openedCents), outstandingCents: open.reduce((n, f) => add(n, f.outstandingCents), 0), recoveredCents: sum((f) => f.recoveredCents), writtenOffCents: sum((f) => f.writtenOffCents) };
}

export type LedgerSection = { rows: { type: string; entries: number; amountCents: number }[]; creditedCents: number; spentCents: number; netCents: number };
function buildLedger(facts: readonly LedgerFact[]): LedgerSection {
  const map = new Map<string, { type: string; entries: number; amountCents: number }>();
  let credited = 0;
  let spent = 0;
  for (const f of facts) {
    let r = map.get(f.type);
    if (!r) map.set(f.type, (r = { type: f.type, entries: 0, amountCents: 0 }));
    r.entries += 1;
    r.amountCents = add(r.amountCents, f.amountCents);
    // Créditos e débitos POR LANÇAMENTO: tipos como ajuste e troca têm lançamentos nos dois sentidos.
    if (f.amountCents > 0) credited = add(credited, f.amountCents);
    else spent = add(spent, f.amountCents);
  }
  const rows = [...map.values()].sort((a, b) => a.type.localeCompare(b.type));
  return { rows, creditedCents: credited, spentCents: spent, netCents: add(credited, spent) };
}

/* ---------------------------------------------------------------------------------------------- pendências e relatório */

/** Pendências que a visão da cantina pode ver: sem custo, taxa nem margem (essas só existem na visão completa). */
export const operationalPendency = (code: string): boolean => code === "origin_missing" || code === "projection_building" || code.startsWith("truncated_") || code.startsWith("unreadable_");

/** Opções dos filtros da tela (nomes do cadastro de hoje; só rótulos). */
export type FilterOptions = { shifts: { id: string; label: string }[]; categories: { id: string; label: string }[]; products: { id: string; name: string }[] };

/** Recebimentos externos do período e sua liquidação (relatório financeiro da F20, sem recontar): dinheiro entrando ≠ venda ≠ crédito de carteira. */
export type ReceiptsSummary = {
  count: number;
  grossCents: number;
  reversedCents: number;
  feeConfirmedCents: number;
  feeInformedCents: number;
  feeEstimatedCents: number;
  feeUnknownCount: number;
  feeEffectiveCents: number;
  netExpectedCents: number;
  netRealCents: number;
  settledGrossCents: number;
  pendingGrossCents: number;
  overdueGrossCents: number;
};

/** De onde vieram os dias do período: cache diário, materializados agora, ao vivo (dia corrente / incompletos) ou ainda em construção. */
export type ProjectionStats = { cachedDays: number; builtDays: number; liveDays: number; building: string[] };

export type Pendency = { code: string; count: number; detail: string; blocksResult: boolean };

export type ResultSection = {
  grossProfitCents: number;
  lossCostCents: number;
  feesCents: number;
  /** Lucro bruto − perdas − taxas efetivas do período. Parcial enquanto houver pendência. */
  resultCents: number;
  definitive: boolean;
  note: string;
};

/** `internal` = agrupamentos da mesma lista de fatos (protegem contra regressão de chave/soma); `cross` = fontes independentes. */
export type Check = { id: string; label: string; kind: "internal" | "cross"; expected: number; actual: number; ok: boolean };

export type SalesInput = {
  from: LocalDate;
  to: LocalDate;
  today: LocalDate;
  filters: Filters;
  production: boolean;
  labels: Labels;
  catalog: readonly CatalogProduct[];
  sales: readonly SaleFact[];
  losses: readonly LossFact[];
  adjustments: readonly AdjustmentFact[];
  purchases: readonly PurchaseFact[];
  purchaseReversals?: readonly PurchaseReversalFact[];
  pending: readonly PendingOrderFact[];
  retained: readonly RetainedFact[];
  cancellations: readonly CancellationFact[];
  ledger: readonly LedgerFact[];
  reversals: readonly ReversalFact[];
  /** Taxa efetiva do período (relatório financeiro da F20: conferida > informada > estimada; uma só por recebimento). */
  fees: { effectiveCents: number; unknownCount: number; unknownGrossCents: number; fictitiousCount: number };
  /** Totais do relatório financeiro da F20 (mesma função, mesmo período). */
  receipts?: ReceiptsSummary | null;
  /** Custo médio atual por produto (estimativa dos pedidos a realizar); `null` = não calcular. */
  avgCost: ReadonlyMap<string, number | null> | null;
  walletBalanceCents: number | null;
  walletCount: number | null;
  /** Fontes cuja leitura bateu no teto (relatório parcial). */
  truncated: readonly string[];
  projection?: ProjectionStats;
  /** Documentos de origem que não puderam ser lidos (campo ausente/ inválido) por fonte: viram pendência, nunca zero. */
  unreadable: readonly { source: string; count: number }[];
};

export type SalesReport = {
  scope: "full";
  from: LocalDate;
  to: LocalDate;
  today: LocalDate;
  filters: Filters;
  options: FilterOptions;
  production: boolean;
  dateBasis: Record<"sales" | "losses" | "purchases" | "fees" | "pending" | "cancellations" | "retained" | "ledger", string>;
  truncated: string[];
  skipped: Partial<Record<SectionName, string>>;
  projection: ProjectionStats | null;
  realized: {
    totals: Agg & Derived;
    /** Pedidos/vendas de origem distintos com baixa no período (base do ticket médio). */
    origins: number;
    byProduct: ProductRow[];
    byCategory: GroupRow[];
    byChannel: GroupRow[];
    byShift: GroupRow[];
    byDay: GroupRow[];
    rankings: Record<RankKey, ProductRow[]> & { lowTurnover: { productId: string; name: string; units: number }[] };
  };
  losses: LossSection | null;
  adjustments: AdjustmentSection | null;
  purchases: PurchaseSection | null;
  pending: PendingSection | null;
  retained: RetainedSection | null;
  cancellations: CancellationSection | null;
  ledger: (LedgerSection & { walletBalanceCents: number | null; walletCount: number | null }) | null;
  reversals: ReversalSection | null;
  fees: SalesInput["fees"] | null;
  receipts: ReceiptsSummary | null;
  result: ResultSection | null;
  pendencies: Pendency[];
  checks: Check[];
  duplicatesIgnored: number;
};

export const RANK_LIMIT = 10;
const DATE_BASIS: SalesReport["dateBasis"] = {
  sales: "data da baixa de estoque da entrega/venda (America/Sao_Paulo)",
  losses: "data do registro da perda (America/Sao_Paulo)",
  purchases: "data do registro da entrada (America/Sao_Paulo)",
  fees: "data do recebimento (America/Sao_Paulo)",
  pending: "posição de hoje, por data de consumo",
  cancellations: "data do cancelamento (America/Sao_Paulo)",
  retained: "data da resolução do não retirado (America/Sao_Paulo)",
  ledger: "data do lançamento na carteira (America/Sao_Paulo)",
};

export function buildSalesReport(input: SalesInput): SalesReport {
  const { filters } = input;
  const skipped: SalesReport["skipped"] = {};
  const section = <T>(name: SectionName, build: () => T): T | null => {
    const reason = skippedReason(name, filters);
    if (reason !== null) {
      skipped[name] = reason;
      return null;
    }
    return build();
  };
  let duplicatesIgnored = 0;
  const unique = <T extends { id: string }>(list: readonly T[]): T[] => {
    const r = dedupeById(list);
    duplicatesIgnored += r.ignored;
    return r.facts;
  };
  const sales = unique(input.sales).filter((f) => saleMatches(f, filters));
  const label = (map: Record<string, string>, key: string) => map[key] ?? key;
  const totals = zeroAgg();
  for (const f of sales) accumulateSale(totals, f);
  const rows = byProduct(sales);
  const realized: SalesReport["realized"] = {
    totals: { ...totals, ...derive(totals) },
    origins: new Set(sales.map((f) => f.origin)).size,
    byProduct: rows,
    byCategory: group(sales, (f) => f.categoryId ?? "—", (k) => (k === "—" ? "Sem categoria" : label(input.labels.categories, k))),
    byChannel: group(sales, (f) => f.channel, (k) => CHANNEL_LABEL[k as SaleChannel]),
    byShift: group(sales, (f) => f.shiftId ?? "—", (k) => (k === "—" ? "Sem turno" : label(input.labels.shifts, k))),
    byDay: group(sales, (f) => f.date, (k) => k),
    rankings: {
      units: rankProducts(rows, "units", RANK_LIMIT),
      revenue: rankProducts(rows, "revenue", RANK_LIMIT),
      profit: rankProducts(rows, "profit", RANK_LIMIT),
      profitPerUnit: rankProducts(rows, "profitPerUnit", RANK_LIMIT),
      margin: rankProducts(rows, "margin", RANK_LIMIT),
      // Produto sem venda só é "zero" para a escola inteira; com filtro de turno/canal ele pode ter vendido em outro recorte.
      lowTurnover: lowTurnover(
        rows,
        filters.shiftId === undefined && filters.channel === undefined ? input.catalog.filter((c) => productMatches(c.productId, c.categoryId, filters)) : [],
        RANK_LIMIT,
      ),
    },
  };

  const losses = section("losses", () => buildLosses(unique(input.losses), filters));
  const adjustments = section("purchases", () => buildAdjustments(unique(input.adjustments), filters)); // mesmo conjunto de filtros dos movimentos de entrada
  const purchases = section("purchases", () => buildPurchases(unique(input.purchases), unique(input.purchaseReversals ?? []), filters));
  const plus7 = addDaysIso(input.today, 7);
  const pending = section("pending", () => buildPending(unique(input.pending), filters, input.today, plus7, input.avgCost));
  const retained = section("retained", () => buildRetained(unique(input.retained), filters));
  const cancellations = section("cancellations", () => buildCancellations(unique(input.cancellations), filters));
  const ledgerFacts = unique(input.ledger);
  const ledger = section("ledger", () => ({ ...buildLedger(ledgerFacts), walletBalanceCents: input.walletBalanceCents, walletCount: input.walletCount }));
  const reversals = section("reversals", () => buildReversals(unique(input.reversals)));
  const fees = section("fees", () => input.fees);
  const receipts = fees ? (input.receipts ?? null) : null;

  const pendencies: Pendency[] = [];
  const t = realized.totals;
  if (t.missingCostUnits > 0) pendencies.push({ code: "cost_missing", count: t.missingCostUnits, detail: `${t.missingCostUnits} unidade(s) vendida(s) sem custo registrado: ficam fora do CMV e do lucro.`, blocksResult: true });
  if (t.missingRevenueUnits > 0) pendencies.push({ code: "revenue_missing", count: t.missingRevenueUnits, detail: `${t.missingRevenueUnits} unidade(s) vendida(s) sem receita registrada: ficam fora da receita e do lucro.`, blocksResult: true });
  if (t.originMissingFacts > 0) pendencies.push({ code: "origin_missing", count: t.originMissingFacts, detail: `${t.originMissingFacts} baixa(s) sem pedido/venda de origem encontrado: canal e turno desconhecidos.`, blocksResult: false });
  if (losses && losses.totals.missingCostUnits > 0) pendencies.push({ code: "loss_cost_missing", count: losses.totals.missingCostUnits, detail: `${losses.totals.missingCostUnits} unidade(s) perdida(s) sem custo registrado.`, blocksResult: true });
  if (fees && fees.unknownCount > 0) pendencies.push({ code: "fee_unknown", count: fees.unknownCount, detail: `${fees.unknownCount} recebimento(s) sem taxa conhecida (${fees.unknownGrossCents} centavos brutos): a taxa não foi tratada como zero.`, blocksResult: true });
  if (pending?.estimate && pending.estimate.missingCostUnits > 0) pendencies.push({ code: "pending_cost_unknown", count: pending.estimate.missingCostUnits, detail: `${pending.estimate.missingCostUnits} unidade(s) a realizar sem custo médio atual: margem estimada indisponível para elas.`, blocksResult: false });
  if (reversals && reversals.open > 0) pendencies.push({ code: "reversal_open", count: reversals.open, detail: `${reversals.open} reversão(ões) externa(s) (reembolso/chargeback) aguardam regularização, ${reversals.outstandingCents} centavos a recuperar: ainda não são perda nem entram no resultado.`, blocksResult: false });
  for (const u of input.unreadable) if (u.count > 0) pendencies.push({ code: `unreadable_${u.source}`, count: u.count, detail: `${u.count} documento(s) de "${u.source}" ilegíveis (campo ausente ou inválido) ficaram fora do relatório.`, blocksResult: true });
  if (input.projection && input.projection.building.length > 0) pendencies.push({ code: "projection_building", count: input.projection.building.length, detail: `${input.projection.building.length} dia(s) do período ainda estão sendo preparados (${input.projection.building.join(", ")}): o relatório está incompleto; tente de novo em instantes.`, blocksResult: true });
  for (const source of input.truncated) pendencies.push({ code: `truncated_${source}`, count: 1, detail: `A leitura de "${source}" bateu no teto: o período está incompleto. Reduza o intervalo.`, blocksResult: true });

  const lossCostCents = losses?.totals.costCents ?? 0;
  const result = section("result", (): ResultSection => {
    const feesCents = input.fees.effectiveCents;
    const resultCents = realized.totals.grossProfitCents - lossCostCents - feesCents;
    const definitive = !pendencies.some((p) => p.blocksResult);
    return {
      grossProfitCents: realized.totals.grossProfitCents,
      lossCostCents,
      feesCents,
      resultCents,
      definitive,
      note: "Resultado após perdas e taxas = lucro bruto − perdas − taxas do período. NÃO é lucro líquido completo: faltam aluguel, pessoal, impostos e outras despesas.",
    };
  });

  const report: SalesReport = {
    scope: "full",
    from: input.from,
    to: input.to,
    today: input.today,
    filters,
    options: optionsOf(input),
    production: input.production,
    dateBasis: DATE_BASIS,
    truncated: [...input.truncated],
    skipped,
    projection: input.projection ?? null,
    realized,
    losses,
    adjustments,
    purchases,
    pending,
    retained,
    cancellations,
    ledger,
    reversals,
    fees,
    receipts,
    result,
    pendencies,
    checks: [],
    duplicatesIgnored,
  };
  report.checks = reconcileSales(report, sales);
  return report;
}

function optionsOf(input: SalesInput): FilterOptions {
  const byLabel = (a: { label: string; id: string }, b: { label: string; id: string }) => a.label.localeCompare(b.label, "pt-BR") || a.id.localeCompare(b.id);
  const products = new Map<string, string>();
  for (const c of input.catalog) products.set(c.productId, c.name);
  for (const f of input.sales) if (!products.has(f.productId)) products.set(f.productId, f.productName);
  return {
    shifts: Object.entries(input.labels.shifts).map(([id, label]) => ({ id, label })).sort(byLabel),
    categories: Object.entries(input.labels.categories).map(([id, label]) => ({ id, label })).sort(byLabel),
    products: [...products.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id)),
  };
}

/** Soma de dias sobre a data local (UTC puro, sem fuso: só calendário). */
function addDaysIso(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/* ----------------------------------------------------------------------------------------------- reconciliação */

const check = (id: string, label: string, kind: Check["kind"], expected: number, actual: number): Check => ({ id, label, kind, expected, actual, ok: expected === actual });

/**
 * Conferências internas: todos os agrupamentos saem da MESMA lista de fatos, então precisam fechar entre si (em unidades,
 * receita e CMV EXATO em micro-centavos — nunca em centavos já arredondados). Conferem também as fontes cruzadas: o reembolso
 * dos cancelamentos × os lançamentos `order_refund` da carteira, e as transferências (anulam-se entre alunos).
 */
export function reconcileSales(report: SalesReport, sales: readonly SaleFact[] = []): Check[] {
  const t = report.realized.totals;
  const checks: Check[] = [];
  const groups: [string, GroupRow[] | ProductRow[]][] = [
    ["produto", report.realized.byProduct],
    ["categoria", report.realized.byCategory],
    ["canal", report.realized.byChannel],
    ["turno", report.realized.byShift],
    ["dia", report.realized.byDay],
  ];
  for (const [name, rows] of groups) {
    checks.push(check(`units_${name}`, `Unidades por ${name} = total`, "internal", t.units, rows.reduce((n, r) => n + r.units, 0)));
    checks.push(check(`revenue_${name}`, `Receita por ${name} = total`, "internal", t.revenueCents, rows.reduce((n, r) => n + r.revenueCents, 0)));
    checks.push(check(`cost_${name}`, `CMV exato por ${name} = total`, "internal", t.costMicros, rows.reduce((n, r) => n + r.costMicros, 0)));
  }
  // Entre fontes: o que foi baixado de um pedido/venda nunca passa do valor PAGO registrado no próprio pedido/venda.
  const perOrigin = new Map<string, { revenue: number; paid: number }>();
  for (const f of sales) {
    if (f.originPaidCents === null || f.originPaidCents === undefined || f.revenueCents === null) continue;
    const e = perOrigin.get(f.origin) ?? { revenue: 0, paid: f.originPaidCents };
    e.revenue += f.revenueCents;
    perOrigin.set(f.origin, e);
  }
  checks.push(check("sold_within_paid", "Baixas de cada pedido/venda não passam do valor pago registrado nele", "cross", 0, [...perOrigin.values()].filter((e) => e.revenue > e.paid).length));
  if (report.cancellations && report.ledger) {
    const refunds = report.ledger.rows.find((r) => r.type === "order_refund")?.amountCents ?? 0;
    checks.push(check("refunds_ledger", "Reembolsos dos cancelamentos = lançamentos order_refund da carteira", "cross", report.cancellations.totals.refundCents, refunds));
  }
  if (report.ledger) {
    const net = (report.ledger.rows.find((r) => r.type === "transfer_in")?.amountCents ?? 0) + (report.ledger.rows.find((r) => r.type === "transfer_out")?.amountCents ?? 0);
    checks.push(check("transfers_net_zero", "Transferências entre alunos se anulam (não são faturamento)", "cross", 0, net));
  }
  return checks;
}

/* ------------------------------------------------------------------------------- visão OPERACIONAL (sem custo nem lucro) */

export type OperationalRow = { key: string; label: string; facts: number; units: number; revenueCents: number };
export type OperationalProductRow = { productId: string; name: string; categoryId: string | null; units: number; revenueCents: number };

/**
 * Visão da cantina: SÓ quantidades e valores vendidos. Construída por LISTA EXPLÍCITA de campos (nenhum custo, margem, lucro,
 * taxa, resultado, compra nem carteira): um campo novo na projeção completa não vaza por acidente.
 */
export type OperationalReport = {
  scope: "operational";
  from: LocalDate;
  to: LocalDate;
  today: LocalDate;
  filters: Filters;
  options: FilterOptions;
  production: boolean;
  dateBasis: Pick<SalesReport["dateBasis"], "sales" | "losses" | "pending" | "cancellations" | "retained">;
  truncated: string[];
  skipped: Partial<Record<SectionName, string>>;
  projection: ProjectionStats | null;
  realized: {
    totals: { facts: number; origins: number; units: number; revenueCents: number; ticketAverageCents: number | null };
    byProduct: OperationalProductRow[];
    byCategory: OperationalRow[];
    byChannel: OperationalRow[];
    byShift: OperationalRow[];
    byDay: OperationalRow[];
    rankings: { units: OperationalProductRow[]; revenue: OperationalProductRow[]; lowTurnover: { productId: string; name: string; units: number }[] };
  };
  losses: { rows: { productId: string; name: string; reasonCode: string; units: number }[]; totalUnits: number } | null;
  pending: { asOf: LocalDate; buckets: PendingSection["buckets"]; byProduct: { productId: string; name: string; units: number; valueCents: number }[]; totals: PendingSection["totals"] } | null;
  retained: RetainedSection | null;
  cancellations: { byKind: CancellationSection["byKind"]; byProduct: CancellationSection["byProduct"]; totals: CancellationSection["totals"] } | null;
  pendencies: { code: string; count: number; detail: string }[];
};

const opRow = (r: GroupRow): OperationalRow => ({ key: r.key, label: r.label, facts: r.facts, units: r.units, revenueCents: r.revenueCents });
const opProduct = (r: ProductRow): OperationalProductRow => ({ productId: r.productId, name: r.name, categoryId: r.categoryId, units: r.units, revenueCents: r.revenueCents });

export function toOperational(report: SalesReport): OperationalReport {
  const r = report.realized;
  const lossRows = report.losses?.rows.map((x) => ({ productId: x.productId, name: x.name, reasonCode: x.reasonCode, units: x.units })) ?? [];
  const { dateBasis } = report;
  return {
    scope: "operational",
    from: report.from,
    to: report.to,
    today: report.today,
    filters: report.filters,
    options: report.options,
    production: report.production,
    dateBasis: { sales: dateBasis.sales, losses: dateBasis.losses, pending: dateBasis.pending, cancellations: dateBasis.cancellations, retained: dateBasis.retained },
    truncated: [...report.truncated],
    skipped: Object.fromEntries(Object.entries(report.skipped).filter(([k]) => OPERATIONAL_SECTIONS.includes(k as SectionName))),
    projection: report.projection,
    realized: {
      // Ticket médio = receita ÷ pedidos/vendas distintos de origem (não por linha entregue).
      totals: { facts: r.totals.facts, origins: r.origins, units: r.totals.units, revenueCents: r.totals.revenueCents, ticketAverageCents: r.origins > 0 ? roundDiv(r.totals.revenueCents, r.origins) : null },
      byProduct: r.byProduct.map(opProduct),
      byCategory: r.byCategory.map(opRow),
      byChannel: r.byChannel.map(opRow),
      byShift: r.byShift.map(opRow),
      byDay: r.byDay.map(opRow),
      rankings: { units: r.rankings.units.map(opProduct), revenue: r.rankings.revenue.map(opProduct), lowTurnover: r.rankings.lowTurnover.map((x) => ({ ...x })) },
    },
    losses: report.losses ? { rows: lossRows, totalUnits: report.losses.totals.units } : null,
    pending: report.pending ? { asOf: report.pending.asOf, buckets: report.pending.buckets.map((b) => ({ ...b })), byProduct: report.pending.byProduct.map((p) => ({ productId: p.productId, name: p.name, units: p.units, valueCents: p.valueCents })), totals: { ...report.pending.totals } } : null,
    retained: report.retained ? { ...report.retained } : null,
    cancellations: report.cancellations ? { byKind: report.cancellations.byKind.map((k) => ({ ...k })), byProduct: report.cancellations.byProduct.map((p) => ({ ...p })), totals: { ...report.cancellations.totals } } : null,
    pendencies: report.pendencies.filter((p) => operationalPendency(p.code)).map((p) => ({ code: p.code, count: p.count, detail: p.detail })),
  };
}
