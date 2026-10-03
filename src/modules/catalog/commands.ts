import { FieldValue, type DocumentSnapshot, type Firestore, type Transaction } from "firebase-admin/firestore";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { unitSlug } from "@/modules/students/normalize";
import {
  categoryCommandSchema,
  evaluateSellable,
  parseProduct,
  productCommandSchema,
  type ProductCommand,
  type SaleContext,
  type Sellability,
} from "./model";

/**
 * Catálogo real (F06). Documentos:
 *  - `categories/{cat_…}`: nome único (uniquenessKeys/category_{slug}), ativa/arquivada;
 *  - `products/{prd_…}`: cadastro PÚBLICO (nome, descrição, categoria, preço em centavos, canais, turnos, modo, foto);
 *  - `products/{id}/priceHistory/v{n}`: histórico imutável de preço (uma entrada por versão de preço);
 *  - `productPrivate/{id}`: fornecedor padrão e observações internas (só administração).
 * Produto nunca é apagado: desativar bloqueia novas vendas e preserva histórico/pedidos.
 */
export const PRODUCTS = "products";
export const PRODUCT_PRIVATE = "productPrivate";
export const CATEGORIES = "categories";

const productRef = (db: Firestore, id: string) => db.doc(`${PRODUCTS}/${id}`);
const privateRef = (db: Firestore, id: string) => db.doc(`${PRODUCT_PRIVATE}/${id}`);
const historyRef = (db: Firestore, id: string, priceVersion: number) => db.doc(`${PRODUCTS}/${id}/priceHistory/v${priceVersion}`);
const uniqueRef = (db: Firestore, kind: "category" | "product", slug: string) => db.doc(`uniquenessKeys/${kind}_${slug}`);

const allowCatalog = (profile: { role: Actor["role"]; permissions: readonly string[] }) => can(profile, "catalog.manage");

function slugOf(name: string): string {
  const slug = unitSlug(name);
  if (!slug) throw invalid("invalid_name", "Nome precisa ter letras ou números.");
  return slug;
}

/* ----------------------------------------------------------------------------------------------- categorias */

export async function changeCategory(db: Firestore, actor: Actor, raw: unknown): Promise<{ id: string; changed: boolean; replayed: boolean }> {
  authorize(actor, "catalog.manage");
  const input = categoryCommandSchema.parse(raw);
  const slug = "name" in input ? slugOf(input.name) : null;
  const id = input.action === "create" ? deterministicId("cat", actor.uid, input.key) : input.id;

  return runIdempotentCommand(
    db,
    actor,
    { scope: `catalog.category.${input.action}`, key: input.key, payload: input, allow: allowCatalog },
    async ({ tx, actor: current, auditId }) => {
      const ref = db.doc(`${CATEGORIES}/${id}`);
      const [snap, newKey] = await tx.getAll(ref, ...(slug ? [uniqueRef(db, "category", slug)] : []));
      const before = snap?.exists ? (snap.data() as { name: string; nameSlug: string; status: string }) : null;
      if (input.action === "create" ? before : !before) throw input.action === "create" ? conflict("already_exists") : notFound("category_not_found");
      let inUse = false;
      if (input.action === "archive") {
        const used = await tx.get(db.collection(PRODUCTS).where("categoryId", "==", id).where("status", "==", "active").limit(1));
        inUse = !used.empty;
      }
      const oldKeyRef = before && input.action === "rename" && before.nameSlug !== slug ? uniqueRef(db, "category", before.nameSlug) : null;
      const oldKey = oldKeyRef ? await tx.get(oldKeyRef) : null;

      if (newKey?.exists && newKey.get("categoryId") !== id) throw conflict("category_name_taken", "Já existe categoria com este nome.");
      if (inUse) throw conflict("category_in_use", "Há produtos ativos nesta categoria.");

      const now = FieldValue.serverTimestamp();
      let changed = true;
      let after: { name: string; status: string };
      if (input.action === "create") {
        after = { name: input.name, status: "active" };
        tx.create(ref, { ...after, nameSlug: slug, createdAt: now, updatedAt: now });
        tx.create(newKey!.ref, { categoryId: id, createdAt: now });
      } else if (input.action === "rename") {
        changed = before!.name !== input.name;
        after = { name: input.name, status: before!.status };
        if (changed) {
          tx.update(ref, { name: input.name, nameSlug: slug, updatedAt: now });
          if (!newKey!.exists) tx.create(newKey!.ref, { categoryId: id, createdAt: now });
          if (oldKey?.exists && oldKey.get("categoryId") === id) tx.delete(oldKey.ref);
        }
      } else {
        const status = input.action === "archive" ? "archived" : "active";
        changed = before!.status !== status;
        after = { name: before!.name, status };
        if (changed) tx.update(ref, { status, updatedAt: now });
      }
      if (changed) {
        auditInTransaction(db, tx, auditId, {
          action: `catalog.category.${input.action}`,
          actorUid: current.uid,
          actorRole: current.role ?? null,
          target: { type: "category", id },
          before: before && { name: before.name, status: before.status },
          after,
        });
      }
      return { id, changed };
    },
  );
}

