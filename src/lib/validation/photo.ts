export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

const EXTENSION_BY_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
export type PhotoType = keyof typeof EXTENSION_BY_TYPE;

export const PHOTO_ACCEPT = Object.keys(EXTENSION_BY_TYPE).join(",");

export type PhotoCheck = { ok: true; type: PhotoType; extension: string } | { ok: false; message: string };

/** Validação de tipo/tamanho para dar retorno rápido na UI; o limite real é imposto por Storage Rules e pelo servidor. */
export function validatePhoto(file: { type: string; size: number }): PhotoCheck {
  if (!(file.type in EXTENSION_BY_TYPE)) return { ok: false, message: "Use uma imagem JPEG, PNG ou WebP." };
  if (file.size <= 0) return { ok: false, message: "O arquivo está vazio." };
  if (file.size > PHOTO_MAX_BYTES) return { ok: false, message: "A foto deve ter no máximo 2 MB." };
  const type = file.type as PhotoType;
  return { ok: true, type, extension: EXTENSION_BY_TYPE[type] };
}

export const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const PHOTO_PATH_PATTERN = /^products\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\.(jpg|png|webp)$/;

export function productPhotoPath(productId: string, name: string, extension: string): string {
  return `products/${productId}/${name}.${extension}`;
}
