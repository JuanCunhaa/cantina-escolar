import { createHash, randomUUID } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { COMMAND_TRANSACTION } from "@/lib/firebase/transaction-options";
import { IMAGE_EXTENSION, inspectImage, InvalidImageError, isImageType, type ImageType } from "@/lib/storage/image";
import { StorageUnavailableError, type ObjectStore } from "@/lib/storage/types";
import { PHOTO_KEY_PATTERN, PHOTO_MAX_BYTES, PRODUCT_ID_PATTERN } from "@/lib/validation/photo";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { parseProfile } from "@/modules/access/profile";

export class PhotoRejectedError extends Error {}
export class ProductNotFoundError extends Error {}
export class PhotoUnavailableError extends Error {}

export type PhotoDeps = { db: Firestore; store: ObjectStore };

const productIdSchema = z.string().regex(PRODUCT_ID_PATTERN);
const CONTENT_TYPE_BY_EXTENSION: Record<string, ImageType> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

const productRef = (db: Firestore, productId: string) => db.doc(`demoProducts/${productId}`);

/** Falha de limpeza nunca derruba a operação já confirmada: vira objeto órfão, tratado por sweepOrphanPhotos. */
async function bestEffortDelete(store: ObjectStore, key: string, why: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (error) {
    console.error("photo cleanup failed (%s)", why, error instanceof Error ? error.name : "unknown");
  }
}

/** Chave anterior só é removível se for uma foto deste mesmo produto no formato esperado. */
function ownedKey(key: unknown, productId: string): string | null {
  if (typeof key !== "string") return null;
  const match = PHOTO_KEY_PATTERN.exec(key);
  return match?.[1] === productId ? key : null;
}

/**
 * Substitui a foto de um produto. O cliente envia apenas bytes e o tipo declarado; o servidor:
 *  1. autentica/autoriza (catalog.photos.manage) e valida produto e tipo ANTES de ler o corpo;
 *  2. lê o corpo com teto de 2 MB e inspeciona os bytes (assinatura, estrutura, dimensões) contra o tipo declarado;
 *  3. gera a chave (nunca vem do cliente) e grava no bucket privado sem sobrescrever (If-None-Match), conferindo o objeto;
 *  4. numa transação do Firestore, relê o perfil ATUAL do ator e só então aponta o produto para a nova chave;
 *  5. somente depois do commit remove a foto anterior (falha vira órfão para o sweep).
 * R2 e Firestore não compartilham transação: antes do commit nada referencia o objeto novo (um crash deixa só um
 * órfão), e se o resultado do commit for incerto o objeto é mantido em vez de arriscar uma referência quebrada.
 */
