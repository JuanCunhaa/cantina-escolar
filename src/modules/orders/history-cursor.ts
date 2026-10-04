import "server-only";
import { z } from "zod";
import { isLocalDate } from "@/lib/dates/school-time";

/** Cursor opaco do histórico: último (data de consumo, orderId) devolvido. Só o servidor codifica/decodifica (usa Buffer). */
export type OrderCursor = { d: string; o: string };
export const encodeCursor = (c: OrderCursor): string => Buffer.from(JSON.stringify(c)).toString("base64url");
export function decodeCursor(raw: string): OrderCursor | null {
  try {
    const schema = z.object({ d: z.string().refine(isLocalDate), o: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
    const parsed = schema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
