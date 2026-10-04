import { z } from "zod";
import { isLocalDate } from "@/lib/dates/school-time";
import type { OrderItem } from "./model";

/**
 * Histórico de pedidos (F12, docs/domains/my-orders.md §11). Regras puras e tipos compartilhados servidor/cliente:
 * filtros, cursor opaco, classificação em abas e reconciliação por `version`. Nada aqui lê Firebase.
 *
 * PAGAMENTO × ENTREGA: o pedido antecipado só existe depois do débito na carteira, então "pago aguardando entrega" é
 * `status: "paid"` (pendente de ENTREGA, nunca de pagamento). "Pagamento pendente" é um estado distinto (`payment_pending`,
 * hoje não produzido pelo sistema; reservado para gateway) e nunca se mistura com o primeiro.
 */
export const CHANNELS = ["advance", "counter"] as const;
export type OrderChannel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<OrderChannel, string> = { advance: "Compra antecipada (site)", counter: "Compra no balcão" };

export const GROUPS = ["pending", "completed", "cancelled", "all"] as const;
export type OrderGroup = (typeof GROUPS)[number];
export const GROUP_LABEL: Record<OrderGroup, string> = { pending: "Pendentes", completed: "Concluídos", cancelled: "Cancelados", all: "Todos" };

type StatusInfo = { group: Exclude<OrderGroup, "all">; label: string; payment: "paid" | "pending" };
/** Situações conhecidas. Entrega/cancelamento/balcão são produzidos por F13/F14/F15; aqui só são EXIBIDOS se existirem. */
export const STATUS_INFO: Record<string, StatusInfo> = {
  payment_pending: { group: "pending", label: "Pagamento pendente", payment: "pending" },
  paid: { group: "pending", label: "Pago · aguardando entrega", payment: "paid" },
  preparing: { group: "pending", label: "Em preparo", payment: "paid" },
  ready: { group: "pending", label: "Pronto para retirada", payment: "paid" },
  not_picked_up: { group: "pending", label: "Não retirado · aguardando resolução", payment: "paid" },
  delivered: { group: "completed", label: "Entregue", payment: "paid" },
  cancelled: { group: "cancelled", label: "Cancelado · valor devolvido à carteira", payment: "paid" },
};
export const KNOWN_STATUSES = Object.keys(STATUS_INFO);

/**
 * Lista FECHADA: toda situação nova (F13–F15) entra aqui junto com a tarefa que a produz, porque as abas filtram por
 * `status in [...]` na consulta. Uma situação fora da lista nunca quebra a tela (texto neutro "Em andamento") e aparece
 * em "Todos", mas não nas abas — por isso não pode ser introduzida sem atualizar esta tabela.
 */
export const statusInfo = (status: string): StatusInfo => STATUS_INFO[status] ?? { group: "pending", label: "Em andamento", payment: "paid" };
export const statusesOf = (group: OrderGroup): string[] | null =>
  group === "all" ? null : KNOWN_STATUSES.filter((s) => STATUS_INFO[s]!.group === group);

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const localDate = z.string().refine(isLocalDate, "Data inválida.");
export const MAX_PAGE = 50;
export const DEFAULT_PAGE = 20;

export const listFiltersSchema = z
  .object({
    studentId: z.string().regex(ID).optional(),
    group: z.enum(GROUPS).default("all"),
    status: z.string().refine((s) => KNOWN_STATUSES.includes(s), "Situação inválida.").optional(),
    channel: z.enum(CHANNELS).optional(),
    shiftId: z.string().regex(ID).optional(),
    from: localDate.optional(),
    to: localDate.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "Período invertido." });
export type ListFilters = z.infer<typeof listFiltersSchema>;

/** Converte parâmetros de URL vazios em ausentes (a tela envia só o que está preenchido, mas ser tolerante é barato). */
export function filtersFromParams(params: URLSearchParams): unknown {
  const out: Record<string, string> = {};
  for (const [key, value] of params) if (value !== "") out[key] = value;
  return out;
}

