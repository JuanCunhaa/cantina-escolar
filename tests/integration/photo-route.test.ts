// Fotos no armazenamento privado (substitui a prova com Firebase Storage). Auth e Firestore são emuladores reais; o
// armazenamento é o DOUBLE em disco (APP_ENV=emulator). Isto prova a lógica da aplicação — autorização, validação,
// chaves, ordem das operações e falhas entre armazenamento e Firestore — e NÃO o comportamento do R2
// (ver tests/r2/r2-integration.test.ts e docs/status/r2-migration.md).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { makePng, seedDemoCatalog, targetFromEnv } from "../../scripts/lib/demo-seed.ts";

import type { Actor } from "@/modules/access/actor";

type Handler = (request: Request) => Promise<Response>;
let POST: Handler;
let GET: Handler;
let SWEEP: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let getObjectStore: typeof import("@/lib/storage").getObjectStore;
let uploadProductPhoto: typeof import("@/modules/catalog/photo").uploadProductPhoto;
let sweepOrphanPhotos: typeof import("@/modules/catalog/photo-sweep").sweepOrphanPhotos;
let ObjectExistsError: typeof import("@/lib/storage").ObjectExistsError;
let StorageUnavailableError: typeof import("@/lib/storage").StorageUnavailableError;
let staff: TestUser;
let admin: TestUser;
let secretaria: TestUser;
let guardian: TestUser;
let student: TestUser;
let noProfile: TestUser;

const png = (shade: number) => makePng(16, 16, [shade, 120, 200]);
const KEY_PATTERN = /^products\/[A-Za-z0-9_-]+\/[0-9a-f]{32}\.(png|jpg|webp)$/;

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  process.env.STORAGE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "cantina-photos-"));
  ({ POST, GET } = await import("@/app/api/catalog/photo/route"));
  ({ POST: SWEEP } = await import("@/app/api/admin/storage/sweep/route"));
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ getObjectStore, ObjectExistsError, StorageUnavailableError } = await import("@/lib/storage"));
  ({ uploadProductPhoto } = await import("@/modules/catalog/photo"));
  ({ sweepOrphanPhotos } = await import("@/modules/catalog/photo-sweep"));
  staff = await createTestUser("cantina", "cantina");
  admin = await createTestUser("admin", "admin");
  secretaria = await createTestUser("secretaria", "secretaria");
  guardian = await createTestUser("familia", "guardian");
  student = await createTestUser("aluno", "student");
  noProfile = await createTestUser("sem-perfil");
  await seedDemoCatalog(targetFromEnv());
});

const auth = (token: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
type Body = Buffer | Uint8Array | string | null;

function upload(token: string | null, productId: string | null, body: Body, type: string | null = "image/png", extraQuery = ""): Promise<Response> {
  const query = productId === null ? extraQuery : `?productId=${encodeURIComponent(productId)}${extraQuery}`;
  return POST(
    new Request(`http://localhost/api/catalog/photo${query}`, {
      method: "POST",
      headers: { ...(type ? { "content-type": type } : {}), ...auth(token) } as Record<string, string>,
      body: body as BodyInit | null,
    }),
  );
}

function read(token: string | null, productId: string | null, headers: Record<string, string> = {}, extraQuery = ""): Promise<Response> {
  const query = productId === null ? extraQuery : `?productId=${encodeURIComponent(productId)}${extraQuery}`;
  return GET(new Request(`http://localhost/api/catalog/photo${query}`, { headers: { ...auth(token), ...headers } }));
}

async function newProduct(id: string): Promise<string> {
  await adminDb().doc(`products/${id}`).set({ name: `Produto ${id}`, photoPath: null });
  return id;
}

async function photoPathOf(id: string): Promise<string | null> {
  return ((await adminDb().doc(`products/${id}`).get()).get("photoPath") as string | null) ?? null;
}

async function keysOf(productId: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of getObjectStore().list(`products/${productId}/`)) keys.push(object.key);
  return keys.sort();
}

