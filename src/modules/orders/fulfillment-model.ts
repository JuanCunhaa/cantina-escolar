import { z } from "zod";
import { isLocalDate } from "@/lib/dates/school-time";
import { MAX_LINES_PER_DATE, MAX_LINE_QUANTITY } from "./model";

/**
 * Preparação, entrega e não retirada (F13, docs/domains/fulfillment.md §12). Regras puras compartilhadas por servidor e
 * cliente: situação agregada determinística, quantidades restantes, esquemas dos comandos, totais do painel de preparação
 * e exportação CSV. Nada aqui lê Firebase.
 *
 * SITUAÇÃO AGREGADA (`aggregateStatus`): depende só do snapshot do pedido (itens com `deliveredQty`/`canceledQty`), do
 * estágio de preparo (`prep`) e do registro de não retirada. A mesma entrada dá sempre a mesma situação.
 *
 * ENTREGA NÃO COBRA DE NOVO: o pedido já foi pago na F11 (débito único no livro). Entregar só baixa estoque/custo pelas
 * quantidades efetivamente entregues; nenhuma regra desta tarefa mexe na carteira.
 */
export const PREP_STAGES = ["none", "preparing", "ready"] as const;
export type PrepStage = (typeof PREP_STAGES)[number];

/** Situações em que ainda há o que entregar (cancelamento/reembolso futuros, F14, só tiram unidades via `canceledQty`). */
export const OPEN_STATUSES = ["paid", "preparing", "ready", "partially_delivered"] as const;
export const NOT_PICKED_UP = "not_picked_up";
export const NOT_PICKED_UP_CLOSED = "not_picked_up_closed";
/** Todas as unidades canceladas e reembolsadas (nada entregue). Grafia herdada da F12 (`STATUS_INFO`). */
export const CANCELLED = "cancelled";

export const isOpenStatus = (status: string): boolean => (OPEN_STATUSES as readonly string[]).includes(status);
export const isNotPickedUp = (status: string): boolean => status === NOT_PICKED_UP || status === NOT_PICKED_UP_CLOSED;

/**
 * Progresso de uma linha. Pedidos anteriores à F13 não têm os campos: contam como zero. `exchangedQty` (F16) = unidades
 * TROCADAS por outro produto: saíram desta linha (o valor pago delas foi aproveitado na troca) e nunca voltam a ser restantes.
 */
export type ItemProgress = { quantity: number; deliveredQty?: number; canceledQty?: number; exchangedQty?: number };
export const deliveredOf = (i: ItemProgress): number => i.deliveredQty ?? 0;
export const canceledOf = (i: ItemProgress): number => i.canceledQty ?? 0;
export const exchangedOf = (i: ItemProgress): number => i.exchangedQty ?? 0;
/** Unidades já liquidadas (entregues, canceladas ou trocadas). */
export const settledOf = (i: ItemProgress): number => deliveredOf(i) + canceledOf(i) + exchangedOf(i);
/** Unidades ainda por entregar: nunca negativo. */
export const remainingOf = (i: ItemProgress): number => Math.max(0, i.quantity - settledOf(i));

/**
 * Valor (centavos) de `units` unidades de uma linha, proporcional ao subtotal PAGO. `subtotalCents` é o que de fato foi
 * debitado da carteira (o total do pedido é a soma dos subtotais; qualquer desconto por linha já está embutido nele) e é a
 * ÚNICA base de entrega, retenção e reembolso: nunca o preço atual do produto. Com desconto o valor por unidade pode ser
 * fracionário: o arredondamento acontece UMA vez sobre o acumulado (ver `remainingValueOf`).
 */
export const valueOfUnits = (item: { quantity: number; subtotalCents: number }, units: number): number => (item.quantity === 0 ? 0 : Math.round((item.subtotalCents * units) / item.quantity));

/**
 * Valor ainda não entregue/cancelado da linha = subtotal pago − valor (arredondado UMA vez) das unidades já entregues/canceladas.
 * Calculado pelo acumulado, nunca por fatias arredondadas separadamente: Σ das entregas + Σ dos reembolsos + restante = subtotal
 * pago, sem deriva de centavos e em qualquer ordem entre entregas e cancelamentos (o acumulado é o de entregues + canceladas e
 * cada operação recebe a diferença do acumulado antes/depois).
 */
