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

export const isOpenStatus = (status: string): boolean => (OPEN_STATUSES as readonly string[]).includes(status);
export const isNotPickedUp = (status: string): boolean => status === NOT_PICKED_UP || status === NOT_PICKED_UP_CLOSED;

/** Progresso de uma linha. Pedidos anteriores à F13 não têm os campos: contam como zero. */
export type ItemProgress = { quantity: number; deliveredQty?: number; canceledQty?: number };
export const deliveredOf = (i: ItemProgress): number => i.deliveredQty ?? 0;
export const canceledOf = (i: ItemProgress): number => i.canceledQty ?? 0;
/** Unidades ainda por entregar: nunca negativo. */
export const remainingOf = (i: ItemProgress): number => Math.max(0, i.quantity - deliveredOf(i) - canceledOf(i));

/** Valor (centavos) de `units` unidades de uma linha, proporcional ao subtotal pago (exato enquanto não houver desconto). */
export const valueOfUnits = (item: { quantity: number; subtotalCents: number }, units: number): number => (item.quantity === 0 ? 0 : Math.round((item.subtotalCents * units) / item.quantity));

export const totalsOf = (items: readonly ItemProgress[]) => ({
  scheduled: items.reduce((n, i) => n + i.quantity, 0),
  delivered: items.reduce((n, i) => n + deliveredOf(i), 0),
  canceled: items.reduce((n, i) => n + canceledOf(i), 0),
  remaining: items.reduce((n, i) => n + remainingOf(i), 0),
});

export type NonPickupState = { resolved: boolean } | null;

/**
 * Situação do pedido a partir das quantidades:
 *  - não retirado: pendente de resolução ou encerrado (a resolução é explícita, nunca implícita);
 *  - tudo entregue (ou entregue + cancelado) e algo entregue → `delivered`;
 *  - algo entregue e algo restante → `partially_delivered`;
 *  - nada entregue → estágio de preparo (`paid` = agendado, `preparing`, `ready`).
 * Pedido sem nenhuma unidade restante nem entregue (tudo cancelado) é de F14 e fica fora desta função.
 */
export function aggregateStatus(input: { items: readonly ItemProgress[]; prep: PrepStage; nonPickup: NonPickupState }): string {
  if (input.nonPickup) return input.nonPickup.resolved ? NOT_PICKED_UP_CLOSED : NOT_PICKED_UP;
  const t = totalsOf(input.items);
  if (t.delivered > 0 && t.remaining === 0) return "delivered";
  if (t.delivered > 0) return "partially_delivered";
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

/** Resoluções previstas pelo produto. Só `close_charged` existe nesta tarefa; as outras são recusadas explicitamente. */
export const RESOLUTIONS = ["close_charged", "cancel_refund", "reschedule"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export const PENDING_RESOLUTIONS: Record<Exclude<Resolution, "close_charged">, { task: "F14" | "F16"; label: string }> = {
  cancel_refund: { task: "F14", label: "Cancelar e reembolsar a carteira (chega com a F14)" },
  reschedule: { task: "F16", label: "Reagendar para outra data (chega com a F16)" },
};

export const resolveSchema = z
  .object({
    key: z.string().regex(KEY),
    orderId: z.string().regex(ID),
    resolution: z.enum(RESOLUTIONS),
    reason,
    /** Unidades que serão DESCARTADAS (perda explícita). O que não for listado volta à disponibilidade sem perda. */
    discards: z.array(qtyLine).max(MAX_LINES_PER_DATE).default([]),
  })
  .strict()
  .refine((v) => new Set(v.discards.map((l) => l.lineNo)).size === v.discards.length, "Linha repetida.")
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
export const CLASSIFICATION_LABEL: Record<typeof RETAINED_CLASSIFICATION, string> = {
  retained_charge_not_picked_up: "Cobrança mantida por não retirada (não é venda entregue)",
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

export type DayItemView = { lineNo: number; productId: string; name: string; quantity: number; deliveredQty: number; canceledQty: number; remainingQty: number };
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
      row.scheduled += item.quantity;
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
