// Módulo de Storage — testes locais determinísticos, sem conta R2. O R2 aqui é um DOUBLE (servidor S3 mínimo em
// loopback): prova o que o SDK realmente envia (If-None-Match, sem checksum CRC32), não o comportamento do provedor.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readBodyLimited, PayloadTooLargeError } from "@/lib/storage/body";
import { parseStorageConfig } from "@/lib/storage/config";
import { inspectImage, InvalidImageError } from "@/lib/storage/image";
import { createLocalStore } from "@/lib/storage/local";
import { createR2Client, createR2Store } from "@/lib/storage/r2";
import { assertObjectKey, ObjectExistsError, StorageUnavailableError } from "@/lib/storage/types";
import { makePng } from "../../scripts/lib/demo-seed.ts";

const MAX = 2 * 1024 * 1024;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const r2Base = { R2_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: "AKIAFAKEFAKE", R2_SECRET_ACCESS_KEY: "fake-secret-fake-secret-1234" };

describe("parseStorageConfig — configuração por ambiente (fechada)", () => {
  it("emulator usa disco local, com diretório padrão ou informado, e recusa qualquer configuração R2", () => {
    expect(parseStorageConfig({ APP_ENV: "emulator" })).toEqual({ driver: "local", dir: ".local-storage" });
    expect(parseStorageConfig({ APP_ENV: "emulator", STORAGE_LOCAL_DIR: "x" })).toEqual({ driver: "local", dir: "x" });
    expect(parseStorageConfig({ APP_ENV: "emulator", R2_ACCOUNT_ID: "", R2_BUCKET: "" })).toMatchObject({ driver: "local" }); // vazio = ausente
    expect(() => parseStorageConfig({ APP_ENV: "emulator", ...r2Base })).toThrow();
    expect(() => parseStorageConfig({ APP_ENV: "emulator", R2_BUCKET: "cantina-staging" })).toThrow();
  });

  it("staging e production exigem R2 completo e recusam armazenamento local", () => {
    for (const env of ["staging", "production"]) {
      expect(() => parseStorageConfig({ APP_ENV: env })).toThrow();
      expect(() => parseStorageConfig({ APP_ENV: env, ...r2Base })).toThrow(); // sem bucket
      expect(() => parseStorageConfig({ APP_ENV: env, ...r2Base, R2_BUCKET: "cantina-fotos", STORAGE_LOCAL_DIR: "x" })).toThrow();
    }
  });

  it("staging só aceita bucket de homologação/teste; production recusa-o (sem compartilhar bucket)", () => {
    const staging = parseStorageConfig({ APP_ENV: "staging", ...r2Base, R2_BUCKET: "cantina-fotos-staging" });
    expect(staging).toMatchObject({ driver: "r2", bucket: "cantina-fotos-staging", endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com` });
    expect(() => parseStorageConfig({ APP_ENV: "staging", ...r2Base, R2_BUCKET: "cantina-fotos" })).toThrow();
    expect(parseStorageConfig({ APP_ENV: "production", ...r2Base, R2_BUCKET: "cantina-fotos" })).toMatchObject({ driver: "r2" });
    expect(() => parseStorageConfig({ APP_ENV: "production", ...r2Base, R2_BUCKET: "cantina-fotos-staging" })).toThrow();
  });

  it("valida formato de conta, bucket e endpoint (somente https *.r2.cloudflarestorage.com)", () => {
    const ok = { APP_ENV: "staging", ...r2Base, R2_BUCKET: "cantina-staging" };
    expect(() => parseStorageConfig({ ...ok, R2_ACCOUNT_ID: "nao-hex" })).toThrow();
    expect(() => parseStorageConfig({ ...ok, R2_BUCKET: "Bucket_Maiusculo" })).toThrow();
    expect(parseStorageConfig({ ...ok, R2_ENDPOINT: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com` })).toMatchObject({ endpoint: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com` });
    for (const endpoint of ["http://x.r2.cloudflarestorage.com", "https://evil.example.com", "https://x.r2.cloudflarestorage.com/bucket", "https://x.r2.cloudflarestorage.com.evil.test"]) {
      expect(() => parseStorageConfig({ ...ok, R2_ENDPOINT: endpoint })).toThrow();
    }
  });

  it("mensagens de erro não vazam o segredo", () => {
    try {
      parseStorageConfig({ APP_ENV: "staging", ...r2Base, R2_BUCKET: "cantina-fotos" });
    } catch (error) {
      expect(String(error)).not.toContain(r2Base.R2_SECRET_ACCESS_KEY);
    }
  });
});

describe("assertObjectKey", () => {
  it("aceita chaves simples e recusa travessia, barra inicial, vazio e caracteres estranhos", () => {
    expect(() => assertObjectKey("products/demo-suco/abc.png")).not.toThrow();
    for (const bad of ["", "/a", "a//b", "../a", "a/../b", "a/./b", "a/b..", "a b", "a\\b", "a?x=1", "a%2e%2e/b", ".hidden"]) {
      expect(() => assertObjectKey(bad), bad).toThrow();
    }
  });
});

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webp(kind: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): Buffer {
  const body = Buffer.alloc(30);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(22, 4);
  body.write("WEBP", 8, "ascii");
  body.write(kind, 12, "ascii");
  body.writeUInt32LE(10, 16);
  if (kind === "VP8X") {
    body.writeUIntLE(width - 1, 24, 3);
    body.writeUIntLE(height - 1, 27, 3);
  } else if (kind === "VP8L") {
    body[20] = 0x2f;
    body.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  } else {
    body.set([0x9d, 0x01, 0x2a], 23);
    body.writeUInt16LE(width, 26);
    body.writeUInt16LE(height, 28);
  }
  return body;
}

describe("inspectImage — bytes, tipo declarado e limites", () => {
  it("aceita PNG, JPEG e WebP (VP8, VP8L, VP8X) coerentes com o tipo declarado e lê as dimensões", () => {
    expect(inspectImage(makePng(16, 8, [1, 2, 3]), "image/png", MAX)).toMatchObject({ extension: "png", width: 16, height: 8 });
    expect(inspectImage(jpeg(40, 30), "image/jpeg", MAX)).toMatchObject({ extension: "jpg", width: 40, height: 30 });
    for (const kind of ["VP8X", "VP8L", "VP8 "] as const) {
      expect(inspectImage(webp(kind, 64, 48), "image/webp", MAX), kind).toMatchObject({ extension: "webp", width: 64, height: 48 });
    }
  });

  it("recusa tipo declarado fora da lista, vazio, acima do limite e tipo divergente do conteúdo", () => {
    const png = makePng(8, 8, [1, 2, 3]);
    for (const type of ["image/svg+xml", "image/gif", "text/html", "application/octet-stream", "", null, undefined]) {
      expect(() => inspectImage(png, type, MAX)).toThrow(InvalidImageError);
    }
    expect(() => inspectImage(new Uint8Array(0), "image/png", MAX)).toThrow(InvalidImageError);
    expect(() => inspectImage(png, "image/png", png.byteLength - 1)).toThrow(InvalidImageError);
    expect(() => inspectImage(png, "image/png", png.byteLength)).not.toThrow(); // limite exato é aceito
    expect(() => inspectImage(png, "image/jpeg", MAX)).toThrow(InvalidImageError);
    expect(() => inspectImage(jpeg(8, 8), "image/png", MAX)).toThrow(InvalidImageError);
    expect(() => inspectImage(webp("VP8X", 8, 8), "image/png", MAX)).toThrow(InvalidImageError);
  });

  it("recusa SVG/HTML/script disfarçados, arquivo truncado e cabeçalhos inconsistentes", () => {
    for (const text of ["<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "<html><script>1</script></html>", "GIF89a"]) {
      for (const type of ["image/png", "image/jpeg", "image/webp"]) expect(() => inspectImage(Buffer.from(text), type, MAX)).toThrow(InvalidImageError);
    }
    const png = makePng(8, 8, [1, 2, 3]);
    expect(() => inspectImage(png.subarray(0, png.length - 12), "image/png", MAX)).toThrow(InvalidImageError); // sem IEND
    expect(() => inspectImage(png.subarray(0, 20), "image/png", MAX)).toThrow(InvalidImageError);
    expect(() => inspectImage(jpeg(8, 8).subarray(0, 12), "image/jpeg", MAX)).toThrow(InvalidImageError);
    const truncatedWebp = webp("VP8X", 8, 8);
    truncatedWebp.writeUInt32LE(5000, 4);
    expect(() => inspectImage(truncatedWebp, "image/webp", MAX)).toThrow(InvalidImageError);
  });

  it("recusa dimensões zeradas ou acima de 8192", () => {
    expect(() => inspectImage(jpeg(0, 10), "image/jpeg", MAX)).toThrow(InvalidImageError);
    expect(() => inspectImage(webp("VP8X", 8193, 10), "image/webp", MAX)).toThrow(InvalidImageError);
    expect(() => inspectImage(webp("VP8X", 8192, 8192), "image/webp", MAX)).not.toThrow();
  });
});

describe("readBodyLimited — corpo com teto de bytes", () => {
  const request = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request("http://localhost/x", { method: "POST", body, headers, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);

  it("lê corpo dentro do limite (inclusive exatamente o limite) e corpo vazio", async () => {
    expect((await readBodyLimited(request(new Uint8Array(100)), 100)).byteLength).toBe(100);
    expect((await readBodyLimited(request(null), 100)).byteLength).toBe(0);
  });

  it("recusa pelo Content-Length declarado sem ler o corpo", async () => {
    await expect(readBodyLimited(request(new Uint8Array(101)), 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(readBodyLimited(request("x", { "content-length": "999" }), 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("interrompe corpo em stream (sem Content-Length) assim que ultrapassa o limite", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(60));
        if (pulled > 50) controller.close();
      },
    });
    await expect(readBodyLimited(request(stream), 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(pulled).toBeLessThan(10); // não consumiu o stream inteiro
  });
});

describe("armazenamento local (double de emulator)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cantina-local-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("cria sem sobrescrever, lê metadados e bytes, lista por prefixo e apaga de forma idempotente", async () => {
    const store = createLocalStore(dir);
    const key = "products/p1/0123456789abcdef0123456789abcdef.png";
    const { etag } = await store.putIfAbsent(key, Buffer.from("um"), { contentType: "image/png" });
    await expect(store.putIfAbsent(key, Buffer.from("dois"), { contentType: "image/png" })).rejects.toBeInstanceOf(ObjectExistsError);
    const got = await store.get(key);
    expect(Buffer.from(got!.body).toString()).toBe("um");
    expect(got).toMatchObject({ size: 2, contentType: "image/png", etag });
    expect(await store.head("products/p1/nao-existe.png")).toBeNull();
    await store.putIfAbsent("other/x.png", Buffer.from("x"), { contentType: "image/png" });
    const listed: string[] = [];
    for await (const object of store.list("products/")) listed.push(object.key);
    expect(listed).toEqual([key]);
    await store.delete(key);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });

  it("recusa chaves com travessia antes de tocar o disco", async () => {
    const store = createLocalStore(dir);
    await expect(store.putIfAbsent("../fora.png", Buffer.from("x"), { contentType: "image/png" })).rejects.toThrow();
    await expect(store.get("a/../../fora")).rejects.toThrow();
  });
});

// ---- R2 com servidor S3 duplo em loopback (valida o que o SDK real envia) ----

type Seen = { method: string; url: string; headers: IncomingMessage["headers"] };
let server: Server;
let endpoint = "";
const seen: Seen[] = [];
const objects = new Map<string, { body: Buffer; type: string }>();
let failures: { status: number; remaining: number } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      const url = new URL(req.url ?? "/", "http://x");
      const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/")); // /{bucket}/{key}
      const xml = (status: number, code: string) => {
        res.writeHead(status, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
      };
      if (failures && failures.remaining > 0) {
        failures.remaining -= 1;
        return xml(failures.status, "InternalError");
      }
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && objects.has(key)) return xml(412, "PreconditionFailed");
        objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers["content-type"]) });
        res.writeHead(200, { etag: '"d41d8cd98f00b204e9800998ecf8427e"' });
        return res.end();
      }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const token = url.searchParams.get("continuation-token");
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = token ? Number(token) : 0;
        const page = all.slice(start, start + 2);
        const truncated = start + 2 < all.length;
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}` +
            page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.body.length}</Size><LastModified>2026-10-01T00:00:00.000Z</LastModified><ETag>"e"</ETag></Contents>`).join("") +
            "</ListBucketResult>",
        );
      }
      const found = objects.get(key);
      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      if (!found) {
        if (req.method === "HEAD") {
          res.writeHead(404);
          return res.end();
        }
        return xml(404, "NoSuchKey");
      }
      res.writeHead(200, { "content-type": found.type, "content-length": found.body.length, etag: '"e"', "last-modified": "Thu, 01 Oct 2026 00:00:00 GMT" });
      res.end(req.method === "HEAD" ? undefined : found.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("R2 store — SDK S3 real contra servidor S3 duplo (não prova o provedor)", () => {
  const config = () => ({ endpoint, bucket: "bucket-teste", accessKeyId: "AKIAFAKEFAKE", secretAccessKey: "fake-secret-fake-secret-1234" });

  it("cliente: região auto e checksums só quando obrigatórios (compatibilidade documentada com o R2)", async () => {
    const client = createR2Client(config());
    expect(await client.config.region()).toBe("auto");
    expect(await client.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    expect(await client.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
  });

  it("PutObject envia If-None-Match: *, tipo e metadados, sem checksum CRC32, assinado e no bucket certo", async () => {
    seen.length = 0;
    const store = createR2Store(config());
    await store.putIfAbsent("products/p1/aaaa.png", Buffer.from("abc"), { contentType: "image/png", metadata: { product: "p1" } });
    const put = seen.find((s) => s.method === "PUT")!;
    expect(put.url.startsWith("/bucket-teste/products/p1/aaaa.png")).toBe(true);
    expect(put.headers["if-none-match"]).toBe("*");
    expect(put.headers["content-type"]).toBe("image/png");
    expect(put.headers["x-amz-meta-product"]).toBe("p1");
    expect(put.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKEFAKE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(Object.keys(put.headers).filter((h) => h.startsWith("x-amz-checksum") || h === "x-amz-sdk-checksum-algorithm")).toEqual([]);
  });

  it("segunda gravação na mesma chave vira ObjectExistsError (412) e não altera o objeto", async () => {
    const store = createR2Store(config());
    await store.putIfAbsent("products/p2/bbbb.png", Buffer.from("original"), { contentType: "image/png" });
    await expect(store.putIfAbsent("products/p2/bbbb.png", Buffer.from("novo"), { contentType: "image/png" })).rejects.toBeInstanceOf(ObjectExistsError);
    expect(Buffer.from((await store.get("products/p2/bbbb.png"))!.body).toString()).toBe("original");
  });

  it("head/get/delete: ausente = null, delete idempotente, tamanho e tipo lidos", async () => {
    const store = createR2Store(config());
    await store.putIfAbsent("products/p3/cccc.webp", Buffer.from("12345"), { contentType: "image/webp" });
    expect(await store.head("products/p3/cccc.webp")).toMatchObject({ size: 5, contentType: "image/webp" });
    expect(await store.head("products/p3/nada.png")).toBeNull();
    expect(await store.get("products/p3/nada.png")).toBeNull();
    await store.delete("products/p3/cccc.webp");
    await store.delete("products/p3/cccc.webp");
    expect(await store.head("products/p3/cccc.webp")).toBeNull();
  });

  it("list percorre todas as páginas do prefixo", async () => {
    const store = createR2Store(config());
    for (const n of [1, 2, 3, 4, 5]) await store.putIfAbsent(`lista/p/${n}.png`, Buffer.from("x"), { contentType: "image/png" });
    const keys: string[] = [];
    for await (const object of store.list("lista/")) keys.push(object.key);
    expect(keys).toEqual([1, 2, 3, 4, 5].map((n) => `lista/p/${n}.png`));
  });

  it("falha do provedor vira StorageUnavailableError sem vazar endpoint ou chave", async () => {
    const store = createR2Store(config());
    // O SDK repete 5xx (3 tentativas por padrão): o double falha em todas.
    failures = { status: 500, remaining: 99 };
    const error = await store.putIfAbsent("products/p4/dddd.png", Buffer.from("x"), { contentType: "image/png" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect(String((error as Error).message)).not.toMatch(/AKIA|fake-secret|127\.0\.0\.1|bucket-teste/);
    failures = { status: 503, remaining: 99 };
    await expect(store.head("products/p4/dddd.png")).rejects.toBeInstanceOf(StorageUnavailableError);
    failures = { status: 500, remaining: 99 };
    await expect(store.delete("products/p4/dddd.png")).rejects.toBeInstanceOf(StorageUnavailableError);
    failures = null;
  });

  it("recusa chaves inválidas antes de qualquer chamada de rede", async () => {
    seen.length = 0;
    const store = createR2Store(config());
    await expect(store.get("../segredo")).rejects.toThrow();
    await expect(store.putIfAbsent("/abs", Buffer.from("x"), { contentType: "image/png" })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
