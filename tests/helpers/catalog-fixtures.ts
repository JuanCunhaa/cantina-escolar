// Catálogo fictício "(exemplo)" usado pelos verificadores, em dois modos:
// - emulador (e2e local): seed direto e re-executável (scripts/lib/demo-seed.ts, recusa alvo que não seja loopback);
// - homologação/publicado (STAGING_TARGET): NUNCA reset por Admin SDK. Os produtos são garantidos pelas rotas
//   autorizadas do próprio app (conta fixture de administração), só criando o que falta e corrigindo situação/foto
//   ausente. Os testes não alteram esses produtos: o que precisa mudar algo cria o próprio produto temporário.
import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { DEFAULT_TARGET, DEMO_CATEGORIES, DEMO_CLASS, DEMO_PRODUCTS, DEMO_SHIFTS, makePng, nameSlug, readDemoString, seedDemoCatalog } from "../../scripts/lib/demo-seed.ts";
import { admin, signIn } from "../../scripts/staging/admin.ts";
import type { FixtureManifest } from "../../scripts/staging/fixtures.ts";
import { PUBLISHED_STATE_FILE, type Target } from "../../scripts/staging/target.ts";
import { isCloud } from "./cloud.ts";

export type FixtureIds = {
  category: (name: string) => string;
  shift: (name: string) => string;
  product: (name: string) => string;
  /** Turma de exemplo (alunos fictícios do portal). */
  classId: () => string;
};

const categoryName = (id: string) => DEMO_CATEGORIES.find((c) => c.id === id)!.name;
const shiftName = (id: string) => DEMO_SHIFTS.find((s) => s.id === id)!.name;

/** Prepara o catálogo de exemplo antes de um spec: no emulador semeia; na nuvem o global-setup já garantiu pela API. */
export async function prepareCatalog(): Promise<void> {
  if (!isCloud()) await seedDemoCatalog(DEFAULT_TARGET);
}

/** IDs por nome. Emulador: IDs fixos do seed. Nuvem: chaves de unicidade gravadas pelos comandos reais (só leitura). */
export async function fixtureIds(): Promise<FixtureIds> {
  if (!isCloud()) {
    const by = <T extends { id: string; name: string }>(list: readonly T[]) => (name: string) => {
      const found = list.find((item) => item.name === name);
      if (!found) throw new Error(`fixture desconhecida: ${name}`);
      return found.id;
    };
    return { category: by(DEMO_CATEGORIES), shift: by(DEMO_SHIFTS), product: by(DEMO_PRODUCTS), classId: () => DEMO_CLASS.id };
  }
  const { db } = admin();
  const read = async (kind: "category" | "shift" | "product" | "class", field: string, names: readonly string[]) => {
    const map = new Map<string, string>();
    for (const name of names) {
      const id = (await db.doc(`uniquenessKeys/${kind}_${nameSlug(name)}`).get()).get(field);
      if (typeof id === "string") map.set(name, id);
    }
    return (name: string) => {
      const id = map.get(name);
      if (!id) throw new Error(`fixture ausente na homologação: ${name} (o global-setup deveria tê-la criado)`);
      return id;
    };
  };
  const classes = await read("class", "unitId", [DEMO_CLASS.name]);
  return {
    category: await read("category", "categoryId", DEMO_CATEGORIES.map((c) => c.name)),
    shift: await read("shift", "unitId", DEMO_SHIFTS.map((s) => s.name)),
    product: await read("product", "productId", DEMO_PRODUCTS.map((p) => p.name)),
    classId: () => classes(DEMO_CLASS.name),
  };
}

type Api = {
  post: (url: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>;
  get: (url: string) => Promise<Record<string, unknown>>;
};

function apiFor(context: APIRequestContext, idToken: string): Api {
  return {
    async post(url, data) {
      const response = await context.post(url, { headers: { authorization: `Bearer ${idToken}` }, data: { key: crypto.randomUUID(), ...data } });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok()) throw new Error(`${url} ${String(data.action)} → ${response.status()} ${String(body.error ?? "")}`);
      return body;
    },
    async get(url) {
      const response = await context.get(url, { headers: { authorization: `Bearer ${idToken}` } });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok()) throw new Error(`GET ${url} → ${response.status()} ${String(body.error ?? "")}`);
      return body;
    },
  };
}

