// Catálogo (F06) pelas rotas reais e pelas Security Rules PUBLICADAS (REST com ID token real): comandos recusados sem
// permissão, criação/alteração pela administração e visão da família sem custo, fornecedor ou motivos internos.
// Cria apenas um produto temporário (sufixo aleatório) pela API e o deixa desativado; os produtos "(exemplo)" só são lidos.
import { expect, test } from "@playwright/test";
import { admin } from "../../scripts/staging/admin.ts";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { fixtureIds } from "../helpers/catalog-fixtures.ts";
import { isCloud } from "../helpers/cloud.ts";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
const SUPPLIER = `Fornecedor interno ${tag}`;
const NOTES = `Observação interna ${tag}`;
const REASON = `Motivo interno ${tag}`;
let adminUser: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let family: TestUser;
let student: TestUser;
let productId = "";

test.beforeAll(async () => {
  expect(isCloud()).toBe(true);
  [adminUser, cantina, secretaria, family, student] = await Promise.all([
    createTestUser("hml-cat-adm", "admin"),
    createTestUser("hml-cat-cantina", "cantina"),
    createTestUser("hml-cat-sec", "secretaria"),
    createTestUser("hml-cat-fam", "guardian"),
    createTestUser("hml-cat-aluno", "student"),
  ]);
});

const fieldNames = (body: Record<string, unknown>) => Object.keys((body.fields as Record<string, unknown>) ?? {});

test("comandos de catálogo sem permissão são recusados e nada é gravado (A30/A33)", async ({ request }) => {
  const ids = await fixtureIds();
  const suco = ids.product("Suco de laranja (exemplo)");
  const before = (await admin().db.doc(`products/${suco}`).get()).data()!;
  const create = {
    action: "create",
    name: `Invasor ${tag}`,
    description: "",
    categoryId: ids.category("Bebidas (exemplo)"),
    priceCents: 1,
    channels: ["advance"],
    shiftIds: [ids.shift("Manhã (exemplo)")],
    availabilityMode: "physical",
  };
  const attempts: [string, Record<string, unknown>][] = [
    ["/api/catalog/products", create],
    ["/api/catalog/products", { action: "setPrice", id: suco, expectedPriceVersion: before.priceVersion, priceCents: 1, reason: "golpe" }],
    ["/api/catalog/products", { action: "deactivate", id: suco, reason: "golpe" }],
    ["/api/catalog/categories", { action: "create", name: `Invasão ${tag}` }],
  ];
  for (const [url, data] of attempts) {
    expect((await request.post(url, { data: { key: newKey("x"), ...data } })).status(), `${url} sem token`).toBe(401);
    for (const [label, user] of [["cantina", cantina], ["secretaria", secretaria], ["família", family], ["aluno", student]] as const) {
      const response = await request.post(url, { headers: bearer(user.idToken), data: { key: newKey("x"), ...data } });
      expect(response.status(), `${url} ${String(data.action)} por ${label}`).toBe(403);
    }
  }
  const after = (await admin().db.doc(`products/${suco}`).get()).data()!;
  expect({ price: after.priceCents, status: after.status, version: after.version }).toEqual({ price: before.priceCents, status: before.status, version: before.version });
  expect((await admin().db.doc(`uniquenessKeys/product_invasor-${tag}`).get()).exists).toBe(false);

  // Escrita direta pelo cliente (Web SDK/REST) é negada pelas Rules, inclusive para a administração.
  for (const user of [family, adminUser]) {
    expect((await fsRequest(user.idToken, "PATCH", `products/${suco}`, { priceCents: { integerValue: "1" } })).status).toBe(403);
    expect((await fsRequest(user.idToken, "PATCH", `productPrivate/${suco}`, { defaultSupplier: { stringValue: "x" } })).status).toBe(403);
  }
});