type Settling = { quantity: number; subtotalCents: number; deliveredQty?: number; canceledQty?: number; exchangedQty?: number };
export const remainingValueOf = (item: Settling): number => Math.max(0, item.subtotalCents - valueOfUnits(item, settledOf(item)));
/** Valor (centavos) que sai do saldo "a liquidar" da linha ao liquidar mais `units` unidades (entregar, cancelar OU trocar). */
const settledDelta = (item: Settling, units: number): number => {
  const settled = settledOf(item);
  return valueOfUnits(item, settled + units) - valueOfUnits(item, settled);
};
/** Receita da entrega de `units` unidades: diferença do acumulado (entregues + canceladas); Σ entregas + Σ reembolsos = subtotal da linha. */
export const deliveryRevenueOf = (item: Settling, units: number): number => settledDelta(item, units);
/** Reembolso (centavos) de `units` unidades ainda não entregues da linha: o valor PAGO registrado no pedido, rateado por acumulado. */
export const refundValueOf = (item: Settling, units: number): number => settledDelta(item, units);
/** Crédito da troca (F16) por `units` unidades ainda não entregues: o valor PAGO delas, pelo mesmo rateio por acumulado. */
export const exchangeCreditOf = (item: Settling, units: number): number => settledDelta(item, units);

export const totalsOf = (items: readonly ItemProgress[]) => ({
  scheduled: items.reduce((n, i) => n + i.quantity, 0),
  delivered: items.reduce((n, i) => n + deliveredOf(i), 0),
  canceled: items.reduce((n, i) => n + canceledOf(i), 0),
  exchanged: items.reduce((n, i) => n + exchangedOf(i), 0),
  remaining: items.reduce((n, i) => n + remainingOf(i), 0),
});

export type NonPickupState = { resolved: boolean } | null;

/**
 * Situação do pedido a partir das quantidades:
 *  - não retirado: pendente de resolução ou encerrado (a resolução é explícita, nunca implícita);
 *  - tudo entregue (ou entregue + cancelado) e algo entregue → `delivered`;
 *  - algo entregue e algo restante → `partially_delivered`;
 *  - nada entregue → estágio de preparo (`paid` = agendado, `preparing`, `ready`).
 *  - nada entregue e nada restante (tudo cancelado/reembolsado) → `cancelled` (F14).
 * Cancelamento parcial NÃO muda a situação: o que sobrou segue o fluxo normal (as quantidades canceladas ficam em `canceledQty`).
 */
export function aggregateStatus(input: { items: readonly ItemProgress[]; prep: PrepStage; nonPickup: NonPickupState }): string {
  if (input.nonPickup) return input.nonPickup.resolved ? NOT_PICKED_UP_CLOSED : NOT_PICKED_UP;
  const t = totalsOf(input.items);
  if (t.delivered > 0 && t.remaining === 0) return "delivered";
  if (t.delivered > 0) return "partially_delivered";
  if (t.remaining === 0 && t.canceled > 0) return CANCELLED;
  return input.prep === "preparing" ? "preparing" : input.prep === "ready" ? "ready" : "paid";
}

/** Preparo só avança (agendado → em preparação → pronto) e só enquanto nada foi entregue. */
export function canPrepare(status: string, to: Exclude<PrepStage, "none">): boolean {
  if (to === "preparing") return status === "paid";
  return status === "paid" || status === "preparing";
}

/* ------------------------------------------------------------------------------------------------ comandos */

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const reason = z.string().trim().min(5, "Informe o motivo (mínimo 5 caracteres).").max(300);
const lineNo = z.number().int().min(1).max(MAX_LINES_PER_DATE * 5);

export const prepareSchema = z.object({ key: z.string().regex(KEY), orderId: z.string().regex(ID), to: z.enum(["preparing", "ready"]) }).strict();
export type PrepareInput = z.infer<typeof prepareSchema>;

const qtyLine = z.object({ lineNo, quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) }).strict();
/** `studentId` confirma A PESSOA e o pedido: o servidor recusa se o pedido não for deste aluno. */
export const deliverSchema = z
  .object({ key: z.string().regex(KEY), orderId: z.string().regex(ID), studentId: z.string().regex(ID), lines: z.array(qtyLine).min(1).max(MAX_LINES_PER_DATE) })
  .strict()
  .refine((v) => new Set(v.lines.map((l) => l.lineNo)).size === v.lines.length, "Linha repetida.")
  .transform((v) => ({ ...v, lines: [...v.lines].sort((a, b) => a.lineNo - b.lineNo) }));
export type DeliverInput = z.infer<typeof deliverSchema>;

export const notPickedUpSchema = z.object({ key: z.string().regex(KEY), orderId: z.string().regex(ID), reason }).strict();
export type NotPickedUpInput = z.infer<typeof notPickedUpSchema>;