/* ------------------------------------------------------------------------------------------------- produtos */

type ProductDoc = {
  name: string;
  nameSlug: string;
  description: string;
  categoryId: string;
  priceCents: number;
  priceVersion: number;
  channels: string[];
  shiftIds: string[];
  availabilityMode: string;
  status: "active" | "inactive";
  version: number;
};

const publicSummary = (p: Pick<ProductDoc, "name" | "description" | "categoryId" | "channels" | "shiftIds" | "availabilityMode" | "status">) => ({
  name: p.name,
  description: p.description,
  categoryId: p.categoryId,
  channels: p.channels,
  shiftIds: p.shiftIds,
  availabilityMode: p.availabilityMode,
  status: p.status,
});

/** Categoria e turnos referenciados precisam existir e estar ativos (lidos na mesma transação). */
function assertReferences(category: DocumentSnapshot | undefined, shifts: (DocumentSnapshot | undefined)[]): void {
  if (!category?.exists || category.get("status") !== "active") throw invalid("category_unavailable", "Categoria inexistente ou arquivada.");
  if (shifts.some((s) => !s?.exists || s.get("status") !== "active")) throw invalid("shift_unavailable", "Turno inexistente ou arquivado.");
}

export type ProductResult = { id: string; changed: boolean; version: number; priceVersion: number };

export async function changeProduct(db: Firestore, actor: Actor, raw: unknown): Promise<ProductResult & { replayed: boolean }> {
  authorize(actor, "catalog.manage");
  const input = productCommandSchema.parse(raw);
  const slug = "name" in input ? slugOf(input.name) : null;
  const id = input.action === "create" ? deterministicId("prd", actor.uid, input.key) : input.id;

  return runIdempotentCommand(
    db,
    actor,
    { scope: `catalog.product.${input.action}`, key: input.key, payload: input, allow: allowCatalog },
    async ({ tx, actor: current, auditId }) => runProductCommand(db, tx, input, { id, slug, actorUid: current.uid, actorRole: current.role ?? null, auditId }),
  );
}

