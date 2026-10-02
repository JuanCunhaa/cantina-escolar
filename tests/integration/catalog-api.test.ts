// Catálogo real (F06) contra Auth/Firestore Emulator: autorização, preço em centavos com histórico imutável,
// concorrência e idempotência, desativação sem apagar, separação público × interno e a leitura canônica de venda.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request) => Promise<Response>;
let products: Handler;
let categories: Handler;
let school: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let readSellableProducts: typeof import("@/modules/catalog/commands").readSellableProducts;

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardian: TestUser;
let student: TestUser;
let morning: string;
let afternoon: string;
let category: string;

const tag = randomUUID().slice(0, 6);

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  products = (await import("@/app/api/catalog/products/route")).POST as Handler;
  categories = (await import("@/app/api/catalog/categories/route")).POST as Handler;
  school = (await import("@/app/api/school/route")).POST as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ readSellableProducts } = await import("@/modules/catalog/commands"));
  admin = await createTestUser("adm6", "admin");
  cantina = await createTestUser("cantina6", "cantina");
  secretaria = await createTestUser("secretaria6", "secretaria");
  guardian = await createTestUser("resp6", "guardian");
  student = await createTestUser("aluno6", "student");
  morning = (await ok(school, admin, { action: "create", kind: "shift", name: `Manhã ${tag}` })).id;
  afternoon = (await ok(school, admin, { action: "create", kind: "shift", name: `Tarde ${tag}` })).id;
  category = (await ok(categories, admin, { action: "create", name: `Bebidas ${tag}` })).id;
});

function call(handler: Handler, token: string | null, body: Record<string, unknown>): Promise<Response> {
  return handler(
    new Request("http://localhost/api/catalog", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ key: randomUUID(), ...body }),
    }),
  );
}
async function ok(handler: Handler, user: TestUser, body: Record<string, unknown>): Promise<{ id: string; version: number; priceVersion: number; changed: boolean; replayed: boolean }> {
  const response = await call(handler, user.idToken, body);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return (await response.json()) as never;
}
async function error(response: Response): Promise<{ status: number; error: string }> {
  return { status: response.status, error: ((await response.json()) as { error: string }).error };
}

let seq = 0;
const productInput = (overrides: Record<string, unknown> = {}) => ({
  action: "create",
  name: `Suco ${tag} ${++seq}`,
  description: "Copo de 300 ml (teste).",
  categoryId: category,
  priceCents: 800,
  channels: ["advance", "counter"],
  shiftIds: [morning, afternoon],
  availabilityMode: "physical",
  defaultSupplier: "Distribuidora Fictícia",
  internalNotes: "Comprar às segundas",
  ...overrides,
});
const newProduct = (overrides: Record<string, unknown> = {}) => ok(products, admin, productInput(overrides));
const data = async (path: string) => (await adminDb().doc(path).get()).data();
const history = async (id: string) =>
  (await adminDb().collection(`products/${id}/priceHistory`).orderBy("priceVersion").get()).docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);

describe("autorização (A30/A33)", () => {
  it("só a administração altera produtos e categorias; sem token = 401", async () => {
    const { id } = await newProduct();
    for (const user of [cantina, secretaria, guardian, student]) {
      expect((await call(products, user.idToken, productInput())).status).toBe(403);
      expect((await call(products, user.idToken, { action: "setPrice", id, expectedPriceVersion: 1, priceCents: 1, reason: "golpe" })).status).toBe(403);
      expect((await call(products, user.idToken, { action: "deactivate", id, reason: "golpe" })).status).toBe(403);
      expect((await call(categories, user.idToken, { action: "create", name: `Invasão ${tag}` })).status).toBe(403);
    }
    expect((await call(products, null, productInput())).status).toBe(401);
    expect((await data(`products/${id}`))!.priceCents).toBe(800);
  });

  it("administração rebaixada perde o acesso na próxima chamada, com o mesmo token", async () => {
    const temp = await createTestUser("adm6-temp", "admin");
    await ok(products, temp, productInput());
    await adminDb().doc(`users/${temp.uid}`).update({ role: "cantina" });
    expect((await call(products, temp.idToken, productInput())).status).toBe(403);
  });
});