/** Item exatamente como gravado na compra (snapshot). Campos internos (reserva, categoria) não saem do servidor. */
export type OrderItemView = Pick<OrderItem, "lineNo" | "productId" | "name" | "unit" | "quantity" | "unitPriceCents" | "discountCents" | "subtotalCents">;

export type OrderView = {
  orderId: string;
  studentId: string;
  studentName: string;
  consumptionDate: string;
  shiftId: string;
  shiftName: string | null;
  channel: string;
  status: string;
  group: Exclude<OrderGroup, "all">;
  statusLabel: string;
  paymentState: "paid" | "pending";
  items: OrderItemView[];
  itemCount: number;
  totalCents: number;
  createdAt: string | null;
  version: number;
};

export type OrderReceipt = {
  /** Lançamento no livro da carteira que pagou o pedido (valor negativo = débito). */
  walletEntryId: string;
  seq: number | null;
  amountCents: number | null;
  balanceAfterCents: number | null;
  reason: string | null;
  createdAt: string | null;
};
export type OrderDetail = OrderView & {
  /** Papel de quem comprou (o responsável/aluno que fez a compra; nunca UID ou dado interno). */
  purchasedBy: "guardian" | "student" | "staff" | null;
  cancelDeadlineAt: string | null;
  timeline: { kind: "created" | "paid"; at: string | null; label: string }[];
  receipt: OrderReceipt;
};

export type OrderPage = {
  orders: OrderView[];
  nextCursor: string | null;
  /** Alunos cobertos pela consulta (responsável: todos os vinculados ativos; aluno: ele mesmo). */
  students: { id: string; name: string }[];
  /** Turnos para o filtro; só na primeira página. */
  shifts: { id: string; name: string }[] | null;
};

/** Ordem do histórico: data de consumo e ID, ambos decrescentes (é o `orderBy` da consulta e a chave do cursor). */
export const orderKey = (o: Pick<OrderView, "consumptionDate" | "orderId">): string => `${o.consumptionDate}|${o.orderId}`;
export const compareNewestFirst = (a: Pick<OrderView, "consumptionDate" | "orderId">, b: Pick<OrderView, "consumptionDate" | "orderId">): number =>
  orderKey(a) < orderKey(b) ? 1 : orderKey(a) > orderKey(b) ? -1 : 0;

/**
 * Reconcilia uma releitura da PRIMEIRA página com o que a tela já carregou (páginas seguintes incluídas):
 * - o pedido mais novo vence pela `version` do servidor (resposta atrasada nunca faz um pedido regredir);
 * - dentro do trecho que a releitura cobre, pedido ausente deixou de combinar com o filtro e sai da lista;
 * - páginas antigas já carregadas (além da fronteira da releitura) permanecem.
 */
export function reconcileFirstPage(previous: readonly OrderView[], fresh: readonly OrderView[], freshHasMore: boolean): OrderView[] {
  const freshById = new Map(fresh.map((o) => [o.orderId, o]));
  const boundary = freshHasMore && fresh.length > 0 ? orderKey(fresh[fresh.length - 1]!) : null;
  const kept: OrderView[] = [];
  for (const old of previous) {
    const replacement = freshById.get(old.orderId);
    if (replacement) {
      kept.push(replacement.version >= old.version ? replacement : old);
      freshById.delete(old.orderId);
    } else if (boundary !== null && orderKey(old) < boundary) kept.push(old);
  }
  return [...kept, ...freshById.values()].sort(compareNewestFirst);
}

/** União de uma página seguinte, sem duplicar IDs (a versão maior vence). */
export function appendPage(current: readonly OrderView[], page: readonly OrderView[]): OrderView[] {
  const byId = new Map(current.map((o) => [o.orderId, o]));
  for (const o of page) {
    const known = byId.get(o.orderId);
    if (!known || o.version > known.version) byId.set(o.orderId, o);
  }
  return [...byId.values()].sort(compareNewestFirst);
}

/** "Hoje" / "Amanhã" / null: destaque dos próximos pedidos (datas locais YYYY-MM-DD). */
export function relativeDay(date: string, today: string, tomorrow: string): "Hoje" | "Amanhã" | null {
  return date === today ? "Hoje" : date === tomorrow ? "Amanhã" : null;
}