const sortedLines = (lines: { lineNo: number; quantity: number }[]) => [...lines].sort((a, b) => a.lineNo - b.lineNo);
const uniqueLines = (lines: { lineNo: number }[]) => new Set(lines.map((l) => l.lineNo)).size === lines.length;

/**
 * Cancelamento (F14, docs/domains/cancellations.md §14). `lines` ausente = cancelar TODO o restante (total); informado =
 * cancelamento parcial por quantidade de item. `discards` (só equipe com permissão de perda) = unidades canceladas que serão
 * DESCARTADAS como perda explícita; o que não for listado só libera a reserva (sem entrada física). O motivo é obrigatório
 * para todos (família e equipe) e a auditoria o guarda.
 */
export const cancelSchema = z
  .object({
    key: z.string().regex(KEY),
    orderId: z.string().regex(ID),
    reason,
    lines: z.array(qtyLine).min(1).max(MAX_LINES_PER_DATE).optional(),
    discards: z.array(qtyLine).max(MAX_LINES_PER_DATE).default([]),
  })
  .strict()
  .refine((v) => uniqueLines(v.lines ?? []) && uniqueLines(v.discards), "Linha repetida.")
  .transform((v) => ({ ...v, lines: v.lines ? sortedLines(v.lines) : undefined, discards: sortedLines(v.discards) }));
export type CancelInput = z.infer<typeof cancelSchema>;

