// Dados de demonstração CLARAMENTE FICTÍCIOS (nomes "(exemplo)", IDs `*_exemplo_*`), só para emulador local (demo-*)
// e, pelo harness, para a homologação. Nunca usados em produção. Usado por scripts/seed.ts e pelos testes. Escreve com o token
// "owner" do emulador, que ignora Rules — por isso recusa qualquer alvo que não seja loopback. As fotos vão para o
// armazenamento local de emulator (mesmo diretório que o servidor de dev/e2e lê), nunca para um bucket real.
import { deflateSync, crc32 } from "node:zlib";
import { DEFAULT_LOCAL_STORAGE_DIR } from "../../src/lib/storage/config.ts";
import { createLocalStore } from "../../src/lib/storage/local.ts";
import { ObjectExistsError } from "../../src/lib/storage/types.ts";

export type EmulatorTarget = {
  project: string;
  authHost: string;
  firestoreHost: string;
  /** Diretório do armazenamento local (STORAGE_LOCAL_DIR do servidor). */
  storageDir: string;
};

export const DEFAULT_TARGET: EmulatorTarget = {
  project: "demo-cantina",
  authHost: "127.0.0.1:9099",
  firestoreHost: "127.0.0.1:8080",
  storageDir: process.env.STORAGE_LOCAL_DIR || DEFAULT_LOCAL_STORAGE_DIR,
};

export function targetFromEnv(env: Record<string, string | undefined> = process.env): EmulatorTarget {
  return {
    project: env.FIREBASE_PROJECT_ID ?? DEFAULT_TARGET.project,
    authHost: env.FIREBASE_AUTH_EMULATOR_HOST ?? DEFAULT_TARGET.authHost,
    firestoreHost: env.FIRESTORE_EMULATOR_HOST ?? DEFAULT_TARGET.firestoreHost,
    storageDir: env.STORAGE_LOCAL_DIR || DEFAULT_TARGET.storageDir,
  };
}

function assertLocal(target: EmulatorTarget): void {
  const loopback = /^(127\.0\.0\.1|localhost):\d+$/;
  const hosts = [target.authHost, target.firestoreHost];
  if (!hosts.every((h) => loopback.test(h)) || !target.project.startsWith("demo-")) {
    throw new Error("seed recusado: só emulador local com projeto demo-*.");
  }
}

const OWNER = { authorization: "Bearer owner" };

/** PNG com leve gradiente vertical (arte original gerada em código; sem imagem de terceiros). */
export function makePng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    const shade = 1 - (y / height) * 0.25;
    rows.push(0);
    for (let x = 0; x < width; x++) rows.push(Math.round(r * shade), Math.round(g * shade), Math.round(b * shade));
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export type DemoProduct = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  categoryId: string;
  channels: ("advance" | "counter")[];
  shiftIds: string[];
  availabilityMode: "physical" | "planned";
  status: "active" | "inactive";
  color: [number, number, number] | null;
};

/**
 * Turnos e categorias de exemplo com IDs fixos (re-executável) e as mesmas chaves de unicidade dos comandos reais. Os
 * turnos de exemplo têm horários próprios em `settings/school.shiftPolicies` (o padrão por nome só vale para
 * "Manhã"/"Tarde" exatos), com os mesmos limites iniciais de manhã/tarde.
 */
export const DEMO_SHIFTS = [
  { id: "shf_exemplo_manha", name: "Manhã (exemplo)", slug: "manha-exemplo", cutoffs: { purchaseCutoff: "07:00", cancelCutoff: "08:00" } },
  { id: "shf_exemplo_tarde", name: "Tarde (exemplo)", slug: "tarde-exemplo", cutoffs: { purchaseCutoff: "14:00", cancelCutoff: "15:00" } },
] as const;
/** Turma de exemplo para os alunos fictícios criados pelos testes do portal. */
export const DEMO_CLASS = { id: "cls_exemplo", name: "Turma (exemplo)", slug: "turma-exemplo" } as const;
export const DEMO_CATEGORIES = [
  { id: "cat_exemplo_bebidas", name: "Bebidas (exemplo)", slug: "bebidas-exemplo" },
  { id: "cat_exemplo_lanches", name: "Lanches (exemplo)", slug: "lanches-exemplo" },
  { id: "cat_exemplo_especiais", name: "Especiais (exemplo)", slug: "especiais-exemplo" },
] as const;
const BOTH_SHIFTS = DEMO_SHIFTS.map((s) => s.id);

/**
 * Catálogo fictício no modelo real (F06): cobre os dois modos, os dois canais, turno restrito, produto só de
 * balcão (sem foto, para o fallback) e um produto desativado.
 */