test("administração cria, edita, muda preço e desativa pela API; histórico registra (A16 parcial)", async ({ request }) => {
  const ids = await fixtureIds();
  const post = async (data: Record<string, unknown>) => {
    const response = await request.post("/api/catalog/products", { headers: bearer(adminUser.idToken), data: { key: newKey("prd"), ...data } });
    expect(response.status(), `${String(data.action)} ${await response.text()}`).toBe(200);
    return (await response.json()) as { id: string; version: number; priceVersion: number };
  };
  const created = await post({
    action: "create",
    name: `Biscoito HML ${tag}`,
    description: "Pacote individual (fictício).",
    categoryId: ids.category("Lanches (exemplo)"),
    priceCents: 300,
    channels: ["advance", "counter"],
    shiftIds: [ids.shift("Manhã (exemplo)"), ids.shift("Tarde (exemplo)")],
    availabilityMode: "physical",
    defaultSupplier: SUPPLIER,
    internalNotes: NOTES,
  });
  productId = created.id;
  await post({ action: "setPrice", id: productId, expectedPriceVersion: 1, priceCents: 350, reason: "Reajuste de homologação" });
  const edited = await post({
    action: "update",
    id: productId,
    expectedVersion: 2,
    name: `Biscoito HML ${tag}`,
    description: "Pacote individual de 30 g (fictício).",
    categoryId: ids.category("Lanches (exemplo)"),
    channels: ["advance"],
    shiftIds: [ids.shift("Manhã (exemplo)")],
    availabilityMode: "planned",
    defaultSupplier: SUPPLIER,
    internalNotes: NOTES,
  });
  expect(edited.version).toBe(3);

  // Família lê o cadastro público já editado, com o preço novo.
  const asFamily = await fsRequest(family.idToken, "GET", `products/${productId}`);
  expect(asFamily.status).toBe(200);
  expect(JSON.stringify(asFamily.body)).toContain('"350"');
  expect(JSON.stringify(asFamily.body)).toContain("30 g");

  // Histórico de preço: cantina/administração leem as duas versões; família e aluno não.
  const history = await fsRequest(cantina.idToken, "GET", `products/${productId}/priceHistory`);
  expect(history.status).toBe(200);
  expect(((history.body.documents as unknown[]) ?? []).length).toBe(2);
  for (const user of [family, student, secretaria]) expect((await fsRequest(user.idToken, "GET", `products/${productId}/priceHistory`)).status).toBe(403);
  // Imutável também para a administração pelo cliente.
  expect((await fsRequest(adminUser.idToken, "PATCH", `products/${productId}/priceHistory/v1`, { priceCents: { integerValue: "1" } })).status).toBe(403);

  await post({ action: "deactivate", id: productId, reason: REASON });
});

test("visão familiar: sem custo, fornecedor, observações ou motivo interno; dados internos só para a administração (A33)", async () => {
  expect(productId).not.toBe("");
  for (const user of [family, student]) {
    const product = await fsRequest(user.idToken, "GET", `products/${productId}`);
    expect(product.status).toBe(200);
    const names = fieldNames(product.body);
    expect(names.filter((n) => /cost|custo|supplier|fornecedor|notes|reason|motivo|margin|deactivatedBy/i.test(n))).toEqual([]);
    const text = JSON.stringify(product.body);
    for (const secret of [SUPPLIER, NOTES, REASON]) expect(text).not.toContain(secret);
    expect((await fsRequest(user.idToken, "GET", `productPrivate/${productId}`)).status).toBe(403);
    expect((await fsRequest(user.idToken, "GET", "productPrivate")).status).toBe(403);
  }
  for (const user of [cantina, secretaria]) expect((await fsRequest(user.idToken, "GET", `productPrivate/${productId}`)).status).toBe(403);

  // O dado interno existe e fica no documento restrito, legível pela administração.
  const internal = await fsRequest(adminUser.idToken, "GET", `productPrivate/${productId}`);
  expect(internal.status).toBe(200);
  const text = JSON.stringify(internal.body);
  for (const secret of [SUPPLIER, NOTES, REASON]) expect(text).toContain(secret);
});