describe("cadastro público × dados internos (custo/fornecedor fora do documento público)", () => {
  it("cria produto público, histórico v1, dados internos separados e auditoria", async () => {
    const { id, version, priceVersion } = await newProduct({ channels: ["counter", "advance"], shiftIds: [afternoon, morning, morning] });
    expect(id).toMatch(/^prd_[0-9a-f]{20}$/);
    expect({ version, priceVersion }).toEqual({ version: 1, priceVersion: 1 });
    const pub = (await data(`products/${id}`))!;
    expect(pub).toMatchObject({
      priceCents: 800,
      priceVersion: 1,
      status: "active",
      categoryId: category,
      channels: ["advance", "counter"],
      shiftIds: [morning, afternoon].sort(),
      availabilityMode: "physical",
      photoPath: null,
    });
    const leaked = Object.keys(pub).filter((k) => /cost|supplier|fornecedor|notes|margin/i.test(k));
    expect(leaked).toEqual([]);
    expect(JSON.stringify(pub)).not.toContain("Distribuidora");
    expect(await data(`productPrivate/${id}`)).toMatchObject({ defaultSupplier: "Distribuidora Fictícia", internalNotes: "Comprar às segundas" });
    expect(await history(id)).toMatchObject([{ id: "v1", priceVersion: 1, priceCents: 800, previousPriceCents: null, changedBy: admin.uid }]);
    const audit = (await adminDb().collection("auditLog").where("target.id", "==", id).get()).docs.map((d) => d.data());
    expect(audit.map((a) => a.action)).toEqual(["catalog.product.create"]);
    expect(JSON.stringify(audit)).not.toContain("Distribuidora");
  });

  it("editar só dados internos não muda a versão pública; auditoria registra o fato sem copiar o conteúdo", async () => {
    const { id } = await newProduct();
    const input = productInput({ action: "update", id, expectedVersion: 1, defaultSupplier: "Outro Fornecedor" });
    delete (input as Record<string, unknown>).priceCents;
    const result = await ok(products, admin, { ...input, name: (await data(`products/${id}`))!.name });
    expect(result).toMatchObject({ changed: true, version: 1 });
    expect((await data(`productPrivate/${id}`))!.defaultSupplier).toBe("Outro Fornecedor");
    const audit = (await adminDb().collection("auditLog").where("target.id", "==", id).where("action", "==", "catalog.product.update").get()).docs[0]!.data();
    expect(audit.after.privateUpdated).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("Outro Fornecedor");
  });

  it("nome duplicado (acento/caixa), categoria arquivada ou inexistente e turno inexistente são recusados", async () => {
    const { id } = await newProduct({ name: `Pão de Queijo ${tag}` });
    expect(await error(await call(products, admin.idToken, productInput({ name: `PAO DE QUEIJO ${tag}` })))).toEqual({ status: 409, error: "product_name_taken" });
    expect(await error(await call(products, admin.idToken, productInput({ categoryId: "cat_nao_existe" })))).toEqual({ status: 422, error: "category_unavailable" });
    expect(await error(await call(products, admin.idToken, productInput({ shiftIds: [morning, "shf_nao_existe"] })))).toEqual({ status: 422, error: "shift_unavailable" });
    expect((await call(products, admin.idToken, productInput({ priceCents: 8.5 }))).status).toBe(400);
    expect((await call(products, admin.idToken, productInput({ priceCents: "800" }))).status).toBe(400);
    expect((await call(products, admin.idToken, productInput({ channels: [] }))).status).toBe(400);
    expect(await data(`products/${id}`)).toBeDefined();
  });

  it("edição com versão desatualizada é recusada (409) sem sobrescrever", async () => {
    const { id } = await newProduct();
    const name = (await data(`products/${id}`))!.name as string;
    const update = (expectedVersion: number, description: string) => {
      const input = productInput({ action: "update", id, expectedVersion, name, description });
      delete (input as Record<string, unknown>).priceCents;
      return call(products, admin.idToken, input);
    };
    expect((await update(1, "Primeira edição")).status).toBe(200);
    expect(await error(await update(1, "Edição atrasada"))).toEqual({ status: 409, error: "stale_product" });
    expect(await data(`products/${id}`)).toMatchObject({ description: "Primeira edição", version: 2 });
  });
});