export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  { id: "prd_exemplo_suco", name: "Suco de laranja (exemplo)", description: "Copo de 300 ml, sem açúcar adicionado.", priceCents: 450, categoryId: "cat_exemplo_bebidas", channels: ["advance", "counter"], shiftIds: BOTH_SHIFTS, availabilityMode: "physical", status: "active", color: [244, 162, 70] },
  { id: "prd_exemplo_pao", name: "Pão com queijo (exemplo)", description: "Pão macio com queijo, servido quente.", priceCents: 650, categoryId: "cat_exemplo_lanches", channels: ["advance", "counter"], shiftIds: BOTH_SHIFTS, availabilityMode: "planned", status: "active", color: [214, 170, 112] },
  { id: "prd_exemplo_fruta", name: "Salada de frutas (exemplo)", description: "Porção individual de frutas da estação.", priceCents: 500, categoryId: "cat_exemplo_lanches", channels: ["advance"], shiftIds: ["shf_exemplo_manha"], availabilityMode: "planned", status: "active", color: [122, 180, 110] },
  { id: "prd_exemplo_bolo", name: "Bolo de cenoura (exemplo)", description: "Fatia com cobertura, vendida no balcão.", priceCents: 550, categoryId: "cat_exemplo_especiais", channels: ["counter"], shiftIds: ["shf_exemplo_manha"], availabilityMode: "planned", status: "active", color: null },
  { id: "prd_exemplo_pipoca", name: "Pipoca (exemplo)", description: "Saquinho individual.", priceCents: 300, categoryId: "cat_exemplo_especiais", channels: ["advance", "counter"], shiftIds: BOTH_SHIFTS, availabilityMode: "physical", status: "inactive", color: null },
];

export function demoPhotoPath(productId: string): string {
  return `products/${productId}/demo.png`;
}

type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

/** Mesma chave de unicidade dos comandos reais (src/modules/students/normalize.ts `unitSlug`), sem imports `@/`. */
export function nameSlug(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Documentos do catálogo fictício (sem timestamps: o seed não depende do relógio). Fotos são tratadas à parte. Inclui
 * a turma de exemplo e o cardápio padrão (F07) dos produtos ativos de exemplo em todos os turnos em que são vendidos.
 */
export function demoCatalogDocs(): { path: string; data: Record<string, Plain> }[] {
  const docs: { path: string; data: Record<string, Plain> }[] = [];
  for (const shift of DEMO_SHIFTS) {
    docs.push({ path: `shifts/${shift.id}`, data: { name: shift.name, nameSlug: shift.slug, status: "active" } });
    docs.push({ path: `uniquenessKeys/shift_${shift.slug}`, data: { unitId: shift.id, kind: "shift" } });
  }
  docs.push({ path: `classes/${DEMO_CLASS.id}`, data: { name: DEMO_CLASS.name, nameSlug: DEMO_CLASS.slug, status: "active" } });
  docs.push({ path: `uniquenessKeys/class_${DEMO_CLASS.slug}`, data: { unitId: DEMO_CLASS.id, kind: "class" } });
  for (const p of DEMO_PRODUCTS.filter((product) => product.status === "active")) {
    docs.push({ path: `defaultMenuRules/${p.id}`, data: { productId: p.id, shiftIds: [...p.shiftIds].sort(), version: 1, updatedBy: "seed" } });
  }
  for (const category of DEMO_CATEGORIES) {
    docs.push({ path: `categories/${category.id}`, data: { name: category.name, nameSlug: category.slug, status: "active" } });
    docs.push({ path: `uniquenessKeys/category_${category.slug}`, data: { categoryId: category.id } });
  }
  for (const p of DEMO_PRODUCTS) {
    const slug = nameSlug(p.name);
    docs.push({
      path: `products/${p.id}`,
      data: {
        name: p.name,
        nameSlug: slug,
        description: p.description,
        categoryId: p.categoryId,
        priceCents: p.priceCents,
        priceVersion: 1,
        channels: p.channels,
        shiftIds: p.shiftIds,
        availabilityMode: p.availabilityMode,
        status: p.status,
        version: 1,
        photoPath: p.color ? demoPhotoPath(p.id) : null,
        createdBy: "seed",
        updatedBy: "seed",
      },
    });
    docs.push({ path: `products/${p.id}/priceHistory/v1`, data: { productId: p.id, priceVersion: 1, priceCents: p.priceCents, previousPriceCents: null, reason: "Cadastro inicial", changedBy: "seed" } });
    docs.push({ path: `productPrivate/${p.id}`, data: { defaultSupplier: "Fornecedor fictício", internalNotes: "", updatedBy: "seed" } });
    docs.push({ path: `uniquenessKeys/product_${slug}`, data: { productId: p.id } });
  }
  return docs;
}

async function expectOk(response: Response, what: string): Promise<void> {
  if (!response.ok) throw new Error(`${what} falhou: ${response.status} ${await response.text()}`);
}

export type DemoProfile = {
  role: "guardian" | "student" | "cantina" | "secretaria" | "admin";
  status?: "active" | "disabled";
  permissions?: string[];
  displayName?: string;
};

function toValue(value: Plain): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toValue(v)])) } };
}

