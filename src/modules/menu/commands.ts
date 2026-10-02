import { FieldValue, type DocumentSnapshot, type Firestore, type Transaction } from "firebase-admin/firestore";
import { addDays, localDateOf } from "@/lib/dates/school-time";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { parseProduct, type PublicProduct } from "@/modules/catalog/model";
import {
  MAX_OVERRIDE_ITEMS,
  MENU_MAX_FUTURE_DAYS,
  menuCommandSchema,
  overrideId,
  parseDefaultRule,
  parseOverride,
  type MenuCommand,
  type MenuOverride,
  type OverrideItem,
} from "./model";

/**
 * Cardápio (F07). Documentos escritos só pelo servidor, em transação idempotente com auditoria (`menu.manage`, só
 * administração):
 *  - `defaultMenuRules/{productId}`: turnos do cardápio padrão do produto (`shiftIds`) e `version`;
 *  - `menuOverrides/{data}__{turno}`: exceções da data/turno (`items` por produto, `suspended`) e `version`.
 * Toda alteração vale para NOVAS compras: pedidos já pagos guardam o próprio snapshot e não são cancelados nem
 * alterados aqui; mostrar os pedidos afetados e decidir explicitamente é da etapa de pedidos (F11).
 */
export const DEFAULT_MENU_RULES = "defaultMenuRules";
export const MENU_OVERRIDES = "menuOverrides";

export const ruleRef = (db: Firestore, productId: string) => db.doc(`${DEFAULT_MENU_RULES}/${productId}`);
export const overrideRef = (db: Firestore, date: string, shiftId: string) => db.doc(`${MENU_OVERRIDES}/${overrideId(date, shiftId)}`);

const allowMenu = (profile: { role: Actor["role"]; permissions: readonly string[] }) => can(profile, "menu.manage");

export type MenuResult = { id: string; changed: boolean; version: number };

export async function changeMenu(db: Firestore, actor: Actor, raw: unknown, now: Date = new Date()): Promise<MenuResult & { replayed: boolean }> {
  authorize(actor, "menu.manage");
  const input = menuCommandSchema.parse(raw);
  if (input.action !== "setDefault") {
    // Data passada não muda (o que valeu naquele dia fica como estava); horizonte igual ao do calendário.
    const today = localDateOf(now);
    if (input.date < today) throw invalid("past_date", "Não é possível alterar o cardápio de data passada.");
    if (input.date > addDays(today, MENU_MAX_FUTURE_DAYS)) throw invalid("too_far", "Data distante demais.");
  }
  return runIdempotentCommand(
    db,
    actor,
    { scope: `menu.${input.action}`, key: input.key, payload: input, allow: allowMenu },
    async ({ tx, actor: current, auditId }) => {
      const ctx = { actorUid: current.uid, actorRole: current.role ?? null, auditId };
      switch (input.action) {
        case "setDefault":
          return setDefault(db, tx, input, ctx);
        case "setItem":
          return setItem(db, tx, input, ctx);
        case "setService":
          return setService(db, tx, input, ctx);
      }
    },
  );
}

type Ctx = { actorUid: string; actorRole: NonNullable<Actor["role"]> | null; auditId: string };

const productOf = (snap: DocumentSnapshot | undefined): PublicProduct | null => (snap?.exists ? parseProduct(snap.id, snap.data()) : null);
const activeShift = (snap: DocumentSnapshot | undefined) => Boolean(snap?.exists && snap.get("status") === "active");