export async function uploadProductPhoto(
  deps: PhotoDeps,
  actor: Actor,
  input: { productId: unknown; declaredType: string | null; readBody: (limit: number) => Promise<Uint8Array> },
): Promise<{ productId: string; photoPath: string }> {
  authorize(actor, "catalog.photos.manage");
  const productId = productIdSchema.parse(input.productId);
  if (!isImageType(input.declaredType)) throw new PhotoRejectedError("Tipo de arquivo não aceito.");
  if (!(await productRef(deps.db, productId).get()).exists) throw new ProductNotFoundError(productId);

  const bytes = await input.readBody(PHOTO_MAX_BYTES);
  let image;
  try {
    image = inspectImage(bytes, input.declaredType, PHOTO_MAX_BYTES);
  } catch (error) {
    if (error instanceof InvalidImageError) throw new PhotoRejectedError(error.message);
    throw error;
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const md5 = createHash("md5").update(bytes).digest("hex");
  const key = `products/${productId}/${randomUUID().replaceAll("-", "")}.${IMAGE_EXTENSION[image.type]}`;

  await deps.store.putIfAbsent(key, bytes, { contentType: image.type, metadata: { product: productId, uploader: actor.uid, sha256 } });

  // Confirma que o objeto existe e é o que enviamos antes de registrar qualquer referência.
  let head;
  try {
    head = await deps.store.head(key);
  } catch (error) {
    await bestEffortDelete(deps.store, key, "head");
    throw error;
  }
  const etag = head?.etag?.replaceAll('"', "") ?? "";
  const confirmed =
    head !== null && head.size === bytes.byteLength && head.contentType === image.type && (!/^[0-9a-f]{32}$/.test(etag) || etag === md5);
  if (!confirmed) {
    await bestEffortDelete(deps.store, key, "unconfirmed");
    throw new StorageUnavailableError("Objeto não confirmado após o envio.");
  }

  const ref = productRef(deps.db, productId);
  let previous: unknown;
  try {
    previous = await deps.db.runTransaction(async (tx) => {
      const [userSnap, productSnap] = await tx.getAll(deps.db.doc(`users/${actor.uid}`), ref);
      // Revalidação: o perfil pode ter mudado (rebaixado/desativado) desde a autenticação da requisição.
      const profile = parseProfile(userSnap?.data());
      if (!profile || profile.status !== "active") throw new ForbiddenError("Ator sem permissão atual.");
      authorize({ uid: actor.uid, role: profile.role, permissions: profile.permissions }, "catalog.photos.manage");
      if (!productSnap?.exists) throw new ProductNotFoundError(productId);
      tx.update(ref, {
        photoPath: key,
        photoContentType: image.type,
        photoSize: bytes.byteLength,
        photoSha256: sha256,
        photoUpdatedBy: actor.uid,
        photoUpdatedAt: FieldValue.serverTimestamp(),
      });
      return productSnap.get("photoPath");
    }, COMMAND_TRANSACTION);
  } catch (error) {
    // Negativas determinísticas não gravaram nada: o objeto novo é descartável. Qualquer outro erro pode ter
    // acontecido depois do commit; só apaga se o produto comprovadamente não aponta para a chave nova.
    if (error instanceof ForbiddenError || error instanceof ProductNotFoundError) {
      await bestEffortDelete(deps.store, key, "denied");
    } else {
      const stillReferenced = await ref.get().then((snap) => snap.get("photoPath") === key, () => true);
      if (!stillReferenced) await bestEffortDelete(deps.store, key, "commit-failed");
    }
    throw error;
  }

  const old = ownedKey(previous, productId);
  if (old && old !== key) await bestEffortDelete(deps.store, old, "previous");
  return { productId, photoPath: key };
}

export type PhotoRead = { kind: "not-modified"; etag: string } | { kind: "ok"; etag: string; contentType: ImageType; body: Uint8Array };

/**
 * Leitura autorizada: qualquer conta com perfil ativo e papel válido (mesma visibilidade que as Storage Rules tinham).
 * O cliente informa só o produto; a chave vem do Firestore. O bucket continua privado: os bytes passam por aqui.
 */
export async function readProductPhoto(deps: PhotoDeps, actor: Actor, productId: unknown, ifNoneMatch: string | null): Promise<PhotoRead> {
  if (!actor.role) throw new ForbiddenError("Conta sem perfil válido.");
  const id = productIdSchema.parse(productId);
  const snap = await productRef(deps.db, id).get();
  if (!snap.exists) throw new ProductNotFoundError(id);
  const key = ownedKey(snap.get("photoPath"), id);
  if (!key) throw new PhotoUnavailableError(id);

  // Chaves são imutáveis (nova foto = nova chave): o ETag é o próprio nome, e o 304 dispensa ler o bucket.
  const etag = `"${key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("."))}"`;
  if (ifNoneMatch !== null && ifNoneMatch.split(",").some((candidate) => candidate.trim() === etag)) return { kind: "not-modified", etag };

  const contentType = CONTENT_TYPE_BY_EXTENSION[key.slice(key.lastIndexOf(".") + 1)];
  const object = await deps.store.get(key);
  if (!contentType || !object) throw new PhotoUnavailableError(id);
  return { kind: "ok", etag, contentType, body: object.body };
}
