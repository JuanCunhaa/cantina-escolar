import { z } from "zod";
import { isSafeLabel } from "@/modules/students/normalize";

/** Canais de venda: compra antecipada pelo portal e venda no balcão (PDV). */
export const CHANNELS = ["advance", "counter"] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { advance: "Antecipado", counter: "Balcão" };

/** Modo de disponibilidade (docs/domains/inventory.md §15.1); ambos vendem por unidade de produto. */
export const AVAILABILITY_MODES = ["physical", "planned"] as const;
export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];
export const MODE_LABEL: Record<AvailabilityMode, string> = { physical: "Estoque físico", planned: "Planejado por data/turno" };

export const PRODUCT_STATUSES = ["active", "inactive"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Preço em centavos inteiros: mínimo R$ 0,01, teto R$ 500,00 por unidade (protege contra digitação errada). */
export const PRICE_MIN_CENTS = 1;
export const PRICE_MAX_CENTS = 50_000;
export const MAX_PRODUCT_SHIFTS = 10;

export const priceCentsSchema = z.number().int().min(PRICE_MIN_CENTS).max(PRICE_MAX_CENTS);
const label = (max: number) => z.string().trim().min(1).max(max).refine(isSafeLabel, "Texto inválido.");
/** Texto livre: sem caracteres de controle (quebra de linha permitida) e sem prefixo de fórmula. */
const freeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v.replace(/[\n\r]/g, "")) && !/^[=+\-@]/.test(v), "Texto inválido.");
const docId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** Listas de opções viram conjuntos ordenados (comparação estável e payload idempotente previsível). */
const channelsSchema = z
  .array(z.enum(CHANNELS))
  .min(1)
  .max(10)
  .transform((list) => CHANNELS.filter((c) => list.includes(c)));
const shiftIdsSchema = z
  .array(docId)
  .min(1)
  .max(MAX_PRODUCT_SHIFTS)
  .transform((list) => [...new Set(list)].sort());

/** Campos públicos editáveis (sem preço: preço muda só pelo comando próprio, com histórico). */
const publicFields = {
  name: label(80),
  description: freeText(280),
  categoryId: docId,
  channels: channelsSchema,
  shiftIds: shiftIdsSchema,
  availabilityMode: z.enum(AVAILABILITY_MODES),
};
/** Dados internos da administração; nunca vão para o documento público do produto. */
const privateFields = {
  defaultSupplier: freeText(80).default(""),
  internalNotes: freeText(500).default(""),
};

export const productCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), key, ...publicFields, ...privateFields, priceCents: priceCentsSchema }),
  z.object({ action: z.literal("update"), key, id: docId, expectedVersion: z.number().int().min(1), ...publicFields, ...privateFields }),
  z.object({
    action: z.literal("setPrice"),
    key,
    id: docId,
    expectedPriceVersion: z.number().int().min(1),
    priceCents: priceCentsSchema,
    reason: label(200),
  }),
  z.object({ action: z.literal("deactivate"), key, id: docId, reason: label(200) }),
  z.object({ action: z.literal("reactivate"), key, id: docId }),
]);
export type ProductCommand = z.infer<typeof productCommandSchema>;

export const categoryCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), key, name: label(60) }),
  z.object({ action: z.literal("rename"), key, id: docId, name: label(60) }),
  z.object({ action: z.literal("archive"), key, id: docId }),
  z.object({ action: z.literal("restore"), key, id: docId }),
]);
export type CategoryCommand = z.infer<typeof categoryCommandSchema>;

/** Documento público `products/{id}` como os clientes o leem (sem custo/fornecedor). */
export type PublicProduct = {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  priceCents: number;
  priceVersion: number;
  channels: Channel[];
  shiftIds: string[];
  availabilityMode: AvailabilityMode;
  status: ProductStatus;
  version: number;
  photoPath: string | null;
};

export type Category = { id: string; name: string; status: "active" | "archived" };

/** Leitura defensiva de um documento de produto (dados antigos ou malformados não quebram as telas). */
export function parseProduct(id: string, data: Record<string, unknown> | undefined): PublicProduct | null {
  if (!data || typeof data.name !== "string") return null;
  const channels = Array.isArray(data.channels) ? CHANNELS.filter((c) => (data.channels as unknown[]).includes(c)) : [];
  const shiftIds = Array.isArray(data.shiftIds) ? (data.shiftIds as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const price = Number(data.priceCents);
  return {
    id,
    name: data.name,
    description: typeof data.description === "string" ? data.description : "",
    categoryId: typeof data.categoryId === "string" ? data.categoryId : "",
    priceCents: Number.isInteger(price) ? price : 0,
    priceVersion: Number(data.priceVersion) || 0,
    channels,
    shiftIds,
    availabilityMode: data.availabilityMode === "planned" ? "planned" : "physical",
    status: data.status === "active" ? "active" : "inactive",
    version: Number(data.version) || 0,
    photoPath: typeof data.photoPath === "string" ? data.photoPath : null,
  };
}

export type SaleContext = { channel: Channel; shiftId: string };
export type SellableRejection = "product_not_found" | "product_inactive" | "channel_not_allowed" | "shift_not_allowed" | "invalid_price";
export type Sellability = { ok: true; product: PublicProduct } | { ok: false; reason: SellableRejection };

/**
 * Decisão canônica do catálogo para uma venda (canal + turno). O preço vem SEMPRE do produto atual lido pelo
 * servidor; o snapshot do item é responsabilidade do comando de checkout/PDV (F11/F15), não da tela.
 * O cardápio por data (F07) e estoque/cotas (F10) aplicam suas próprias regras por cima desta.
 */
export function evaluateSellable(product: PublicProduct | null, ctx: SaleContext): Sellability {
  if (!product) return { ok: false, reason: "product_not_found" };
  if (product.status !== "active") return { ok: false, reason: "product_inactive" };
  if (!product.channels.includes(ctx.channel)) return { ok: false, reason: "channel_not_allowed" };
  if (!product.shiftIds.includes(ctx.shiftId)) return { ok: false, reason: "shift_not_allowed" };
  if (!priceCentsSchema.safeParse(product.priceCents).success || product.priceVersion < 1) return { ok: false, reason: "invalid_price" };
  return { ok: true, product };
}

/** Converte "8,50" / "8.50" / "8" digitado em centavos inteiros, sem ponto flutuante. Inválido = null. */
export function parseBRLInput(value: string): number | null {
  const match = /^\s*(?:R\$\s*)?(\d{1,6})(?:[.,](\d{1,2}))?\s*$/.exec(value);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
  return priceCentsSchema.safeParse(cents).success ? cents : null;
}
