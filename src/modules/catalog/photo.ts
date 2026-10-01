import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { PHOTO_MAX_BYTES, PHOTO_PATH_PATTERN, PRODUCT_ID_PATTERN } from "@/lib/validation/photo";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";

export class PhotoRejectedError extends Error {}
export class ProductNotFoundError extends Error {}

export const registerPhotoSchema = z.object({
  productId: z.string().regex(PRODUCT_ID_PATTERN),
  path: z.string().regex(PHOTO_PATH_PATTERN),
});

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

function matchesSignature(type: string, head: Buffer): boolean {
  if (type === "image/jpeg") return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (type === "image/png") return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === "image/webp") return head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

/**
 * Registra no Firestore a foto já enviada ao Storage. O servidor revalida papel, caminho do produto, tipo, tamanho e
 * assinatura dos bytes antes de gravar o metadado — Storage Rules não inspecionam conteúdo. Arquivo reprovado é removido.
 */
export async function registerProductPhoto(
  deps: { db: Firestore; bucket: Bucket },
  actor: Actor,
  input: unknown,
): Promise<{ productId: string; photoPath: string }> {
  authorize(actor, "catalog.photos.manage");
  const { productId, path } = registerPhotoSchema.parse(input);
  const match = PHOTO_PATH_PATTERN.exec(path);
  if (match?.[1] !== productId) throw new PhotoRejectedError("Caminho não pertence ao produto.");
  const expectedType = CONTENT_TYPE_BY_EXTENSION[match[3] ?? ""] ?? "";

  const productRef = deps.db.doc(`demoProducts/${productId}`);
  if (!(await productRef.get()).exists) throw new ProductNotFoundError(productId);

  const file = deps.bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw new PhotoRejectedError("Arquivo não encontrado no Storage.");
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  let problem: string | null = null;
  if (metadata.contentType !== expectedType) problem = "Tipo de arquivo inesperado.";
  else if (!(size > 0 && size <= PHOTO_MAX_BYTES)) problem = "Tamanho fora do limite.";
  else {
    const [head] = await file.download({ start: 0, end: 11 });
    if (!matchesSignature(expectedType, head)) problem = "Conteúdo não corresponde a uma imagem válida.";
  }
  if (problem) {
    await file.delete({ ignoreNotFound: true });
    throw new PhotoRejectedError(problem);
  }

  await productRef.update({ photoPath: path, photoUpdatedBy: actor.uid });
  return { productId, photoPath: path };
}
