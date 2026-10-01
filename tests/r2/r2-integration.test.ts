// Integração REAL e pequena com um bucket R2 de homologação. Pulada sem credenciais (não faz parte do CI).
//
// Variáveis (somente no ambiente do shell, nunca em arquivo versionado):
//   R2_TEST_ACCOUNT_ID, R2_TEST_ACCESS_KEY_ID, R2_TEST_SECRET_ACCESS_KEY, R2_TEST_BUCKET [, R2_TEST_ENDPOINT]
// O bucket precisa ser exclusivo de homologação (nome com staging/homolog/test — validado por parseStorageConfig).
// Todos os objetos desta execução ficam sob `_it/<runId>/`; a limpeza apaga SOMENTE as chaves criadas aqui.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStorageConfig } from "@/lib/storage/config";
import { createR2Store } from "@/lib/storage/r2";
import { inspectImage } from "@/lib/storage/image";
import { ObjectExistsError, type ObjectStore } from "@/lib/storage/types";
import { makePng } from "../../scripts/lib/demo-seed.ts";

const env = process.env;
// Conta autorizada identificada pelo SHA-256 do ID (o ID em si não é versionado).
const ALLOWED_ACCOUNT_SHA256 = "963ef734e23f3415e3be27be4594f20ac912596cd25dc81ee6e786614bc30c8c";
const ALLOWED_BUCKET = "cantina-fotos-staging";
const configured = Boolean(env.R2_TEST_ACCOUNT_ID && env.R2_TEST_ACCESS_KEY_ID && env.R2_TEST_SECRET_ACCESS_KEY && env.R2_TEST_BUCKET);

describe.skipIf(!configured)("R2 real (bucket de homologação)", () => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const created = new Set<string>();
  let store: ObjectStore;
  let publicUrl = "";

  const key = (name: string) => {
    const full = `_it/${runId}/${name}`;
    created.add(full);
    return full;
  };

  beforeAll(() => {
    const config = parseStorageConfig({
      APP_ENV: "staging",
      R2_ACCOUNT_ID: env.R2_TEST_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: env.R2_TEST_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_TEST_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_TEST_BUCKET,
      R2_ENDPOINT: env.R2_TEST_ENDPOINT,
    });
    if (config.driver !== "r2") throw new Error("configuração R2 esperada");
    // Único destino autorizado desta integração: conta e bucket de homologação do projeto. Qualquer outro falha (não pula).
    if (createHash("sha256").update(config.accountId).digest("hex") !== ALLOWED_ACCOUNT_SHA256 || config.bucket !== ALLOWED_BUCKET) {
      throw new Error("Destino R2 não autorizado para esta integração (conta/bucket diferentes do permitido).");
    }
    store = createR2Store(config);
    publicUrl = `${config.endpoint}/${config.bucket}`;
  });

  afterAll(async () => {
    if (!store) return;
    for (const k of created) await store.delete(k).catch(() => undefined); // só o que esta execução criou
    const left: string[] = [];
    for await (const object of store.list(`_it/${runId}/`)) left.push(object.key);
    expect(left).toEqual([]);
  });

  it("grava sem sobrescrever (If-None-Match real), confere tamanho, tipo e MD5 e lê os mesmos bytes", async () => {
    const bytes = makePng(32, 24, [20, 140, 90]);
    const k = key("a.png");
    const { etag } = await store.putIfAbsent(k, bytes, { contentType: "image/png", metadata: { origem: "teste-r2" } });
    expect(etag?.replaceAll('"', "")).toBe(createHash("md5").update(bytes).digest("hex"));

    const head = await store.head(k);
    expect(head).toMatchObject({ key: k, size: bytes.byteLength, contentType: "image/png" });

    const got = await store.get(k);
    expect(Buffer.compare(Buffer.from(got!.body), bytes)).toBe(0);
    expect(inspectImage(got!.body, got!.contentType, 2 * 1024 * 1024).width).toBe(32);

    await expect(store.putIfAbsent(k, makePng(8, 8, [1, 1, 1]), { contentType: "image/png" })).rejects.toBeInstanceOf(ObjectExistsError);
    expect(Buffer.compare(Buffer.from((await store.get(k))!.body), bytes)).toBe(0); // intacto após a tentativa
  });

  it("objeto de 2 MB faz ida e volta; ausente vira null; delete é idempotente; list enxerga o prefixo", async () => {
    const big = Buffer.concat([makePng(8, 8, [5, 5, 5]), Buffer.alloc(2 * 1024 * 1024 - 100)]);
    const k = key("grande.bin");
    await store.putIfAbsent(k, big, { contentType: "application/octet-stream" });
    expect((await store.head(k))?.size).toBe(big.byteLength);
    expect((await store.get(k))?.body.byteLength).toBe(big.byteLength);

    const keys: string[] = [];
    for await (const object of store.list(`_it/${runId}/`)) keys.push(object.key);
    expect(keys).toContain(k);

    expect(await store.head(`_it/${runId}/nao-existe.png`)).toBeNull();
    expect(await store.get(`_it/${runId}/nao-existe.png`)).toBeNull();
    await store.delete(k);
    await store.delete(k);
    expect(await store.head(k)).toBeNull();
  });

  it("o endpoint S3 nega leitura anônima direta (o R2 responde 400 InvalidArgument/Authorization, observado em 01/10/2026)", async () => {
    // Prova só o endpoint S3. NÃO prova a ausência de acesso público por r2.dev ou domínio customizado: isso é uma
    // configuração do bucket (painel) e o token desta integração não a lê.
    const k = key("privado.png");
    const bytes = makePng(8, 8, [9, 9, 9]);
    await store.putIfAbsent(k, bytes, { contentType: "image/png" });
    const response = await fetch(`${publicUrl}/${k}`);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("content-type")).not.toBe("image/png");
    expect((await response.arrayBuffer()).byteLength).not.toBe(bytes.byteLength);
  });
});

describe.skipIf(configured)("R2 real (bucket de homologação) — pulado", () => {
  it("sem R2_TEST_*: configure um bucket de homologação (docs/status/r2-migration.md)", () => {
    expect(configured).toBe(false);
  });
});
