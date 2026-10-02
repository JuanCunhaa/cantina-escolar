import type { Firestore } from "firebase-admin/firestore";
import type { ObjectStore } from "@/lib/storage/types";
import { PHOTO_KEY_PATTERN } from "@/lib/validation/photo";

export const PHOTO_PREFIX = "products/";
/** Carência: um envio em andamento (objeto gravado, produto ainda não atualizado) nunca é tratado como órfão. */
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

export type SweepResult = { scanned: number; referenced: number; orphans: string[]; deleted: string[]; failed: string[] };

/**
 * Remove objetos de foto sem referência no Firestore (resíduo de envios interrompidos ou de limpeza que falhou).
 * Ordem importa: lista o bucket ANTES de ler as referências — um objeto confirmado entre as duas leituras aparece
 * como referenciado, e um ainda não confirmado é protegido pela carência. Dry-run por padrão.
 * Toda coleção que passar a apontar para fotos precisa entrar em `referencedPhotoKeys` (hoje só `products`, F06).
 */
export async function sweepOrphanPhotos(
  deps: { db: Firestore; store: ObjectStore },
  options: { apply?: boolean; graceMs?: number; now?: Date } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const listed = [];
  for await (const object of deps.store.list(PHOTO_PREFIX)) listed.push(object);

  const referenced = await referencedPhotoKeys(deps.db);
  const orphans = listed
    .filter((o) => PHOTO_KEY_PATTERN.test(o.key) && !referenced.has(o.key))
    .filter((o) => o.lastModified !== null && now.getTime() - o.lastModified.getTime() >= graceMs)
    .map((o) => o.key);

  const result: SweepResult = { scanned: listed.length, referenced: referenced.size, orphans, deleted: [], failed: [] };
  if (!options.apply) return result;
  for (const key of orphans) {
    try {
      await deps.store.delete(key);
      result.deleted.push(key);
    } catch {
      result.failed.push(key);
    }
  }
  return result;
}

/** Todas as chaves de foto hoje referenciadas por documentos. */
export async function referencedPhotoKeys(db: Firestore): Promise<Set<string>> {
  const keys = new Set<string>();
  const snap = await db.collection("products").select("photoPath").get();
  for (const doc of snap.docs) {
    const value = doc.get("photoPath");
    if (typeof value === "string") keys.add(value);
  }
  return keys;
}