/**
 * Garante o catálogo de exemplo na homologação pelo fluxo autorizado (rotas do app, conta fixture `admin`):
 * turnos e categorias "(exemplo)", os cinco produtos, a situação esperada e as fotos que faltam; desde a F07 também o
 * cardápio padrão dos produtos ativos, a turma "(exemplo)" e os horários dos turnos de exemplo. Idempotente: com tudo
 * presente, só lê. Não altera preço/canais de produto existente e não remove foto (não existe comando para isso).
 */
export async function ensureCloudCatalog(target: Target, manifest: FixtureManifest): Promise<string[]> {
  const { db } = admin(target);
  const account = manifest.accounts.admin;
  if (!account) throw new Error("fixture admin ausente no manifesto");
  const { idToken } = await signIn(target, account.email, account.password);
  const context = await playwrightRequest.newContext({ baseURL: target.baseUrl, ...(target.published ? { storageState: PUBLISHED_STATE_FILE } : {}) });
  const api = apiFor(context, idToken);
  const actions: string[] = [];
  const key = async (kind: string, name: string, field: string) => {
    const snap = await db.doc(`uniquenessKeys/${kind}_${nameSlug(name)}`).get();
    return snap.exists ? (snap.get(field) as string) : null;
  };
  try {
    const shiftIds = new Map<string, string>();
    for (const shift of DEMO_SHIFTS) {
      let id = await key("shift", shift.name, "unitId");
      if (!id) {
        id = (await api.post("/api/school", { action: "create", kind: "shift", name: shift.name })).id as string;
        actions.push(`turno criado: ${shift.name}`);
      } else if ((await db.doc(`shifts/${id}`).get()).get("status") !== "active") {
        await api.post("/api/school", { action: "restore", kind: "shift", id });
        actions.push(`turno restaurado: ${shift.name}`);
      }
      shiftIds.set(shift.id, id);
    }
    const categoryIds = new Map<string, string>();
    for (const category of DEMO_CATEGORIES) {
      let id = await key("category", category.name, "categoryId");
      if (!id) {
        id = (await api.post("/api/catalog/categories", { action: "create", name: category.name })).id as string;
        actions.push(`categoria criada: ${category.name}`);
      } else if ((await db.doc(`categories/${id}`).get()).get("status") !== "active") {
        await api.post("/api/catalog/categories", { action: "restore", id });
        actions.push(`categoria restaurada: ${category.name}`);
      }
      categoryIds.set(category.id, id);
    }
    for (const product of DEMO_PRODUCTS) {
      let id = await key("product", product.name, "productId");
      if (!id) {
        id = (
          await api.post("/api/catalog/products", {
            action: "create",
            name: product.name,
            description: product.description,
            categoryId: categoryIds.get(product.categoryId),
            priceCents: product.priceCents,
            channels: product.channels,
            shiftIds: product.shiftIds.map((s) => shiftIds.get(s)),
            availabilityMode: product.availabilityMode,
            defaultSupplier: "Fornecedor fictício",
            internalNotes: "",
          })
        ).id as string;
        actions.push(`produto criado: ${product.name}`);
      }
      const current = (await db.doc(`products/${id}`).get()).data() ?? {};
      if (product.color && !current.photoPath) {
        const response = await context.post(`/api/catalog/photo?productId=${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${idToken}`, "content-type": "image/png" },
          data: makePng(240, 180, product.color),
        });
        if (!response.ok()) throw new Error(`foto de ${product.name} → ${response.status()}`);
        actions.push(`foto enviada: ${product.name}`);
      }
      if (!product.color && current.photoPath) actions.push(`AVISO: ${product.name} deveria estar sem foto (fallback); não há comando para remover`);
      if (current.status !== product.status) {
        await api.post(
          "/api/catalog/products",
          product.status === "inactive" ? { action: "deactivate", id, reason: "Fixture de homologação: exemplo de produto desativado" } : { action: "reactivate", id },
        );
        actions.push(`situação ajustada (${product.status}): ${product.name}`);
      }
      // F07: cardápio padrão do produto ativo de exemplo = todos os turnos em que é vendido.
      if (product.status === "active") {
        const wanted = product.shiftIds.map((s) => shiftIds.get(s)!).sort();
        const rule = (await db.doc(`defaultMenuRules/${id}`).get()).data();
        const have = Array.isArray(rule?.shiftIds) ? [...(rule.shiftIds as string[])].sort() : [];
        if (have.join(",") !== wanted.join(",")) {
          await api.post("/api/menu", { action: "setDefault", productId: id, shiftIds: wanted, expectedVersion: Number(rule?.version ?? 0) });
          actions.push(`cardápio padrão: ${product.name}`);
        }
      }
    }

    // Turma de exemplo (alunos fictícios do portal).
    const classId = await key("class", DEMO_CLASS.name, "unitId");
    if (!classId) {
      await api.post("/api/school", { action: "create", kind: "class", name: DEMO_CLASS.name });
      actions.push(`turma criada: ${DEMO_CLASS.name}`);
    } else if ((await db.doc(`classes/${classId}`).get()).get("status") !== "active") {
      await api.post("/api/school", { action: "restore", kind: "class", id: classId });
      actions.push(`turma restaurada: ${DEMO_CLASS.name}`);
    }

    // Horários dos turnos de exemplo (só os que faltam), pela rota de configurações com versão esperada.
    const settings = (await api.get("/api/school/settings")) as {
      schoolName: string;
      weekdays: number[];
      shiftPolicies: Record<string, { purchaseCutoff: string; cancelCutoff: string }>;
      version: number;
    };
    const missing = DEMO_SHIFTS.filter((s) => !settings.shiftPolicies[shiftIds.get(s.id)!]);
    if (missing.length > 0) {
      await api.post("/api/school/settings", {
        expectedVersion: settings.version,
        schoolName: settings.schoolName || "Escola de homologação (fictícia)",
        weekdays: settings.weekdays,
        shiftPolicies: { ...settings.shiftPolicies, ...Object.fromEntries(missing.map((s) => [shiftIds.get(s.id)!, { ...s.cutoffs }])) },
      });
      actions.push(`horários de turno: ${missing.map((s) => s.name).join(", ")}`);
    }
  } finally {
    await context.dispose();
  }
  return actions;
}

