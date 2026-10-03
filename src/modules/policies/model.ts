import { z } from "zod";
import { isLocalDate } from "@/lib/dates/school-time";

/**
 * Política de compra do aluno (docs/domains/policies.md §9). Permissões separadas de site e balcão, limites diário e
 * semanal por DATA DE CONSUMO (centavos inteiros; null = sem teto parental, não saldo infinito) e bloqueios por
 * produto/categoria. Ausência de campo = negado (permissões) ou sem teto/bloqueio.
 */
export const LIMIT_MAX_CENTS = 1_000_000;
export const MAX_BLOCKED = 100;

export type StudentPolicy = {
  allowSitePurchase: boolean;
  allowCounterPurchase: boolean;
  dailyLimitCents: number | null;
  weeklyLimitCents: number | null;
  blockedProductIds: string[];
  blockedCategoryIds: string[];
  configVersion: number;
};

const limitOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);
const idList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))].sort() : [];

export function parsePolicy(data: Record<string, unknown> | undefined): StudentPolicy {
  return {
    allowSitePurchase: data?.allowSitePurchase === true,
    allowCounterPurchase: data?.allowCounterPurchase === true,
    dailyLimitCents: limitOrNull(data?.dailyLimitCents),
    weeklyLimitCents: limitOrNull(data?.weeklyLimitCents),
    blockedProductIds: idList(data?.blockedProductIds),
    blockedCategoryIds: idList(data?.blockedCategoryIds),
    configVersion: typeof data?.configVersion === "number" ? data.configVersion : 0,
  };
}

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const limitSchema = z.number().int().min(1).max(LIMIT_MAX_CENTS);
const idListSchema = z.array(idSchema).max(MAX_BLOCKED);

export const setPolicySchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    studentId: idSchema,
    allowSitePurchase: z.boolean().optional(),
    allowCounterPurchase: z.boolean().optional(),
    /** Centavos; `null` remove o teto. Ausente = não altera. */
    dailyLimitCents: limitSchema.nullable().optional(),
    weeklyLimitCents: limitSchema.nullable().optional(),
    /** Lista COMPLETA (substitui a anterior); ausente = não altera. Com `expectedConfigVersion` evita sobrescrever edição concorrente. */
    blockedProductIds: idListSchema.optional(),
    blockedCategoryIds: idListSchema.optional(),
    expectedConfigVersion: z.number().int().min(0).optional(),
    reason: z.string().trim().min(3).max(300).default("Ajuste de permissões de compra"),
  })
  .refine(
    (v) =>
      v.allowSitePurchase !== undefined ||
      v.allowCounterPurchase !== undefined ||
      v.dailyLimitCents !== undefined ||
      v.weeklyLimitCents !== undefined ||
      v.blockedProductIds !== undefined ||
      v.blockedCategoryIds !== undefined,
    { message: "Nada a alterar." },
  );
export type SetPolicyInput = z.infer<typeof setPolicySchema>;

export const exceptionSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  action: z.enum(["create", "revoke"]),
  studentId: idSchema,
  exceptionId: idSchema.optional(),
  consumptionDate: z.string().refine(isLocalDate, "Data inválida.").optional(),
  maxCents: limitSchema.optional(),
  reason: z.string().trim().min(3).max(300).default("Exceção de compra autorizada"),
});

export type ExceptionKind = "guardian" | "admin";
export type ExceptionStatus = "active" | "used" | "revoked";
export type PolicyException = {
  id: string;
  studentId: string;
  kind: ExceptionKind;
  status: ExceptionStatus;
  consumptionDate: string;
  maxCents: number;
};

export function parseException(id: string, data: Record<string, unknown> | undefined): PolicyException | null {
  if (!data) return null;
  const { studentId, kind, status, consumptionDate, maxCents } = data;
  if (typeof studentId !== "string" || (kind !== "guardian" && kind !== "admin")) return null;
  if (status !== "active" && status !== "used" && status !== "revoked") return null;
  if (!isLocalDate(consumptionDate) || typeof maxCents !== "number") return null;
  return { id, studentId, kind, status, consumptionDate, maxCents };
}

export const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
