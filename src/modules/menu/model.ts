import { z } from "zod";
import { isLocalDate, type LocalDate } from "@/lib/dates/school-time";
import { CHANNELS, evaluateSellable, MAX_PRODUCT_SHIFTS, type PublicProduct, type SaleContext, type SellableRejection } from "@/modules/catalog/model";
import type { PurchaseDenial, ShiftCutoffs } from "@/modules/school/calendar";
import { isSafeLabel } from "@/modules/students/normalize";

/**
 * Cardápio por data e turno (docs/domains/catalog-menu.md §7). Regras puras, as mesmas no servidor (venda e portal) e na
 * tela da administração:
 *  - cardápio padrão: `defaultMenuRules/{productId}.shiftIds` = turnos em que o produto é oferecido em todo dia de
 *    funcionamento (sem regra ou lista vazia = fora do padrão; pode entrar como extra numa data);
 *  - exceção por data/turno (`menuOverrides/{data}__{turno}`): produto extra, ocultação de produto do padrão, limite de
 *    quantidade por produto e suspensão do atendimento.
 * Calendário/horário (F05) e catálogo (F06: ativo, canal, turno permitido, preço) continuam valendo por baixo.
 */
export const MENU_LIMIT_MAX = 5000;
export const MAX_OVERRIDE_ITEMS = 300;
/** Mesmo horizonte das exceções do calendário (F05): hoje … hoje+400. */
export const MENU_MAX_FUTURE_DAYS = 400;

export type DefaultRule = { productId: string; shiftIds: string[]; version: number };
export type OverrideInclude = "extra" | "hidden";
/** Exceção de um produto numa data/turno: `include` null = segue o padrão (só o limite muda). */
export type OverrideItem = { include: OverrideInclude | null; limit: number | null; reason: string };
export type MenuOverride = {
  date: LocalDate;
  shiftId: string;
  suspended: boolean;
  serviceReason: string;
  items: Record<string, OverrideItem>;
  version: number;
};

export const overrideId = (date: LocalDate, shiftId: string): string => `${date}__${shiftId}`;

const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isDocId = (value: unknown): value is string => typeof value === "string" && DOC_ID.test(value);

/* ---------------------------------------------------------------------------------------------- leitura defensiva */

export function parseDefaultRule(productId: string, data: Record<string, unknown> | undefined): DefaultRule {
  const shiftIds = Array.isArray(data?.shiftIds) ? (data.shiftIds as unknown[]).filter(isDocId) : [];
  return { productId, shiftIds, version: Number(data?.version) || 0 };
}

const isLimit = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MENU_LIMIT_MAX;

export function parseOverride(date: LocalDate, shiftId: string, data: Record<string, unknown> | undefined): MenuOverride {
  const items: Record<string, OverrideItem> = {};
  const raw = data?.items;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [productId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isDocId(productId) || !value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const include = entry.include === "extra" || entry.include === "hidden" ? entry.include : null;
      const limit = include !== "hidden" && isLimit(entry.limit) ? entry.limit : null;
      if (include || limit !== null) items[productId] = { include, limit, reason: typeof entry.reason === "string" ? entry.reason : "" };
    }
  }
  return {
    date,
    shiftId,
    suspended: data?.suspended === true,
    serviceReason: typeof data?.serviceReason === "string" ? data.serviceReason : "",
    items,
    version: Number(data?.version) || 0,
  };
}

/* ------------------------------------------------------------------------------------------------------- resolução */

export type MenuItemSource = "default" | "extra";

/** Situação de um produto no cardápio de uma data/turno, antes das regras do catálogo. */
export type ProductMenuState = {
  inDefault: boolean;
  include: OverrideInclude | null;
  limit: number | null;
  offered: boolean;
  source: MenuItemSource | null;
};

export function productMenuState(productId: string, shiftId: string, rule: DefaultRule | undefined, override: MenuOverride | null): ProductMenuState {
  const inDefault = Boolean(rule?.shiftIds.includes(shiftId));
  const entry = override?.items[productId];
  const include = entry?.include ?? null;
  const offered = include === "extra" || (inDefault && include !== "hidden");
  return { inDefault, include, limit: offered ? (entry?.limit ?? null) : null, offered, source: offered ? (inDefault ? "default" : "extra") : null };
}

/** Produto vendável em algum canal no turno (ativo, turno permitido, preço válido) segundo o catálogo. */
function catalogAllows(product: PublicProduct, shiftId: string): boolean {
  return CHANNELS.some((channel) => product.channels.includes(channel) && evaluateSellable(product, { channel, shiftId }).ok);
}

export type MenuItem = { product: PublicProduct; source: MenuItemSource; limit: number | null };
export type ResolvedMenu = { suspended: boolean; items: MenuItem[] };

/**
 * Cardápio resolvido de uma data/turno (o calendário — dia de funcionamento e horário — é decidido à parte, pela F05).
 * Suspenso = nada é oferecido. Cada item traz a origem (padrão/extra) e o limite de quantidade, quando houver.
 */