async function runProductCommand(
  db: Firestore,
  tx: Transaction,
  input: ProductCommand,
  ctx: { id: string; slug: string | null; actorUid: string; actorRole: NonNullable<Actor["role"]> | null; auditId: string },
): Promise<ProductResult> {
  const { id, slug } = ctx;
  const ref = productRef(db, id);
  // Todas as leituras antes de qualquer escrita.
  const refs = [ref];
  if (slug) refs.push(uniqueRef(db, "product", slug));
  const categoryId = "categoryId" in input ? input.categoryId : null;
  const shiftIds = "shiftIds" in input ? input.shiftIds : [];
  const [snap, newKey] = await tx.getAll(...refs);
  const before = snap?.exists ? (snap.data() as ProductDoc) : null;
  if (input.action === "create" ? before : !before) throw input.action === "create" ? conflict("already_exists") : notFound("product_not_found");

  // Reativar revalida as referências ATUAIS do produto (categoria e turnos podem ter sido arquivados enquanto inativo).
  const reactivating = input.action === "reactivate";
  const categoryToCheck = categoryId ?? (reactivating ? before!.categoryId : null);
  const shiftsToCheck = reactivating ? (before!.shiftIds ?? []) : shiftIds;
  const [category, ...shifts] = categoryToCheck
    ? await tx.getAll(db.doc(`${CATEGORIES}/${categoryToCheck}`), ...shiftsToCheck.map((s) => db.doc(`shifts/${s}`)))
    : [];
  const oldKeyRef = before && slug && before.nameSlug !== slug ? uniqueRef(db, "product", before.nameSlug) : null;
  const oldKey = oldKeyRef ? await tx.get(oldKeyRef) : null;
  const privateSnap = input.action === "update" ? await tx.get(privateRef(db, id)) : null;

  if (newKey?.exists && newKey.get("productId") !== id) throw conflict("product_name_taken", "Já existe produto com este nome.");
  if (categoryToCheck) assertReferences(category, shifts);

  const now = FieldValue.serverTimestamp();
  const audit = (action: string, extra: { before?: Record<string, unknown> | null; after?: Record<string, unknown>; reason?: string }) =>
    auditInTransaction(db, tx, ctx.auditId, {
      action: `catalog.product.${action}`,
      actorUid: ctx.actorUid,
      actorRole: ctx.actorRole,
      target: { type: "product", id },
      ...extra,
    });

  switch (input.action) {
    case "create": {
      const doc: ProductDoc = {
        name: input.name,
        nameSlug: slug!,
        description: input.description,
        categoryId: input.categoryId,
        priceCents: input.priceCents,
        priceVersion: 1,
        channels: input.channels,
        shiftIds: input.shiftIds,
        availabilityMode: input.availabilityMode,
        status: "active",
        version: 1,
      };
      tx.create(ref, { ...doc, photoPath: null, createdBy: ctx.actorUid, updatedBy: ctx.actorUid, createdAt: now, updatedAt: now, priceUpdatedAt: now });
      tx.create(historyRef(db, id, 1), {
        productId: id,
        priceVersion: 1,
        priceCents: input.priceCents,
        previousPriceCents: null,
        reason: "Cadastro inicial",
        changedBy: ctx.actorUid,
        effectiveAt: now,
      });
      tx.create(privateRef(db, id), { defaultSupplier: input.defaultSupplier, internalNotes: input.internalNotes, updatedBy: ctx.actorUid, updatedAt: now });
      tx.create(newKey!.ref, { productId: id, createdAt: now });
      audit("create", { after: { ...publicSummary(doc), priceCents: doc.priceCents } });
      return { id, changed: true, version: 1, priceVersion: 1 };
    }
    case "update": {
      if (before!.version !== input.expectedVersion) throw conflict("stale_product", "O produto mudou desde que foi aberto.");
      if (before!.availabilityMode !== input.availabilityMode) {
        // F10: físico ↔ planejado muda a regra de reserva/entrega; com unidades em estoque ou reservas ativas o saldo ficaria incoerente.
        const stock = await tx.get(db.doc(`stockBalances/${id}`));
        if (stock.exists && (Number(stock.get("onHand")) > 0 || Number(stock.get("reservedTotal")) > 0)) {
          throw conflict("mode_in_use", "O produto tem estoque ou reservas ativas: zere o estoque e trate as reservas antes de mudar o modo.");
        }
      }
      const next = publicSummary({ ...input, status: before!.status });
      const changedPublic = JSON.stringify(publicSummary(before!)) !== JSON.stringify(next);
      const changedPrivate =
        privateSnap?.get("defaultSupplier") !== input.defaultSupplier || privateSnap?.get("internalNotes") !== input.internalNotes;
      if (!changedPublic && !changedPrivate) return { id, changed: false, version: before!.version, priceVersion: before!.priceVersion };
      const version = changedPublic ? before!.version + 1 : before!.version;
      if (changedPublic) {
        tx.update(ref, { ...next, nameSlug: slug, version, updatedBy: ctx.actorUid, updatedAt: now });
        if (newKey && !newKey.exists) tx.create(newKey.ref, { productId: id, createdAt: now });
        if (oldKey?.exists && oldKey.get("productId") === id) tx.delete(oldKey.ref);
      }
      if (changedPrivate) {
        tx.set(privateRef(db, id), { defaultSupplier: input.defaultSupplier, internalNotes: input.internalNotes, updatedBy: ctx.actorUid, updatedAt: now }, { merge: true });
      }
      // Auditoria registra QUE os dados internos mudaram, sem copiá-los para fora do documento restrito.
      audit("update", { before: publicSummary(before!), after: { ...next, privateUpdated: changedPrivate } });
      return { id, changed: true, version, priceVersion: before!.priceVersion };
    }
    case "setPrice": {
      if (before!.priceVersion !== input.expectedPriceVersion) throw conflict("stale_price", "O preço mudou desde que foi aberto.");
      if (before!.priceCents === input.priceCents) return { id, changed: false, version: before!.version, priceVersion: before!.priceVersion };
      const priceVersion = before!.priceVersion + 1;
      const version = before!.version + 1;
      tx.update(ref, { priceCents: input.priceCents, priceVersion, version, priceUpdatedAt: now, updatedBy: ctx.actorUid, updatedAt: now });
      tx.create(historyRef(db, id, priceVersion), {
        productId: id,
        priceVersion,
        priceCents: input.priceCents,
        previousPriceCents: before!.priceCents,
        reason: input.reason,
        changedBy: ctx.actorUid,
        effectiveAt: now,
      });
      audit("price", { before: { priceCents: before!.priceCents, priceVersion: before!.priceVersion }, after: { priceCents: input.priceCents, priceVersion, appliesTo: "new_sales_only" }, reason: input.reason });
      return { id, changed: true, version, priceVersion };
    }
    case "deactivate":
    case "reactivate": {
      const status = input.action === "deactivate" ? "inactive" : "active";
      if (before!.status === status) return { id, changed: false, version: before!.version, priceVersion: before!.priceVersion };
      const version = before!.version + 1;
      tx.update(ref, {
        status,
        version,
        updatedBy: ctx.actorUid,
        updatedAt: now,
        deactivatedAt: status === "inactive" ? now : null,
      });
      // Motivo e autor são internos (podem citar fornecedor/custo): ficam no documento restrito, nunca no público.
      tx.set(
        privateRef(db, id),
        status === "inactive"
          ? { deactivationReason: input.action === "deactivate" ? input.reason : null, deactivatedBy: ctx.actorUid, updatedAt: now }
          : { deactivationReason: null, deactivatedBy: null, updatedAt: now },
        { merge: true },
      );
      audit(input.action, { before: { status: before!.status }, after: { status }, reason: input.action === "deactivate" ? input.reason : undefined });
      return { id, changed: true, version, priceVersion: before!.priceVersion };
    }
  }
}

/* ------------------------------------------------------------------------------------------ leitura de venda */

/**
 * Leitura canônica, dentro da transação do comando de venda (checkout F11 / PDV F15), dos produtos pedidos.
 * Devolve preço e versões ATUAIS do servidor; o chamador grava o snapshot do item e compara `priceVersion` com o
 * que o cliente viu para pedir revisão em vez de cobrar um valor diferente em silêncio.
 */
export async function readSellableProducts(db: Firestore, tx: Transaction, productIds: readonly string[], ctx: SaleContext): Promise<Map<string, Sellability>> {
  const ids = [...new Set(productIds)];
  const result = new Map<string, Sellability>();
  if (ids.length === 0) return result;
  const snaps = await tx.getAll(...ids.map((id) => productRef(db, id)));
  ids.forEach((id, index) => {
    const snap = snaps[index];
    result.set(id, evaluateSellable(snap?.exists ? parseProduct(id, snap.data()) : null, ctx));
  });
  return result;
}
