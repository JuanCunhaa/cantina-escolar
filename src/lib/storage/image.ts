// Inspeção dos bytes de uma imagem enviada: assinatura, estrutura mínima (cabeçalho com dimensões; PNG também exige
// IEND, o que pega arquivo truncado) e limites. Não decodifica pixels. O tipo declarado pelo cliente só é aceito se
// bater com o conteúdo, e o tipo/extensão gravados vêm daqui, nunca do nome do arquivo.

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

export const IMAGE_EXTENSION: Record<ImageType, "jpg" | "png" | "webp"> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const IMAGE_MAX_DIMENSION = 8192;

export class InvalidImageError extends Error {}

export type ImageInfo = { type: ImageType; extension: "jpg" | "png" | "webp"; width: number; height: number };

export function isImageType(value: string | null | undefined): value is ImageType {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

function dimensions(type: ImageType, b: Uint8Array): { width: number; height: number } | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (type === "image/png") {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 45 || !buf.subarray(0, 8).equals(signature)) return null;
    if (buf.readUInt32BE(8) !== 13 || buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
    const iend = buf.subarray(buf.length - 12);
    if (iend.readUInt32BE(0) !== 0 || iend.subarray(4, 8).toString("ascii") !== "IEND") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (type === "image/jpeg") {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
    let pos = 2;
    while (pos + 4 <= buf.length) {
      if (buf[pos] !== 0xff) return null;
      const marker = buf[pos + 1] ?? 0;
      if (marker === 0xff) {
        pos += 1; // preenchimento
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // fim/varredura antes de qualquer quadro (SOF)
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        pos += 2; // marcadores sem comprimento
        continue;
      }
      const length = buf.readUInt16BE(pos + 2);
      if (length < 2 || pos + 2 + length > buf.length) return null;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        if (length < 8) return null;
        return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
      }
      pos += 2 + length;
    }
    return null;
  }
  // WebP: RIFF <tamanho> WEBP + primeiro bloco VP8 (lossy), VP8L (lossless) ou VP8X (estendido).
  if (buf.length < 30 || buf.subarray(0, 4).toString("ascii") !== "RIFF" || buf.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  if (buf.readUInt32LE(4) + 8 > buf.length) return null; // declarado maior que o recebido: truncado
  const chunk = buf.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 ") {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/** Valida os bytes contra o tipo declarado. Lança InvalidImageError com motivo seguro para mostrar ao usuário. */
export function inspectImage(bytes: Uint8Array, declaredType: string | null | undefined, maxBytes: number): ImageInfo {
  if (!isImageType(declaredType)) throw new InvalidImageError("Use uma imagem JPEG, PNG ou WebP.");
  if (bytes.byteLength === 0) throw new InvalidImageError("O arquivo está vazio.");
  if (bytes.byteLength > maxBytes) throw new InvalidImageError("Tamanho fora do limite.");
  const found = dimensions(declaredType, bytes);
  if (!found) throw new InvalidImageError("Conteúdo não corresponde a uma imagem válida.");
  if (found.width < 1 || found.height < 1 || found.width > IMAGE_MAX_DIMENSION || found.height > IMAGE_MAX_DIMENSION) {
    throw new InvalidImageError("Dimensões da imagem fora do limite.");
  }
  return { type: declaredType, extension: IMAGE_EXTENSION[declaredType], width: found.width, height: found.height };
}