async function setDefault(db: Firestore, tx: Transaction, input: Extract<MenuCommand, { action: "setDefault" }>, ctx: Ctx): Promise<MenuResult> {
  const [ruleSnap, productSnap, ...shiftSnaps] = await tx.getAll(
    ruleRef(db, input.productId),
    db.doc(`products/${input.productId}`),
    ...input.shiftIds.map((id) => db.doc(`shifts/${id}`)),
  );
  const product = productOf(productSnap);
  if (!product) throw notFound("product_not_found", "Produto inexistente.");
  const before = parseDefaultRule(input.productId, ruleSnap?.data());
  if (before.version !== input.expectedVersion) throw conflict("stale_menu", "O cardápio mudou desde que foi aberto.");
  if (input.shiftIds.length > 0) {
    if (product.status !== "active") throw invalid("product_inactive", "Produto desativado não entra no cardápio.");
    if (input.shiftIds.some((id) => !product.shiftIds.includes(id))) throw invalid("shift_not_allowed", "O produto não é vendido neste turno.");
    if (!shiftSnaps.every(activeShift)) throw invalid("shift_unavailable", "Turno inexistente ou arquivado.");
  }
  if (before.shiftIds.join(",") === input.shiftIds.join(",")) return { id: input.productId, changed: false, version: before.version };

  const version = before.version + 1;
  tx.set(ruleRef(db, input.productId), {
    productId: input.productId,
    shiftIds: input.shiftIds,
    version,
    updatedBy: ctx.actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  auditInTransaction(db, tx, ctx.auditId, {
    action: "menu.default.set",
    actorUid: ctx.actorUid,
    actorRole: ctx.actorRole,
    target: { type: "defaultMenuRule", id: input.productId },
    before: { shiftIds: before.shiftIds, version: before.version },
    after: { shiftIds: input.shiftIds, version, appliesTo: "new_orders_only" },
  });
  return { id: input.productId, changed: true, version };
}

function writeOverride(db: Firestore, tx: Transaction, next: MenuOverride, actorUid: string): void {
  tx.set(overrideRef(db, next.date, next.shiftId), {
    date: next.date,
    shiftId: next.shiftId,
    suspended: next.suspended,
    serviceReason: next.serviceReason,
    items: next.items,
    version: next.version,
    updatedBy: actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

const sameItem = (a: OverrideItem | null, b: OverrideItem | null) =>
  a === b || (a !== null && b !== null && a.include === b.include && a.limit === b.limit && a.reason === b.reason);

async function setItem(db: Firestore, tx: Transaction, input: Extract<MenuCommand, { action: "setItem" }>, ctx: Ctx): Promise<MenuResult> {
  const id = overrideId(input.date, input.shiftId);
  const [snap, productSnap, ruleSnap, shiftSnap] = await tx.getAll(
    overrideRef(db, input.date, input.shiftId),
    db.doc(`products/${input.productId}`),
    ruleRef(db, input.productId),
    db.doc(`shifts/${input.shiftId}`),
  );
  if (!activeShift(shiftSnap)) throw invalid("shift_unavailable", "Turno inexistente ou arquivado.");
  const product = productOf(productSnap);
  if (!product) throw notFound("product_not_found", "Produto inexistente.");
  const before = parseOverride(input.date, input.shiftId, snap?.data());
  if (before.version !== input.expectedVersion) throw conflict("stale_menu", "O cardápio desta data mudou desde que foi aberto.");
  const inDefault = parseDefaultRule(input.productId, ruleSnap?.data()).shiftIds.includes(input.shiftId);

  if (input.include === "extra") {
    if (product.status !== "active") throw invalid("product_inactive", "Produto desativado não entra no cardápio.");
    if (!product.shiftIds.includes(input.shiftId)) throw invalid("shift_not_allowed", "O produto não é vendido neste turno.");
    if (inDefault) throw conflict("already_in_default", "O produto já faz parte do cardápio padrão deste turno.");
  } else if (input.include === "hidden" || input.limit !== null) {
    if (!inDefault) throw invalid("not_in_default", "O produto não faz parte do cardápio padrão deste turno.");
    if (input.limit !== null && product.status !== "active") throw invalid("product_inactive", "Produto desativado não entra no cardápio.");
  }

  const previous = before.items[input.productId] ?? null;
  const next: OverrideItem | null =
    input.include === "default" && input.limit === null
      ? null
      : { include: input.include === "default" ? null : input.include, limit: input.limit, reason: input.reason };
  if (sameItem(previous, next)) return { id, changed: false, version: before.version };

  const items = { ...before.items };
  if (next) items[input.productId] = next;
  else delete items[input.productId];
  if (Object.keys(items).length > MAX_OVERRIDE_ITEMS) throw invalid("too_many_items", "Exceções demais nesta data e turno.");

  const version = before.version + 1;
  writeOverride(db, tx, { ...before, items, version }, ctx.actorUid);
  auditInTransaction(db, tx, ctx.auditId, {
    action: "menu.item.set",
    actorUid: ctx.actorUid,
    actorRole: ctx.actorRole,
    target: { type: "menuDay", id },
    reason: input.reason || undefined,
    before: { productId: input.productId, include: previous?.include ?? null, limit: previous?.limit ?? null, version: before.version },
    after: { productId: input.productId, include: next?.include ?? null, limit: next?.limit ?? null, version, appliesTo: "new_orders_only" },
  });
  return { id, changed: true, version };
}

async function setService(db: Firestore, tx: Transaction, input: Extract<MenuCommand, { action: "setService" }>, ctx: Ctx): Promise<MenuResult> {
  const id = overrideId(input.date, input.shiftId);
  const [snap, shiftSnap] = await tx.getAll(overrideRef(db, input.date, input.shiftId), db.doc(`shifts/${input.shiftId}`));
  if (!activeShift(shiftSnap)) throw invalid("shift_unavailable", "Turno inexistente ou arquivado.");
  const before = parseOverride(input.date, input.shiftId, snap?.data());
  if (before.version !== input.expectedVersion) throw conflict("stale_menu", "O cardápio desta data mudou desde que foi aberto.");
  const serviceReason = input.suspended ? input.reason : "";
  if (before.suspended === input.suspended && before.serviceReason === serviceReason) return { id, changed: false, version: before.version };

  const version = before.version + 1;
  writeOverride(db, tx, { ...before, suspended: input.suspended, serviceReason, version }, ctx.actorUid);
  auditInTransaction(db, tx, ctx.auditId, {
    action: input.suspended ? "menu.service.suspend" : "menu.service.resume",
    actorUid: ctx.actorUid,
    actorRole: ctx.actorRole,
    target: { type: "menuDay", id },
    reason: input.reason || undefined,
    before: { suspended: before.suspended, version: before.version },
    after: { suspended: input.suspended, version, appliesTo: "new_orders_only" },
  });
  return { id, changed: true, version };
}
