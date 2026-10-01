// Dados de demonstração CLARAMENTE FICTÍCIOS, só para emulador local (demo-*). Isolados em `demoProducts`,
// fora de relatórios reais. Usado por scripts/seed.ts e pelos testes (e2e/integração). Escreve com o token
// "owner" do emulador, que ignora Rules — por isso recusa qualquer alvo que não seja loopback.
import { deflateSync, crc32 } from "node:zlib";

export type EmulatorTarget = {
  project: string;
  authHost: string;
  firestoreHost: string;
  storageHost: string;
  bucket: string;
};

export const DEFAULT_TARGET: EmulatorTarget = {
  project: "demo-cantina",
  authHost: "127.0.0.1:9099",
  firestoreHost: "127.0.0.1:8080",
  storageHost: "127.0.0.1:9199",
  bucket: "demo-cantina.appspot.com",
};

export function targetFromEnv(env: Record<string, string | undefined> = process.env): EmulatorTarget {
  return {
    project: env.FIREBASE_PROJECT_ID ?? DEFAULT_TARGET.project,
    authHost: env.FIREBASE_AUTH_EMULATOR_HOST ?? DEFAULT_TARGET.authHost,
    firestoreHost: env.FIRESTORE_EMULATOR_HOST ?? DEFAULT_TARGET.firestoreHost,
    storageHost: env.FIREBASE_STORAGE_EMULATOR_HOST ?? DEFAULT_TARGET.storageHost,
    bucket: env.FIREBASE_STORAGE_BUCKET ?? DEFAULT_TARGET.bucket,
  };
}

function assertLocal(target: EmulatorTarget): void {
  const loopback = /^(127\.0\.0\.1|localhost):\d+$/;
  const hosts = [target.authHost, target.firestoreHost, target.storageHost];
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
  category: string;
  available: boolean;
  special: string | null;
  color: [number, number, number] | null;
};

export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  { id: "demo-suco", name: "Suco de laranja (exemplo)", description: "Copo de 300 ml, sem açúcar adicionado.", priceCents: 450, category: "Bebidas", available: true, special: null, color: [244, 162, 70] },
  { id: "demo-pao", name: "Pão com queijo (exemplo)", description: "Pão macio com queijo, servido quente.", priceCents: 650, category: "Lanches", available: true, special: null, color: [214, 170, 112] },
  { id: "demo-fruta", name: "Salada de frutas (exemplo)", description: "Porção individual de frutas da estação.", priceCents: 500, category: "Lanches", available: true, special: null, color: [122, 180, 110] },
  { id: "demo-bolo", name: "Bolo de cenoura (exemplo)", description: "Fatia com cobertura, só neste dia.", priceCents: 550, category: "Especiais", available: false, special: "Especial · sexta, manhã", color: null },
];

export function demoPhotoPath(productId: string): string {
  return `products/${productId}/demo.png`;
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

type Plain = string | number | boolean | null | Plain[];

function toValue(value: Plain): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  return { arrayValue: { values: value.map(toValue) } };
}

/** Grava um documento no Firestore Emulator com o token "owner" (ignora Rules). Só emulador local. */
export async function writeDemoDoc(target: EmulatorTarget, path: string, data: Record<string, Plain>): Promise<void> {
  assertLocal(target);
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)]));
  const url = `http://${target.firestoreHost}/v1/projects/${target.project}/databases/(default)/documents/${path}`;
  const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json", ...OWNER }, body: JSON.stringify({ fields }) });
  await expectOk(response, `documento ${path}`);
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

async function uploadPhoto(target: EmulatorTarget, path: string, data: Buffer): Promise<void> {
  const url = `http://${target.storageHost}/v0/b/${target.bucket}/o?name=${encodeURIComponent(path)}`;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "image/png", ...OWNER }, body: new Uint8Array(data) });
  await expectOk(response, `upload ${path}`);
}

/** Grava o catálogo fictício e as fotos de exemplo (um produto fica sem foto para exercitar o fallback). Idempotente. */
export async function seedDemoCatalog(target: EmulatorTarget = DEFAULT_TARGET): Promise<void> {
  assertLocal(target);
  for (const product of DEMO_PRODUCTS) {
    const photoPath = product.color ? demoPhotoPath(product.id) : null;
    if (product.color && photoPath) await uploadPhoto(target, photoPath, makePng(240, 180, product.color));
    const fields: Record<string, unknown> = {
      name: { stringValue: product.name },
      description: { stringValue: product.description },
      priceCents: { integerValue: String(product.priceCents) },
      category: { stringValue: product.category },
      available: { booleanValue: product.available },
      special: product.special ? { stringValue: product.special } : { nullValue: null },
      photoPath: photoPath ? { stringValue: photoPath } : { nullValue: null },
      isDemo: { booleanValue: true },
    };
    const url = `http://${target.firestoreHost}/v1/projects/${target.project}/databases/(default)/documents/demoProducts/${product.id}`;
    const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json", ...OWNER }, body: JSON.stringify({ fields }) });
    await expectOk(response, `produto ${product.id}`);
  }
}