export function resolveMenu(input: {
  shiftId: string;
  products: readonly PublicProduct[];
  rules: ReadonlyMap<string, DefaultRule>;
  override: MenuOverride | null;
}): ResolvedMenu {
  if (input.override?.suspended) return { suspended: true, items: [] };
  const items = input.products.flatMap((product): MenuItem[] => {
    if (!catalogAllows(product, input.shiftId)) return [];
    const state = productMenuState(product.id, input.shiftId, input.rules.get(product.id), input.override);
    return state.offered && state.source ? [{ product, source: state.source, limit: state.limit }] : [];
  });
  return { suspended: false, items: items.sort((a, b) => a.product.name.localeCompare(b.product.name, "pt-BR")) };
}

export type MenuRejection = SellableRejection | "service_suspended" | "not_on_menu";
export type MenuSellability = { ok: true; product: PublicProduct; source: MenuItemSource; limit: number | null } | { ok: false; reason: MenuRejection };

/**
 * Decisão canônica de venda com o cardápio (checkout F11 / PDV F15): catálogo (ativo, canal, turno, preço) e depois o
 * cardápio da data/turno (suspensão, padrão/extra/oculto). Produto fora do cardápio não é vendido mesmo que o cliente
 * envie o ID manualmente. O limite devolvido é aplicado pelo comando de venda junto da reserva de cota (F10/F11).
 */
export function evaluateMenuSale(product: PublicProduct | null, ctx: SaleContext, rule: DefaultRule | undefined, override: MenuOverride | null): MenuSellability {
  const catalog = evaluateSellable(product, ctx);
  if (!catalog.ok) return catalog;
  if (override?.suspended) return { ok: false, reason: "service_suspended" };
  const state = productMenuState(catalog.product.id, ctx.shiftId, rule, override);
  if (!state.offered || !state.source) return { ok: false, reason: "not_on_menu" };
  return { ok: true, product: catalog.product, source: state.source, limit: state.limit };
}

/* ------------------------------------------------------------------------------- resposta do portal (GET /api/menu) */

export type MenuService = "open" | "suspended" | "closed";
export type MenuDenial = PurchaseDenial | "service_suspended";
export type MenuDayItem = { productId: string; source: MenuItemSource; limited: boolean };
export type MenuDay = {
  date: LocalDate;
  operating: boolean;
  service: MenuService;
  allowed: boolean;
  reason: MenuDenial | null;
  purchaseCutoffAt: string | null;
  cancelCutoffAt: string | null;
  items: MenuDayItem[];
};
/** Cadastro PÚBLICO do produto oferecido (nunca custo, fornecedor, motivo ou autor). */
export type MenuProduct = Pick<PublicProduct, "name" | "description" | "categoryId" | "priceCents" | "priceVersion" | "photoPath" | "channels"> & {
  id: string;
  categoryName: string;
};
export type MenuWeek = {
  timezone: string;
  serverNow: string;
  today: LocalDate;
  student: { id: string; name: string; shiftId: string; shiftName: string; active: boolean };
  /** Quem pede pode comprar pelo site para este aluno (responsável vinculado ou aluno com permissão). */
  canPurchase: boolean;
  cutoffs: ShiftCutoffs;
  days: MenuDay[];
  products: MenuProduct[];
};

/* -------------------------------------------------------------------------------------------------------- comandos */

const key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const docId = z.string().regex(DOC_ID);
const date = z.string().refine(isLocalDate, "Data inválida.");
const expectedVersion = z.number().int().min(0);
const reason = z.string().trim().max(120).refine(isSafeLabel, "Motivo inválido.").default("");

export const menuCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("setDefault"),
    key,
    productId: docId,
    expectedVersion,
    /** Turnos do cardápio padrão; lista vazia tira o produto do padrão. */
    shiftIds: z
      .array(docId)
      .max(MAX_PRODUCT_SHIFTS)
      .transform((list) => [...new Set(list)].sort()),
  }),
  z
    .object({
      action: z.literal("setItem"),
      key,
      date,
      shiftId: docId,
      productId: docId,
      expectedVersion,
      /** `default` = segue o cardápio padrão (remove extra/ocultação); `limit` null = sem limite. */
      include: z.enum(["default", "extra", "hidden"]),
      limit: z.number().int().min(1).max(MENU_LIMIT_MAX).nullable(),
      reason,
    })
    .refine((v) => v.include !== "hidden" || v.limit === null, { message: "Produto oculto não tem limite.", path: ["limit"] })
    .refine((v) => v.include !== "hidden" || v.reason.length > 0, { message: "Informe o motivo da ocultação.", path: ["reason"] }),
  z
    .object({ action: z.literal("setService"), key, date, shiftId: docId, expectedVersion, suspended: z.boolean(), reason })
    .refine((v) => !v.suspended || v.reason.length > 0, { message: "Informe o motivo da suspensão.", path: ["reason"] }),
]);
export type MenuCommand = z.infer<typeof menuCommandSchema>;
