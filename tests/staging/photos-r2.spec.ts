// Fotos pelas rotas do aplicativo com o armazenamento do alvo (R2 de staging na homologação real): upload, leitura,
// recusas sem autorização e de imagens inválidas, e prova de que o bucket não é acessível sem as credenciais do servidor.
// Usa um produto TEMPORÁRIO criado pela API (administração) e desativado no fim: os produtos "(exemplo)" não mudam.
import { expect, test } from "@playwright/test";
import { admin } from "../../scripts/staging/admin.ts";
import { makePng } from "../../scripts/lib/demo-seed.ts";
import { createObjectStore } from "../../src/lib/storage/factory.ts";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { createTempProduct, fixtureIds, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { isCloud } from "../helpers/cloud.ts";
import { bearer } from "./helpers";

test.describe.configure({ mode: "serial" });

let PRODUCT = "";
let adminUser: TestUser;
let cantina: TestUser;
let family: TestUser;
let noProfile: TestUser;
const store = () => createObjectStore(admin().target.storage);

async function keys(): Promise<string[]> {
  const out: string[] = [];
  for await (const object of store().list("products/")) out.push(object.key);
  return out.sort();
}

const photoOf = async () => ((await admin().db.doc(`products/${PRODUCT}`).get()).data()?.photoPath ?? null) as string | null;

test.beforeAll(async ({ request }) => {
  expect(isCloud()).toBe(true);
  [adminUser, cantina, family, noProfile] = await Promise.all([
    createTestUser("hml-adm-foto", "admin"),
    createTestUser("hml-cantina", "cantina"),
    createTestUser("hml-fam-foto", "guardian"),
    createTestUser("hml-sem-perfil"),
  ]);
  PRODUCT = await createTempProduct(request, adminUser.idToken, `Foto R2 ${crypto.randomUUID().slice(0, 6)}`);
});

// O produto temporário fica desativado com a última foto (referenciada, não órfã); a anterior já foi apagada pelo app.
test.afterAll(async ({ request }) => {
  if (PRODUCT) await retireTempProduct(request, adminUser.idToken, PRODUCT);
});

test("upload válido grava no armazenamento privado e a leitura autenticada devolve os mesmos bytes (A36)", async ({ request }) => {
  const before = await keys();
  const png = makePng(240, 180, [180, 90, 40]);
  const up = await request.post(`/api/catalog/photo?productId=${PRODUCT}`, { headers: { ...bearer(cantina.idToken), "content-type": "image/png" }, data: png });
  expect(up.status()).toBe(200);
  const key = await photoOf();
  expect(key).toBeTruthy();
  expect(await keys()).toContain(key);
  const head = await store().head(key!);
  expect(head?.contentType).toBe("image/png");
  expect(head?.size).toBe(png.length);

  // Leitura por qualquer conta ativa (família): mesmos bytes, cabeçalhos de segurança, ETag e 304.
  const read = await request.get(`/api/catalog/photo?productId=${PRODUCT}`, { headers: bearer(family.idToken) });
  expect(read.status()).toBe(200);
  expect(read.headers()["content-type"]).toBe("image/png");
  expect(read.headers()["x-content-type-options"]).toBe("nosniff");
  expect(read.headers()["cache-control"]).toContain("private");
  expect(Buffer.compare(await read.body(), png)).toBe(0);
  const etag = read.headers().etag!;
  expect(etag).toBeTruthy();
  const cached = await request.get(`/api/catalog/photo?productId=${PRODUCT}`, { headers: { ...bearer(family.idToken), "if-none-match": etag } });
  expect(cached.status()).toBe(304);

  // Troca: a foto anterior é removida e a nova chave é outra (nunca sobrescreve).
  const replaced = await request.post(`/api/catalog/photo?productId=${PRODUCT}`, { headers: { ...bearer(cantina.idToken), "content-type": "image/png" }, data: makePng(120, 90, [10, 120, 200]) });
  expect(replaced.status()).toBe(200);
  const next = await photoOf();
  expect(next).not.toBe(key);
  expect(await store().head(key!)).toBeNull();
  expect(await store().head(next!)).not.toBeNull();
  expect((await keys()).length).toBe(before.length + 1);
});

test("sem autorização: upload e leitura recusados e nada é gravado (A30/A36)", async ({ request }) => {
  const before = await keys();
  const png = makePng(32, 32, [1, 2, 3]);
  const headers = { "content-type": "image/png" };
  const cases: [string, Record<string, string>, number][] = [
    ["sem token", headers, 401],
    ["token inválido", { ...headers, authorization: "Bearer abc.def.ghi" }, 401],
    ["responsável", { ...headers, ...bearer(family.idToken) }, 403],
    ["conta sem perfil", { ...headers, ...bearer(noProfile.idToken) }, 403],
  ];
  for (const [label, h, status] of cases) {
    const response = await request.post(`/api/catalog/photo?productId=${PRODUCT}`, { headers: h, data: png });
    expect(response.status(), `upload ${label}`).toBe(status);
  }
  expect((await request.get(`/api/catalog/photo?productId=${PRODUCT}`)).status()).toBe(401);
  expect((await request.get(`/api/catalog/photo?productId=${PRODUCT}`, { headers: bearer(noProfile.idToken) })).status()).toBe(403);

  // Funcionário com perfil desativado depois do login: o token ainda aceito pelo Auth é recusado (403 account_inactive).
  const staff = await createTestUser("hml-cantina-off", "cantina");
  await admin().db.doc(`users/${staff.uid}`).update({ status: "disabled" });
  const off = await request.post(`/api/catalog/photo?productId=${PRODUCT}`, { headers: { ...headers, ...bearer(staff.idToken) }, data: png });
  expect(off.status()).toBe(403);
  expect(((await off.json()) as { error: string }).error).toBe("account_inactive");
  expect(await keys()).toEqual(before);
});

test("imagens inválidas e entradas maliciosas são recusadas sem gravar nada (A36)", async ({ request }) => {
  const before = await keys();
  const send = (qs: string, type: string, data: Buffer) =>
    request.post(`/api/catalog/photo${qs}`, { headers: { ...bearer(cantina.idToken), "content-type": type }, data });
  const ok = `?productId=${PRODUCT}`;
  const png = makePng(16, 16, [9, 9, 9]);
  const cases: [string, () => Promise<{ status(): number }>, number[]][] = [
    ["texto declarado como PNG", () => send(ok, "image/png", Buffer.from("não sou imagem")), [422]],
    ["SVG com script declarado como PNG", () => send(ok, "image/png", Buffer.from("<svg onload=alert(1)></svg>")), [422]],
    ["SVG declarado como SVG", () => send(ok, "image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), [415, 422]],
    ["PNG real declarado como texto", () => send(ok, "text/plain", png), [415, 422]],
    ["corpo vazio", () => send(ok, "image/png", Buffer.alloc(0)), [400, 422]],
    ["PNG truncado", () => send(ok, "image/png", png.subarray(0, 20)), [422]],
    ["acima de 2 MB", () => send(ok, "image/png", Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 + 10)])), [413, 422]],
    ["sem productId", () => send("", "image/png", png), [400]],
    ["productId com path traversal", () => send("?productId=../../etc/passwd", "image/png", png), [400, 404]],
    ["produto inexistente", () => send("?productId=nao-existe", "image/png", png), [404]],
  ];
  for (const [label, run, accepted] of cases) {
    const status = (await run()).status();
    expect(accepted, `${label} → ${status}`).toContain(status);
  }
  expect(await keys()).toEqual(before);
});

test("o bucket privado não responde a acesso anônimo (A33)", async () => {
  const { storage } = admin().target;
  test.skip(storage.driver !== "r2", "só existe bucket real na homologação");
  if (storage.driver !== "r2") return;
  const suco = (await fixtureIds()).product("Suco de laranja (exemplo)");
  const key = (await photoOf()) ?? ((await admin().db.doc(`products/${suco}`).get()).get("photoPath") as string);
  expect(key).toMatch(/^products\//);
  for (const url of [`${storage.endpoint}/${storage.bucket}/${key}`, `${storage.endpoint}/${storage.bucket}?list-type=2&prefix=products/`]) {
    const response = await fetch(url);
    expect(response.status, url).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("content-type") ?? "").not.toMatch(/^image\//);
  }
});