describe("preço histórico (A16 — parte do catálogo)", () => {
  it("R$ 8 → R$ 9: produto passa a 900 na versão 2; a entrada de R$ 8 permanece intacta", async () => {
    const { id } = await newProduct({ priceCents: 800 });
    const before = (await history(id))[0];
    const changed = await ok(products, admin, { action: "setPrice", id, expectedPriceVersion: 1, priceCents: 900, reason: "Reajuste do fornecedor" });
    expect(changed).toMatchObject({ changed: true, priceVersion: 2, version: 2 });
    expect(await data(`products/${id}`)).toMatchObject({ priceCents: 900, priceVersion: 2 });
    const entries = await history(id);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(before);
    expect(entries[1]).toMatchObject({ id: "v2", priceCents: 900, previousPriceCents: 800, reason: "Reajuste do fornecedor", changedBy: admin.uid });
    const audit = (await adminDb().collection("auditLog").where("target.id", "==", id).where("action", "==", "catalog.product.price").get()).docs[0]!.data();
    expect(audit.after).toMatchObject({ priceCents: 900, appliesTo: "new_sales_only" });
  });

  it("versão de preço desatualizada = 409; mesmo preço não cria entrada", async () => {
    const { id } = await newProduct();
    await ok(products, admin, { action: "setPrice", id, expectedPriceVersion: 1, priceCents: 850, reason: "Ajuste" });
    expect(await error(await call(products, admin.idToken, { action: "setPrice", id, expectedPriceVersion: 1, priceCents: 1, reason: "Atrasado" }))).toEqual({ status: 409, error: "stale_price" });
    expect(await ok(products, admin, { action: "setPrice", id, expectedPriceVersion: 2, priceCents: 850, reason: "Igual" })).toMatchObject({ changed: false, priceVersion: 2 });
    expect((await history(id)).map((e) => e.priceCents)).toEqual([800, 850]);
  });

  it("replay devolve a mesma resposta sem nova entrada; mesma chave com outro preço = 409", async () => {
    const { id } = await newProduct();
    const key = randomUUID();
    const body = { key, action: "setPrice", id, expectedPriceVersion: 1, priceCents: 950, reason: "Reajuste" };
    const first = await ok(products, admin, body);
    const replay = await ok(products, admin, body);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await error(await call(products, admin.idToken, { ...body, priceCents: 990 }))).toEqual({ status: 409, error: "idempotency_conflict" });
    expect((await history(id)).map((e) => e.priceCents)).toEqual([800, 950]);
  });

  it("concorrência: seis alterações simultâneas da mesma versão — uma vence, as demais 409, histórico contíguo", async () => {
    const { id } = await newProduct();
    const prices = [901, 902, 903, 904, 905, 906];
    const results = await Promise.all(
      prices.map((priceCents) => call(products, admin.idToken, { action: "setPrice", id, expectedPriceVersion: 1, priceCents, reason: `Concorrente ${priceCents}` })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(prices.length - 1);
    const winner = prices[statuses.indexOf(200)]!;
    expect(await data(`products/${id}`)).toMatchObject({ priceCents: winner, priceVersion: 2 });
    expect((await history(id)).map((e) => [e.priceVersion, e.priceCents])).toEqual([[1, 800], [2, winner]]);
  }, 90_000);
});

describe("desativação preserva histórico; leitura canônica de venda", () => {
  const sellable = (id: string, channel: "advance" | "counter", shiftId: string) =>
    adminDb().runTransaction(async (tx) => (await readSellableProducts(adminDb(), tx, [id], { channel, shiftId })).get(id));

  it("desativar não apaga: documento, histórico e dados internos permanecem; nova venda é negada; reativar volta", async () => {
    const { id } = await newProduct({ channels: ["advance"], shiftIds: [morning] });
    await ok(products, admin, { action: "setPrice", id, expectedPriceVersion: 1, priceCents: 700, reason: "Promoção" });
    expect(await sellable(id, "advance", morning)).toMatchObject({ ok: true, product: { priceCents: 700, priceVersion: 2 } });
    expect(await sellable(id, "counter", morning)).toEqual({ ok: false, reason: "channel_not_allowed" });
    expect(await sellable(id, "advance", afternoon)).toEqual({ ok: false, reason: "shift_not_allowed" });

    expect((await call(products, admin.idToken, { action: "deactivate", id, reason: "" })).status).toBe(400); // motivo obrigatório
    await ok(products, admin, { action: "deactivate", id, reason: "Fora de linha" });
    const pub = (await data(`products/${id}`))!;
    expect(pub).toMatchObject({ status: "inactive", priceCents: 700 });
    expect(JSON.stringify(pub)).not.toContain("Fora de linha"); // motivo interno não vai ao documento público
    expect(await data(`productPrivate/${id}`)).toMatchObject({ deactivationReason: "Fora de linha", deactivatedBy: admin.uid, defaultSupplier: "Distribuidora Fictícia" });
    expect((await history(id)).map((e) => e.priceCents)).toEqual([800, 700]);
    expect(await sellable(id, "advance", morning)).toEqual({ ok: false, reason: "product_inactive" });
    expect(await ok(products, admin, { action: "deactivate", id, reason: "De novo" })).toMatchObject({ changed: false });

    await ok(products, admin, { action: "reactivate", id });
    expect(await sellable(id, "advance", morning)).toMatchObject({ ok: true, product: { priceCents: 700 } });
    expect(await sellable("prd_inexistente", "advance", morning)).toEqual({ ok: false, reason: "product_not_found" });
  });

  it("reativar revalida os turnos atuais: turno arquivado enquanto o produto estava inativo bloqueia (422)", async () => {
    const lonely = (await ok(school, admin, { action: "create", kind: "shift", name: `Noite ${tag}` })).id;
    const { id } = await newProduct({ shiftIds: [lonely] });
    await ok(products, admin, { action: "deactivate", id, reason: "Turno vai encerrar" });
    await ok(school, admin, { action: "archive", kind: "shift", id: lonely });
    expect(await error(await call(products, admin.idToken, { action: "reactivate", id }))).toEqual({ status: 422, error: "shift_unavailable" });
    expect((await data(`products/${id}`))!.status).toBe("inactive");
    await ok(school, admin, { action: "restore", kind: "shift", id: lonely });
    expect(await ok(products, admin, { action: "reactivate", id })).toMatchObject({ changed: true });
  });

  it("não existe comando de exclusão de produto", async () => {
    const { id } = await newProduct();
    expect((await call(products, admin.idToken, { action: "delete", id })).status).toBe(400);
    expect(await data(`products/${id}`)).toBeDefined();
  });
});

describe("categorias", () => {
  it("nome único, renomear, arquivar bloqueado com produto ativo e liberado após desativar; reativar exige categoria ativa", async () => {
    const cat = (await ok(categories, admin, { action: "create", name: `Lanches ${tag}` })).id;
    expect(await error(await call(categories, admin.idToken, { action: "create", name: `LANCHES ${tag}` }))).toEqual({ status: 409, error: "category_name_taken" });
    await ok(categories, admin, { action: "rename", id: cat, name: `Salgados ${tag}` });
    expect((await data(`categories/${cat}`))!.name).toBe(`Salgados ${tag}`);
    await ok(categories, admin, { action: "create", name: `Lanches ${tag}` }); // nome antigo liberado pela renomeação

    const { id } = await newProduct({ categoryId: cat });
    expect(await error(await call(categories, admin.idToken, { action: "archive", id: cat }))).toEqual({ status: 409, error: "category_in_use" });
    await ok(products, admin, { action: "deactivate", id, reason: "Sem estoque" });
    await ok(categories, admin, { action: "archive", id: cat });
    expect(await error(await call(products, admin.idToken, productInput({ categoryId: cat })))).toEqual({ status: 422, error: "category_unavailable" });
    expect(await error(await call(products, admin.idToken, { action: "reactivate", id }))).toEqual({ status: 422, error: "category_unavailable" });
    await ok(categories, admin, { action: "restore", id: cat });
    await ok(products, admin, { action: "reactivate", id });
  });

  it("concorrência: arquivar categoria × criar produto nela nunca deixa produto ativo em categoria arquivada", async () => {
    for (let round = 0; round < 3; round++) {
      const cat = (await ok(categories, admin, { action: "create", name: `Corrida ${tag} ${round}` })).id;
      const [archive, create] = await Promise.all([
        call(categories, admin.idToken, { action: "archive", id: cat }),
        call(products, admin.idToken, productInput({ categoryId: cat })),
      ]);
      const status = (await data(`categories/${cat}`))!.status;
      const active = await adminDb().collection("products").where("categoryId", "==", cat).where("status", "==", "active").get();
      expect([archive.status, create.status].sort()).toEqual(archive.status === 200 ? [200, 422] : [200, 409]);
      expect(status === "archived" && !active.empty).toBe(false);
    }
  }, 90_000);
});