describe("POST /api/catalog/photo — envio autorizado (A36)", () => {
  it("recusa sem token ou com token inválido (401) sem gravar nada", async () => {
    const id = await newProduct("it-401");
    expect((await upload(null, id, png(1))).status).toBe(401);
    expect((await upload("lixo", id, png(1))).status).toBe(401);
    expect(await keysOf(id)).toEqual([]);
  });

  it("recusa responsável, aluno, secretaria e conta sem perfil (403) sem gravar nada", async () => {
    const id = await newProduct("it-403");
    for (const user of [guardian, student, secretaria, noProfile]) {
      expect((await upload(user.idToken, id, png(2))).status).toBe(403);
    }
    expect(await keysOf(id)).toEqual([]);
    expect(await photoPathOf(id)).toBeNull();
  });

  it("recusa conta desativada (403 account_inactive), mesmo com token ainda aceito pelo Auth", async () => {
    const id = await newProduct("it-off");
    const off = await createTestUser("cantina-off", "cantina");
    await adminDb().doc(`users/${off.uid}`).update({ status: "disabled" });
    const response = await upload(off.idToken, id, png(3));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_inactive" });
    expect(await keysOf(id)).toEqual([]);
  });

  it("cantina e admin enviam; a chave é gerada no servidor e papel/uid/chave do cliente são ignorados", async () => {
    const id = await newProduct("it-ok");
    const bytes = png(10);
    const response = await upload(staff.idToken, id, bytes, "image/png", "&uid=outro&role=admin&path=products/outro/x.png&key=products/it-ok/escolhida.png");
    expect(response.status).toBe(200);
    const { photoPath } = (await response.json()) as { photoPath: string };
    expect(photoPath).toMatch(KEY_PATTERN);
    expect(photoPath.startsWith(`products/${id}/`)).toBe(true);
    expect(photoPath).not.toContain("escolhida");
    expect(await photoPathOf(id)).toBe(photoPath);

    const doc = (await adminDb().doc(`products/${id}`).get()).data()!;
    expect(doc.photoUpdatedBy).toBe(staff.uid);
    expect(doc.photoContentType).toBe("image/png");
    expect(doc.photoSize).toBe(bytes.byteLength);
    expect(String(doc.photoSha256)).toMatch(/^[0-9a-f]{64}$/);
    // Nenhuma URL (assinada ou não) é gravada como endereço da foto.
    expect(JSON.stringify(doc)).not.toMatch(/https?:\/\//);

    const stored = await getObjectStore().get(photoPath);
    expect(Buffer.compare(Buffer.from(stored!.body), bytes)).toBe(0);
    expect(stored!.contentType).toBe("image/png");

    expect((await upload(admin.idToken, id, png(11))).status).toBe(200);
  });

  it("substituir cria uma chave nova, mantém a anterior até confirmar e só então a remove", async () => {
    const id = await newProduct("it-troca");
    const first = ((await (await upload(staff.idToken, id, png(20))).json()) as { photoPath: string }).photoPath;
    const second = ((await (await upload(staff.idToken, id, png(21))).json()) as { photoPath: string }).photoPath;
    expect(second).not.toBe(first);
    expect(await photoPathOf(id)).toBe(second);
    expect(await keysOf(id)).toEqual([second]);
  });

  it("objeto validado nunca é sobrescrito: nova gravação na mesma chave falha e os bytes permanecem", async () => {
    const id = await newProduct("it-imutavel");
    const key = ((await (await upload(staff.idToken, id, png(30))).json()) as { photoPath: string }).photoPath;
    const before = Buffer.from((await getObjectStore().get(key))!.body);
    await expect(getObjectStore().putIfAbsent(key, png(31), { contentType: "image/png" })).rejects.toBeInstanceOf(ObjectExistsError);
    expect(Buffer.compare(Buffer.from((await getObjectStore().get(key))!.body), before)).toBe(0);
  });
});

describe("POST /api/catalog/photo — validação", () => {
  it("rejeita conteúdo que não é imagem, tipo divergente, truncado, vazio e tipo não aceito (422) sem gravar nem alterar o produto", async () => {
    const id = await newProduct("it-invalido");
    const ok = png(40);
    const key = ((await (await upload(staff.idToken, id, ok)).json()) as { photoPath: string }).photoPath;
    const cases: [string, Body, string | null][] = [
      ["svg com tipo png", "<svg onload=alert(1)></svg>", "image/png"],
      ["png declarado como jpeg", ok, "image/jpeg"],
      ["jpeg declarado como png", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9]), "image/png"],
      ["png truncado", ok.subarray(0, ok.length - 20), "image/png"],
      ["vazio", new Uint8Array(0), "image/png"],
      ["svg declarado", "<svg/>", "image/svg+xml"],
      ["gif declarado", "GIF89a", "image/gif"],
      ["sem content-type", ok, null],
    ];
    for (const [label, body, type] of cases) {
      const response = await upload(staff.idToken, id, body, type);
      expect(response.status, label).toBe(422);
    }
    expect(await photoPathOf(id)).toBe(key);
    expect(await keysOf(id)).toEqual([key]);
  });

  it("rejeita dimensões absurdas declaradas no cabeçalho", async () => {
    const id = await newProduct("it-dim");
    const huge = Buffer.from(png(41));
    huge.writeUInt32BE(100000, 16); // largura no IHDR
    expect((await upload(staff.idToken, id, huge)).status).toBe(422);
    expect(await keysOf(id)).toEqual([]);
  });

  it("rejeita acima de 2 MB pelo Content-Length e também com corpo em stream sem Content-Length (413)", async () => {
    const id = await newProduct("it-grande");
    const big = Buffer.concat([png(42), Buffer.alloc(2 * 1024 * 1024)]);
    expect((await upload(staff.idToken, id, big)).status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/catalog/photo?productId=${id}`, {
        method: "POST",
        headers: { "content-type": "image/png", ...auth(staff.idToken) },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(await keysOf(id)).toEqual([]);
  });

  it("valida o produto: inexistente (404), identificador malformado ou ausente (400)", async () => {
    expect((await upload(staff.idToken, "nao-existe", png(43))).status).toBe(404);
    expect((await upload(staff.idToken, "../private", png(43))).status).toBe(400);
    expect((await upload(staff.idToken, "a/b", png(43))).status).toBe(400);
    expect((await upload(staff.idToken, null, png(43))).status).toBe(400);
  });
});

describe("GET /api/catalog/photo — leitura autorizada", () => {
  it("recusa sem token (401), conta sem perfil e conta desativada (403)", async () => {
    expect((await read(null, "prd_exemplo_suco")).status).toBe(401);
    expect((await read("lixo", "prd_exemplo_suco")).status).toBe(401);
    expect((await read(noProfile.idToken, "prd_exemplo_suco")).status).toBe(403);
    const off = await createTestUser("familia-off", "guardian");
    await adminDb().doc(`users/${off.uid}`).update({ status: "disabled" });
    const response = await read(off.idToken, "prd_exemplo_suco");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_inactive" });
  });

  it("qualquer perfil ativo lê; a resposta é imagem com cabeçalhos defensivos e sem URL do bucket", async () => {
    const id = await newProduct("it-leitura");
    const bytes = png(50);
    await upload(staff.idToken, id, bytes);
    for (const user of [guardian, student, secretaria, staff, admin]) {
      const response = await read(user.idToken, id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(response.headers.get("location")).toBeNull();
      expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), bytes)).toBe(0);
    }
  });

  it("o caminho vem do Firestore: parâmetros extras não leem outro objeto; traversal é recusado", async () => {
    const pao = await read(guardian.idToken, "prd_exemplo_pao", {}, "&path=products/prd_exemplo_suco/demo.png&key=products/prd_exemplo_suco/demo.png");
    const suco = await read(guardian.idToken, "prd_exemplo_suco");
    const paoBytes = Buffer.from(await pao.arrayBuffer());
    expect(paoBytes.equals(Buffer.from(await suco.arrayBuffer()))).toBe(false); // cada produto serve a própria foto
    expect((await read(guardian.idToken, "../etc/passwd")).status).toBe(400);
    expect((await read(guardian.idToken, null, {}, "?path=products/prd_exemplo_suco/demo.png")).status).toBe(400);
  });

  it("revalida com ETag (304 sem ler o bucket) e muda de ETag quando a foto é trocada", async () => {
    const id = await newProduct("it-etag");
    await upload(staff.idToken, id, png(60));
    const first = await read(guardian.idToken, id);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await read(guardian.idToken, id, { "if-none-match": etag })).status).toBe(304);
    await upload(staff.idToken, id, png(61));
    const after = await read(guardian.idToken, id, { "if-none-match": etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
  });

  it("produto sem foto, inexistente ou com objeto ausente: 404 (a interface mostra o fallback)", async () => {
    const semFoto = await newProduct("it-sem-foto");
    expect((await read(guardian.idToken, semFoto)).status).toBe(404);
    expect((await read(guardian.idToken, "nao-existe")).status).toBe(404);
    const quebrado = await newProduct("it-quebrado");
    await adminDb().doc(`products/${quebrado}`).update({ photoPath: `products/${quebrado}/${"a".repeat(32)}.png` });
    expect((await read(guardian.idToken, quebrado)).status).toBe(404);
  });
});

describe("falhas entre armazenamento e Firestore", () => {
  const png1 = () => png(70);
  const actorOf = (user: TestUser): Actor => ({ uid: user.uid, role: "cantina", permissions: [] });
  const input = (id: string, body = png1(), beforeRead?: () => Promise<void>) => ({
    productId: id,
    declaredType: "image/png",
    readBody: async () => {
      await beforeRead?.();
      return body;
    },
  });
  const withStore = (over: Partial<ReturnType<typeof getObjectStore>>) => ({ ...getObjectStore(), ...over }) as ReturnType<typeof getObjectStore>;

  it("falha ao gravar no bucket: nada é registrado no Firestore e a foto anterior permanece", async () => {
    const id = await newProduct("it-f-put");
    const first = (await uploadProductPhoto({ db: adminDb(), store: getObjectStore() }, actorOf(staff), input(id))).photoPath;
    const store = withStore({ putIfAbsent: () => Promise.reject(new StorageUnavailableError("R2 indisponível")) });
    await expect(uploadProductPhoto({ db: adminDb(), store }, actorOf(staff), input(id, png(71)))).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(await photoPathOf(id)).toBe(first);
    expect(await keysOf(id)).toEqual([first]);
  });

  it("objeto não confirmado (ausente ou de tamanho diferente) não é registrado e é descartado", async () => {
    for (const [name, head] of [
      ["ausente", async () => null],
      ["tamanho", async (key: string) => ({ ...(await getObjectStore().head(key))!, size: 1 })],
    ] as const) {
      const id = await newProduct(`it-f-head-${name}`);
      const store = withStore({ head });
      await expect(uploadProductPhoto({ db: adminDb(), store }, actorOf(staff), input(id))).rejects.toBeInstanceOf(StorageUnavailableError);
      expect(await photoPathOf(id)).toBeNull();
      expect(await keysOf(id)).toEqual([]);
    }
  });

  it("permissão revogada entre a autenticação e o commit: negado, nada registrado e o objeto novo removido", async () => {
    const id = await newProduct("it-f-revoga");
    const first = (await uploadProductPhoto({ db: adminDb(), store: getObjectStore() }, actorOf(staff), input(id))).photoPath;
    const user = await createTestUser("cantina-revogada", "cantina");
    // O ator "stale" foi autenticado como cantina; durante a leitura do corpo o perfil é rebaixado.
    const demote = () => adminDb().doc(`users/${user.uid}`).update({ role: "guardian" }).then(() => undefined);
    await expect(uploadProductPhoto({ db: adminDb(), store: getObjectStore() }, actorOf(user), input(id, png(72), demote))).rejects.toThrow();
    expect(await photoPathOf(id)).toBe(first);
    expect(await keysOf(id)).toEqual([first]);

    const off = await createTestUser("cantina-desativada", "cantina");
    const disable = () => adminDb().doc(`users/${off.uid}`).update({ status: "disabled" }).then(() => undefined);
    await expect(uploadProductPhoto({ db: adminDb(), store: getObjectStore() }, actorOf(off), input(id, png(73), disable))).rejects.toThrow();
    expect(await keysOf(id)).toEqual([first]);
  });

  it("produto removido durante o envio: commit negado e objeto novo removido (sem foto inexistente registrada)", async () => {
    const id = await newProduct("it-f-sumiu");
    const remove = () => adminDb().doc(`products/${id}`).delete().then(() => undefined);
    await expect(uploadProductPhoto({ db: adminDb(), store: getObjectStore() }, actorOf(staff), input(id, png(74), remove))).rejects.toThrow();
    expect(await keysOf(id)).toEqual([]);
  });

  it("resultado do commit incerto (erro depois de gravar): o objeto é mantido e a referência continua válida", async () => {
    const id = await newProduct("it-f-ambiguo");
    const real = adminDb();
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "runTransaction") {
          return async (...args: Parameters<typeof real.runTransaction>) => {
            await target.runTransaction(...args);
            throw new Error("14 UNAVAILABLE: conexão perdida depois do commit");
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : Reflect.get(target, prop, receiver);
      },
    });
    await expect(uploadProductPhoto({ db: flaky, store: getObjectStore() }, actorOf(staff), input(id, png(75)))).rejects.toThrow("UNAVAILABLE");
    const key = await photoPathOf(id);
    expect(key).toMatch(KEY_PATTERN);
    expect(await keysOf(id)).toEqual([key]); // não apagou uma foto já referenciada
    expect((await read(guardian.idToken, id)).status).toBe(200);
  });

  it("falha ao remover a foto anterior não desfaz a troca; o sweep recolhe o órfão depois da carência", async () => {
    const id = await newProduct("it-f-orfao");
    const first = (await uploadProductPhoto({ db: adminDb(), store: getObjectStore() }, actorOf(staff), input(id))).photoPath;
    const store = withStore({ delete: () => Promise.reject(new StorageUnavailableError("delete falhou")) });
    const second = (await uploadProductPhoto({ db: adminDb(), store }, actorOf(staff), input(id, png(76)))).photoPath;
    expect(await photoPathOf(id)).toBe(second);
    expect(await keysOf(id)).toEqual([first, second].sort());

    const deps = { db: adminDb(), store: getObjectStore() };
    expect((await sweepOrphanPhotos(deps)).orphans).not.toContain(first); // dentro da carência
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const dry = await sweepOrphanPhotos(deps, { now: future });
    expect(dry.orphans).toContain(first);
    expect(dry.orphans).not.toContain(second);
    expect(dry.deleted).toEqual([]);
    expect(await keysOf(id)).toEqual([first, second].sort());
    const applied = await sweepOrphanPhotos(deps, { now: future, apply: true });
    expect(applied.deleted).toContain(first);
    expect(await keysOf(id)).toEqual([second]);
    expect((await read(guardian.idToken, id)).status).toBe(200);
  });

  it("envio interrompido (objeto gravado, produto nunca atualizado) vira órfão e o sweep nunca toca em fotos referenciadas", async () => {
    const id = await newProduct("it-f-crash");
    const referenced = (await uploadProductPhoto({ db: adminDb(), store: getObjectStore() }, actorOf(staff), input(id))).photoPath;
    const stray = `products/${id}/${"b".repeat(32)}.png`;
    await getObjectStore().putIfAbsent(stray, png(77), { contentType: "image/png" });
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const result = await sweepOrphanPhotos({ db: adminDb(), store: getObjectStore() }, { now: future, apply: true });
    expect(result.deleted).toContain(stray);
    expect(result.deleted).not.toContain(referenced);
    expect(await keysOf(id)).toEqual([referenced]);
  });
});

describe("POST /api/admin/storage/sweep", () => {
  const call = (token: string | null, body: unknown) =>
    SWEEP(new Request("http://localhost/api/admin/storage/sweep", { method: "POST", headers: { "content-type": "application/json", ...auth(token) }, body: JSON.stringify(body) }));

  it("somente administração; cantina, secretaria e responsável recebem 403", async () => {
    expect((await call(null, {})).status).toBe(401);
    for (const user of [staff, secretaria, guardian, student]) expect((await call(user.idToken, {})).status).toBe(403);
  });

  it("dry-run por padrão; apply remove só órfãos fora da carência", async () => {
    const id = await newProduct("it-sweep");
    const stray = `products/${id}/${"c".repeat(32)}.png`;
    await getObjectStore().putIfAbsent(stray, png(80), { contentType: "image/png" });
    const dry = (await (await call(admin.idToken, { graceMinutes: 0 })).json()) as { orphans: string[]; deleted: string[] };
    expect(dry.orphans).toContain(stray);
    expect(dry.deleted).toEqual([]);
    expect(await keysOf(id)).toEqual([stray]);
    const applied = (await (await call(admin.idToken, { apply: true, graceMinutes: 0 })).json()) as { deleted: string[] };
    expect(applied.deleted).toContain(stray);
    expect(await keysOf(id)).toEqual([]);
    expect((await call(admin.idToken, { apply: "sim" })).status).toBe(400);
  });
});

describe("armazenamento ausente ou mal configurado", () => {
  it("responde 503 (falha fechada) em produção sem R2 ou sem APP_ENV, sem gravar nem apontar o produto", async () => {
    const id = await newProduct("it-prod");
    for (const value of ["production", undefined]) {
      if (value) process.env.APP_ENV = value;
      else delete process.env.APP_ENV;
      try {
        const up = await upload(staff.idToken, id, png(90));
        expect(up.status).toBe(503);
        expect(await up.json()).toEqual({ error: "storage_unavailable" });
        expect((await read(staff.idToken, "prd_exemplo_suco")).status).toBe(503);
      } finally {
        process.env.APP_ENV = "emulator";
      }
    }
    expect(await keysOf(id)).toEqual([]);
    expect(await photoPathOf(id)).toBeNull();
  });
});
