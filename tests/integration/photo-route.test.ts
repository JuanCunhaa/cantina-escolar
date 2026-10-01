import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { makePng, seedDemoCatalog, targetFromEnv } from "../../scripts/lib/demo-seed.ts";

let POST: (request: Request) => Promise<Response>;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let adminBucket: typeof import("@/lib/firebase/admin").adminBucket;
let staff: TestUser;
let admin: TestUser;
let secretaria: TestUser;
let guardian: TestUser;

const png = makePng(16, 16, [10, 120, 200]);

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  process.env.FIREBASE_STORAGE_BUCKET = "demo-cantina.appspot.com";
  ({ POST } = await import("@/app/api/catalog/photo/route"));
  ({ adminDb, adminBucket } = await import("@/lib/firebase/admin"));
  staff = await createTestUser("cantina", "cantina");
  admin = await createTestUser("admin", "admin");
  secretaria = await createTestUser("secretaria", "secretaria");
  guardian = await createTestUser("familia");
  await seedDemoCatalog(targetFromEnv());
});

function call(token: string | null, body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/catalog/photo", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

async function put(path: string, data: Buffer, contentType: string): Promise<void> {
  await adminBucket().file(path).save(data, { contentType });
}

async function photoPathOf(id: string): Promise<string | null> {
  return ((await adminDb().doc(`demoProducts/${id}`).get()).get("photoPath") as string | null) ?? null;
}

describe("POST /api/catalog/photo — registro de foto no servidor (A36)", () => {
  it("recusa sem token ou token inválido (401)", async () => {
    const body = { productId: "demo-bolo", path: "products/demo-bolo/a1.png" };
    expect((await call(null, body)).status).toBe(401);
    expect((await call("lixo", body)).status).toBe(401);
  });

  it("recusa responsável e secretaria (403) sem alterar o produto", async () => {
    await put("products/demo-bolo/negado.png", png, "image/png");
    for (const user of [guardian, secretaria]) {
      const response = await call(user.idToken, { productId: "demo-bolo", path: "products/demo-bolo/negado.png" });
      expect(response.status).toBe(403);
    }
    expect(await photoPathOf("demo-bolo")).toBeNull();
  });

  it("funcionário registra foto válida; cantina e admin podem; o ator vem do token", async () => {
    await put("products/demo-bolo/ok1.png", png, "image/png");
    const response = await call(staff.idToken, { productId: "demo-bolo", path: "products/demo-bolo/ok1.png", role: "admin", uid: "outro" });
    expect(response.status).toBe(200);
    expect(await photoPathOf("demo-bolo")).toBe("products/demo-bolo/ok1.png");
    expect((await adminDb().doc("demoProducts/demo-bolo").get()).get("photoUpdatedBy")).toBe(staff.uid);

    await put("products/demo-bolo/ok2.png", png, "image/png");
    expect((await call(admin.idToken, { productId: "demo-bolo", path: "products/demo-bolo/ok2.png" })).status).toBe(200);
    expect(await photoPathOf("demo-bolo")).toBe("products/demo-bolo/ok2.png");
  });

  it("valida entrada: caminho de outro produto, travessia, produto inexistente", async () => {
    await put("products/demo-pao/outro.png", png, "image/png");
    const before = await photoPathOf("demo-suco");
    expect((await call(staff.idToken, { productId: "demo-suco", path: "products/demo-pao/outro.png" })).status).toBe(422);
    expect((await call(staff.idToken, { productId: "demo-suco", path: "products/../private/x.png" })).status).toBe(400);
    expect((await call(staff.idToken, { productId: "inexistente", path: "products/inexistente/a.png" })).status).toBe(404);
    expect((await call(staff.idToken, { productId: "demo-suco" })).status).toBe(400);
    expect(await photoPathOf("demo-suco")).toBe(before);
  });

  it("rejeita e remove arquivo cujo conteúdo não é imagem ou cujo tipo diverge", async () => {
    await put("products/demo-fruta/falso.png", Buffer.from("<svg onload=alert(1)>"), "image/png");
    const before = await photoPathOf("demo-fruta");
    expect((await call(staff.idToken, { productId: "demo-fruta", path: "products/demo-fruta/falso.png" })).status).toBe(422);
    expect((await adminBucket().file("products/demo-fruta/falso.png").exists())[0]).toBe(false);

    await put("products/demo-fruta/tipo.png", png, "image/jpeg");
    expect((await call(staff.idToken, { productId: "demo-fruta", path: "products/demo-fruta/tipo.png" })).status).toBe(422);
    expect(await photoPathOf("demo-fruta")).toBe(before);
  });

  it("rejeita arquivo acima de 2 MB e arquivo inexistente", async () => {
    const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
    await put("products/demo-fruta/grande.png", big, "image/png");
    expect((await call(staff.idToken, { productId: "demo-fruta", path: "products/demo-fruta/grande.png" })).status).toBe(422);
    expect((await call(staff.idToken, { productId: "demo-fruta", path: "products/demo-fruta/nao-existe.png" })).status).toBe(422);
  });

  it("fica indisponível em produção ou sem APP_ENV, mesmo com funcionário válido", async () => {
    await put("products/demo-pao/prod.png", png, "image/png");
    const before = await photoPathOf("demo-pao");
    for (const value of ["production", undefined]) {
      if (value) process.env.APP_ENV = value;
      else delete process.env.APP_ENV;
      try {
        expect((await call(staff.idToken, { productId: "demo-pao", path: "products/demo-pao/prod.png" })).status).toBe(404);
      } finally {
        process.env.APP_ENV = "emulator";
      }
    }
    expect(await photoPathOf("demo-pao")).toBe(before);
  });
});
