import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";

let POST: (request: Request) => Promise<Response>;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let adminAuth: typeof import("@/lib/firebase/admin").adminAuth;
let familyA: TestUser;
let familyB: TestUser;

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  ({ POST } = await import("@/app/api/probe/route"));
  ({ adminDb, adminAuth } = await import("@/lib/firebase/admin"));
  familyA = await createTestUser("familia-a");
  familyB = await createTestUser("familia-b");
});

function call(token: string | null, body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

async function balanceOf(uid: string): Promise<number> {
  const snap = await adminDb().doc(`foundationProbes/${uid}`).get();
  return snap.exists ? (snap.get("balanceCents") as number) : 0;
}

describe("POST /api/probe — login + comando servidor com duas contas (A33/A35)", () => {
  it("recusa sem token, com esquema errado e com token inválido", async () => {
    const body = { key: randomUUID(), amountCents: 100 };
    expect((await call(null, body)).status).toBe(401);
    expect((await call("lixo", body)).status).toBe(401);
    const basic = await POST(new Request("http://localhost/api/probe", { method: "POST", headers: { authorization: `Basic ${familyA.idToken}` }, body: JSON.stringify(body) }));
    expect(basic.status).toBe(401);
  });

  it("credita apenas a conta do token; a outra família permanece intacta", async () => {
    const response = await call(familyA.idToken, { key: randomUUID(), amountCents: 500 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ balanceCents: 500, replayed: false });
    expect(await balanceOf(familyA.uid)).toBe(500);
    expect(await balanceOf(familyB.uid)).toBe(0);
  });

  it("uid no payload é ignorado: o ator vem sempre do token", async () => {
    await call(familyB.idToken, { key: randomUUID(), amountCents: 200, uid: familyA.uid });
    expect(await balanceOf(familyB.uid)).toBe(200);
    expect(await balanceOf(familyA.uid)).toBe(500);
  });

  it("valida entrada e mapeia conflito de idempotência", async () => {
    expect((await call(familyA.idToken, { key: "x", amountCents: 100 })).status).toBe(400);
    const key = randomUUID();
    expect((await call(familyA.idToken, { key, amountCents: 100 })).status).toBe(200);
    expect((await call(familyA.idToken, { key, amountCents: 100 })).status).toBe(200);
    expect((await call(familyA.idToken, { key, amountCents: 999 })).status).toBe(409);
    expect(await balanceOf(familyA.uid)).toBe(600);
  });

  it("rota de prova fica indisponível em produção ou sem APP_ENV, mesmo com token válido", async () => {
    const before = await balanceOf(familyA.uid);
    for (const value of ["production", undefined]) {
      if (value) process.env.APP_ENV = value;
      else delete process.env.APP_ENV;
      try {
        expect((await call(familyA.idToken, { key: randomUUID(), amountCents: 100 })).status).toBe(404);
      } finally {
        process.env.APP_ENV = "emulator";
      }
    }
    expect(await balanceOf(familyA.uid)).toBe(before);
  });

  it("token revogado deixa de autorizar o comando", async () => {
    const user = await createTestUser("revogada");
    expect((await call(user.idToken, { key: randomUUID(), amountCents: 100 })).status).toBe(200);
    // A revogação tem granularidade de segundos: só invalida tokens emitidos em segundo anterior.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await adminAuth().revokeRefreshTokens(user.uid);
    expect((await call(user.idToken, { key: randomUUID(), amountCents: 100 })).status).toBe(401);
    expect(await balanceOf(user.uid)).toBe(100);
  });
});
