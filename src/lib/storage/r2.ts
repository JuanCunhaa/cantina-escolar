// Cloudflare R2 pela API S3-compatível. Operações usadas (todas documentadas como suportadas pelo R2, verificado em
// 01/10/2026 em developers.cloudflare.com/r2/api/s3/api): PutObject com If-None-Match, HeadObject, GetObject,
// DeleteObject e ListObjectsV2. Nada de URLs assinadas, multipart, ACL ou tagging.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { assertObjectKey, ObjectExistsError, StorageUnavailableError, type ObjectInfo, type ObjectStore, type StoredObject } from "./types.ts";

export type R2Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** Superfície mínima do S3Client usada aqui; permite um double determinístico nos testes locais. */
export type S3Sender = { send(command: unknown): Promise<unknown> };

type Failure = { name?: string; $metadata?: { httpStatusCode?: number } };
const statusOf = (error: unknown): number | undefined => (error as Failure).$metadata?.httpStatusCode;
const nameOf = (error: unknown): string | undefined => (error as Failure).name;

function unavailable(operation: string, error: unknown): StorageUnavailableError {
  // Só operação + nome/status do erro: a mensagem do SDK pode incluir endpoint/chave.
  return new StorageUnavailableError(`R2 ${operation} falhou (${nameOf(error) ?? "erro"}, ${statusOf(error) ?? "sem status"}).`);
}

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto", // exigido pelo SDK, ignorado pelo R2
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // SDK >= 3.729 calcula checksums CRC32 por padrão, o que o R2 rejeitou; só calcular quando obrigatório.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export function createR2Store(config: R2Config, client: S3Sender = createR2Client(config)): ObjectStore {
  const Bucket = config.bucket;
  const send = client.send.bind(client) as (command: unknown) => Promise<Record<string, unknown>>;

  const toInfo = (key: string, out: Record<string, unknown>): ObjectInfo => ({
    key,
    size: Number(out.ContentLength ?? 0),
    contentType: typeof out.ContentType === "string" ? out.ContentType : null,
    etag: typeof out.ETag === "string" ? out.ETag : null,
    lastModified: out.LastModified instanceof Date ? out.LastModified : null,
  });

  return {
    async putIfAbsent(key, body, options) {
      assertObjectKey(key);
      try {
        const out = await send(
          new PutObjectCommand({
            Bucket,
            Key: key,
            Body: body,
            ContentType: options.contentType,
            ContentLength: body.byteLength,
            Metadata: options.metadata,
            IfNoneMatch: "*", // nunca sobrescreve: 412 se a chave existir
          }),
        );
        return { etag: typeof out.ETag === "string" ? out.ETag : null };
      } catch (error) {
        if (statusOf(error) === 412 || nameOf(error) === "PreconditionFailed") throw new ObjectExistsError(key);
        throw unavailable("PutObject", error);
      }
    },
    async head(key) {
      assertObjectKey(key);
      try {
        return toInfo(key, await send(new HeadObjectCommand({ Bucket, Key: key })));
      } catch (error) {
        if (statusOf(error) === 404 || nameOf(error) === "NotFound" || nameOf(error) === "NoSuchKey") return null;
        throw unavailable("HeadObject", error);
      }
    },
    async get(key): Promise<StoredObject | null> {
      assertObjectKey(key);
      try {
        const out = await send(new GetObjectCommand({ Bucket, Key: key }));
        const body = out.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined;
        if (!body) return null;
        const bytes = await body.transformToByteArray();
        return { ...toInfo(key, { ...out, ContentLength: bytes.byteLength }), body: bytes };
      } catch (error) {
        if (statusOf(error) === 404 || nameOf(error) === "NoSuchKey" || nameOf(error) === "NotFound") return null;
        throw unavailable("GetObject", error);
      }
    },
    async delete(key) {
      assertObjectKey(key);
      try {
        await send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (error) {
        if (statusOf(error) === 404) return;
        throw unavailable("DeleteObject", error);
      }
    },
    async *list(prefix) {
      let token: string | undefined;
      do {
        let out: Record<string, unknown>;
        try {
          out = await send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        } catch (error) {
          throw unavailable("ListObjectsV2", error);
        }
        const contents = (out.Contents as { Key?: string; Size?: number; ETag?: string; LastModified?: Date }[] | undefined) ?? [];
        for (const item of contents) {
          if (!item.Key) continue;
          yield { key: item.Key, size: item.Size ?? 0, contentType: null, etag: item.ETag ?? null, lastModified: item.LastModified ?? null };
        }
        token = out.IsTruncated === true ? (out.NextContinuationToken as string | undefined) : undefined;
      } while (token);
    },
  };
}