/** ID de um produto pelo nome: chave de unicidade gravada pelo comando real (só leitura; emulador ou homologação). */
export async function productIdByName(name: string): Promise<string> {
  const path = `uniquenessKeys/product_${nameSlug(name)}`;
  const id = isCloud() ? ((await admin().db.doc(path).get()).get("productId") as unknown) : await readDemoString(DEFAULT_TARGET, path, "productId");
  if (typeof id !== "string") throw new Error(`produto não encontrado: ${name}`);
  return id;
}

/** Produto temporário criado pela API (administração) para testes que mudam foto/preço/situação sem tocar nas fixtures. */
export async function createTempProduct(
  request: APIRequestContext,
  adminToken: string,
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const ids = await fixtureIds();
  const response = await request.post("/api/catalog/products", {
    headers: { authorization: `Bearer ${adminToken}` },
    data: {
      key: crypto.randomUUID(),
      action: "create",
      name,
      description: "Produto temporário de teste (fictício).",
      categoryId: ids.category(categoryName("cat_exemplo_especiais")),
      priceCents: 300,
      channels: ["advance", "counter"],
      shiftIds: [ids.shift(shiftName("shf_exemplo_manha")), ids.shift(shiftName("shf_exemplo_tarde"))],
      availabilityMode: "physical",
      ...overrides,
    },
  });
  if (!response.ok()) throw new Error(`criar produto temporário → ${response.status()} ${await response.text()}`);
  return ((await response.json()) as { id: string }).id;
}

/** Desativa o produto temporário ao fim do teste (nada é apagado; sai da vitrine e das contagens). */
export async function retireTempProduct(request: APIRequestContext, adminToken: string, id: string): Promise<void> {
  const response = await request.post("/api/catalog/products", {
    headers: { authorization: `Bearer ${adminToken}` },
    data: { key: crypto.randomUUID(), action: "deactivate", id, reason: "Fim do teste automatizado" },
  });
  if (!response.ok()) throw new Error(`desativar produto temporário → ${response.status()}`);
}

