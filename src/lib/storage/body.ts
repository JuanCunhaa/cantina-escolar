export class PayloadTooLargeError extends Error {}

/**
 * Lê o corpo da requisição com teto de bytes: recusa pelo Content-Length declarado e, como o cabeçalho pode mentir ou
 * faltar (chunked), interrompe a leitura assim que o total passa do limite. Nunca bufferiza além de `limit` + 1 bloco.
 */
export async function readBodyLimited(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) throw new PayloadTooLargeError("Corpo acima do limite.");
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError("Corpo acima do limite.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