/**
 * Grava um documento no Firestore Emulator com o token "owner" (ignora Rules). Só emulador local. Com `mask`, altera
 * apenas esses caminhos de campo (o restante do documento é preservado); sem ela, substitui o documento inteiro.
 */
export async function writeDemoDoc(target: EmulatorTarget, path: string, data: Record<string, Plain>, mask?: readonly string[]): Promise<void> {
  assertLocal(target);
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)]));
  const query = mask ? `?${mask.map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&")}` : "";
  const url = `http://${target.firestoreHost}/v1/projects/${target.project}/databases/(default)/documents/${path}${query}`;
  const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json", ...OWNER }, body: JSON.stringify({ fields }) });
  await expectOk(response, `documento ${path}`);
}

/** Lê um campo de texto de um documento do Firestore Emulator com o token "owner" (só emulador local). Ausente = null. */
export async function readDemoString(target: EmulatorTarget, path: string, field: string): Promise<string | null> {
  assertLocal(target);
  const url = `http://${target.firestoreHost}/v1/projects/${target.project}/databases/(default)/documents/${path}`;
  const response = await fetch(url, { headers: OWNER });
  if (response.status === 404) return null;
  await expectOk(response, `documento ${path}`);
  const body = (await response.json()) as { fields?: Record<string, { stringValue?: string }> };
  return body.fields?.[field]?.stringValue ?? null;
}

/** Perfil de acesso fictício em users/{uid} (fonte do papel; ver src/modules/access/profile.ts). */
export async function setDemoProfile(target: EmulatorTarget, uid: string, email: string, profile: DemoProfile): Promise<void> {
  await writeDemoDoc(target, `users/${uid}`, {
    email,
    displayName: profile.displayName ?? email.split("@")[0] ?? email,
    role: profile.role,
    status: profile.status ?? "active",
    permissions: profile.permissions ?? [],
    accessVersion: 1,
  });
}

/** Cria (ou reutiliza) uma conta fictícia no Auth Emulator; com `role`, grava também o perfil de acesso. */
export async function ensureAccount(
  target: EmulatorTarget,
  account: { email: string; password: string; role?: DemoProfile["role"] },
): Promise<string> {
  assertLocal(target);
  const base = `http://${target.authHost}/identitytoolkit.googleapis.com/v1`;
  const headers = { "content-type": "application/json" };
  const body = JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true });
  let response = await fetch(`${base}/accounts:signUp?key=fake`, { method: "POST", headers, body });
  if (!response.ok) response = await fetch(`${base}/accounts:signInWithPassword?key=fake`, { method: "POST", headers, body });
  await expectOk(response, `conta ${account.email}`);
  const { localId } = (await response.json()) as { localId: string };
  if (account.role) await setDemoProfile(target, localId, account.email, { role: account.role });
  return localId;
}

async function uploadPhoto(target: EmulatorTarget, key: string, data: Buffer): Promise<void> {
  // Seed idempotente: a foto de demonstração tem chave fixa e é criada uma única vez (o armazenamento não sobrescreve).
  try {
    await createLocalStore(target.storageDir).putIfAbsent(key, data, { contentType: "image/png", metadata: { seed: "demo" } });
  } catch (error) {
    if (!(error instanceof ObjectExistsError)) throw error;
  }
}

/**
 * Grava o catálogo fictício (modelo real da F06: categorias, turnos, produtos, histórico de preço e dados internos) e
 * as fotos de exemplo. Re-executável: restaura o estado inicial dos documentos de exemplo.
 */
export async function seedDemoCatalog(target: EmulatorTarget = DEFAULT_TARGET): Promise<void> {
  assertLocal(target);
  for (const product of DEMO_PRODUCTS) {
    if (product.color) await uploadPhoto(target, demoPhotoPath(product.id), makePng(240, 180, product.color));
  }
  for (const { path, data } of demoCatalogDocs()) await writeDemoDoc(target, path, data);
  // Horários dos turnos de exemplo: só os próprios campos (demais configurações e turnos ficam como estão).
  await writeDemoDoc(
    target,
    "settings/school",
    { shiftPolicies: Object.fromEntries(DEMO_SHIFTS.map((s) => [s.id, { ...s.cutoffs }])) },
    DEMO_SHIFTS.map((s) => `shiftPolicies.${s.id}`),
  );
}