/** Resoluções previstas pelo produto: `close_charged` (F13), `cancel_refund` (F14) e `reschedule` (F16, mesmo planejamento do reagendamento). */
export const RESOLUTIONS = ["close_charged", "cancel_refund", "reschedule"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** Destino de um reagendamento (F16): data e turno, exceção opcional de limite e a exceção OPERACIONAL de horário, explícita. */
export const destinationShape = {
  toDate: z.string().refine(isLocalDate, "Data inválida."),
  toShiftId: z.string().regex(ID),
  /** A equipe confirma conscientemente que o horário de compra do destino já fechou (exceção operacional auditada). */
  overrideCutoff: z.boolean().default(false),
  /** Exceção de uso único (autorização do responsável ou administrativa) para cobrir limite do destino. */
  exceptionId: z.string().regex(ID).optional(),
};

export const resolveSchema = z
  .object({
    key: z.string().regex(KEY),
    orderId: z.string().regex(ID),
    resolution: z.enum(RESOLUTIONS),
    reason,
    /** Unidades que serão DESCARTADAS (perda explícita). O que não for listado volta à disponibilidade sem perda. */
    discards: z.array(qtyLine).max(MAX_LINES_PER_DATE).default([]),
    toDate: destinationShape.toDate.optional(),
    toShiftId: destinationShape.toShiftId.optional(),
    overrideCutoff: destinationShape.overrideCutoff,
    exceptionId: destinationShape.exceptionId,
  })
  .strict()
  .refine((v) => new Set(v.discards.map((l) => l.lineNo)).size === v.discards.length, "Linha repetida.")
  .refine((v) => (v.resolution === "reschedule" ? Boolean(v.toDate && v.toShiftId) && v.discards.length === 0 : !v.toDate && !v.toShiftId && !v.overrideCutoff && !v.exceptionId), "Destino só no reagendamento (e sem descarte).")
  .transform((v) => ({ ...v, discards: [...v.discards].sort((a, b) => a.lineNo - b.lineNo) }));
export type ResolveInput = z.infer<typeof resolveSchema>;

/**
 * CLASSIFICAÇÃO FINANCEIRA do encerramento de não retirada com cobrança (decisão documentada, docs/decisions.md):
 * `retained_charge_not_picked_up` = valor JÁ PAGO e mantido pela escola pelas unidades não retiradas. NÃO é venda entregue,
 * NÃO cria lançamento no livro (o débito da compra segue sendo o único), NÃO é reembolso e NÃO é perda: perda só existe se a
 * administração descartar unidades explicitamente (movimento de perda no estoque). Relatórios (F21) somam a cobrança retida
 * em linha separada da receita de entregas.
 */
export const RETAINED_CLASSIFICATION = "retained_charge_not_picked_up" as const;
/** `refunded_not_picked_up` (F14, `cancel_refund`): restante não retirado cancelado e devolvido à carteira ORIGINAL; não é cobrança retida. */
export const REFUNDED_CLASSIFICATION = "refunded_not_picked_up" as const;
export const CLASSIFICATION_LABEL: Record<typeof RETAINED_CLASSIFICATION | typeof REFUNDED_CLASSIFICATION, string> = {
  retained_charge_not_picked_up: "Cobrança mantida por não retirada (não é venda entregue)",
  refunded_not_picked_up: "Não retirado cancelado e reembolsado à carteira do aluno",
};

/* ----------------------------------------------------------------------------------------- consultas do dia */

export const dayQuerySchema = z
  .object({
    date: z.string().refine(isLocalDate, "Data inválida.").optional(),
    shiftId: z.string().regex(ID).optional(),
    classId: z.string().regex(ID).optional(),
    status: z.string().max(40).optional(),
    q: z.string().trim().max(80).optional(),
  })
  .strict();
export type DayQuery = z.infer<typeof dayQuerySchema>;

export type DayItemView = { lineNo: number; productId: string; name: string; quantity: number; deliveredQty: number; canceledQty: number; exchangedQty: number; remainingQty: number };
export type DayOrderView = {
  orderId: string;
  studentId: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  shiftId: string;
  shiftName: string | null;
  consumptionDate: string;
  status: string;
  statusLabel: string;
  items: DayItemView[];
  totalUnits: number;
  remainingUnits: number;
  /** Pendência de resolução (não retirado ainda sem decisão): destaca a linha. */
  needsResolution: boolean;
  version: number;
};
export type DayOrders = {
  date: string;
  today: string;
  /** Entrega só no próprio dia de consumo (fuso da escola). */
  canDeliver: boolean;
  orders: DayOrderView[];
  truncated: boolean;
  counts: Record<string, number>;
  classes: { id: string; name: string }[];
  shifts: { id: string; name: string }[];
};

/* ------------------------------------------------------------------------------------- painel de preparação */

export type PrepRow = { productId: string; name: string; consumptionDate: string; shiftId: string; scheduled: number; canceled: number; delivered: number; remaining: number; notPickedUp: number };
type PrepOrder = { consumptionDate: string; shiftId: string; status: string; items: readonly (ItemProgress & { productId: string; name: string })[] };

/**
 * Totais por produto/data/turno. Conservação (testada): agendadas = canceladas + entregues + restantes + não retiradas.
 * Unidades de pedido não retirado deixam de ser "restantes" (não há mais o que entregar) e aparecem à parte; as
 * entregues antes da não retirada continuam entregues.
 */
export function aggregatePreparation(orders: readonly PrepOrder[]): PrepRow[] {
  const rows = new Map<string, PrepRow>();
  for (const o of orders) {
    for (const item of o.items) {
      const key = `${o.consumptionDate}|${o.shiftId}|${item.productId}`;
      const row = rows.get(key) ?? { productId: item.productId, name: item.name, consumptionDate: o.consumptionDate, shiftId: o.shiftId, scheduled: 0, canceled: 0, delivered: 0, remaining: 0, notPickedUp: 0 };
      row.scheduled += item.quantity - exchangedOf(item); // unidades trocadas saíram do pedido (a linha nova as substitui)
      row.canceled += canceledOf(item);
      row.delivered += deliveredOf(item);
      if (isNotPickedUp(o.status)) row.notPickedUp += remainingOf(item);
      else row.remaining += remainingOf(item);
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.consumptionDate.localeCompare(b.consumptionDate) || a.shiftId.localeCompare(b.shiftId) || a.name.localeCompare(b.name, "pt-BR") || a.productId.localeCompare(b.productId));
}

export type Preparation = {
  date: string;
  today: string;
  shiftId: string | null;
  /** Totais da data/turno escolhidos. */
  rows: PrepRow[];
  /** Próximos sete dias (hoje … hoje+6): unidades ainda a entregar por produto/data/turno. */
  forecast: PrepRow[];
  forecastFrom: string;
  forecastTo: string;
  /** Pedidos que exigem decisão da administração (não retirados sem resolução; vencidos sem entrega ainda não marcados). */
  attention: { orderId: string; studentName: string; consumptionDate: string; shiftId: string; status: string; remainingUnits: number; remainingCents: number; marked: boolean }[];
  truncated: boolean;
  shifts: { id: string; name: string }[];
};

/* ------------------------------------------------------------------------------------------ exportação CSV */

/** Célula segura: aspas duplicadas e neutralização de fórmula (=, +, -, @, tab) para planilhas. */
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
/** Separador `;` (convenção de planilha em pt-BR). */
export const toCsv = (rows: readonly (readonly (string | number)[])[]): string => rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
