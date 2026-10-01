import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetPasswordViaEmulator,
  seedStudentAccess,
  setCustomClaims,
  signInTestUser,
  TEST_PASSWORD,
  type TestUser,
} from "../helpers/auth-emulator";

type Handler = (request: Request) => Promise<Response>;
let adminUsers: Handler;
let revokeSession: Handler;
let photo: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let adminAuth: typeof import("@/lib/firebase/admin").adminAuth;
let authorizeStudent: typeof import("@/modules/access/authorize").authorizeStudent;
let ForbiddenError: typeof import("@/modules/access/errors").ForbiddenError;
let appendAudit: typeof import("@/modules/audit/log").appendAudit;

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardian: TestUser;
let student: TestUser;
let noProfile: TestUser;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  process.env.FIREBASE_STORAGE_BUCKET = "demo-cantina.appspot.com";
  ({ POST: adminUsers } = await import("@/app/api/admin/users/route"));
  ({ POST: revokeSession } = await import("@/app/api/session/revoke/route"));
  ({ POST: photo } = await import("@/app/api/catalog/photo/route"));
  ({ adminDb, adminAuth } = await import("@/lib/firebase/admin"));
  ({ authorizeStudent } = await import("@/modules/access/authorize"));
  ({ ForbiddenError } = await import("@/modules/access/errors"));
  ({ appendAudit } = await import("@/modules/audit/log"));
  admin = await createTestUser("adm", "admin");
  cantina = await createTestUser("cantina", "cantina");
  secretaria = await createTestUser("secretaria", "secretaria");
  guardian = await createTestUser("responsavel", "guardian");
  student = await createTestUser("aluno", "student");
  noProfile = await createTestUser("sem-perfil");
  await adminDb().doc("demoProducts/it-produto").set({ name: "Produto de teste", isDemo: true });
});

function post(handler: Handler, url: string, token: string | null, body: unknown): Promise<Response> {
  return handler(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

const grant = (token: string | null, body: Record<string, unknown>) =>
  post(adminUsers, "/api/admin/users", token, { key: randomUUID(), reason: "Teste de acesso", ...body });

/** Chamada que só passa pela autorização se o ator for equipe de fotos: autorizado => 422 (arquivo inexistente), negado => 401/403. */
const photoProbe = (token: string) =>
  post(photo, "/api/catalog/photo", token, { productId: "it-produto", path: "products/it-produto/inexistente.png" });

async function profileOf(uid: string) {
  return (await adminDb().doc(`users/${uid}`).get()).data();
}

describe("POST /api/admin/users — só a administração gerencia acesso (A30/A33)", () => {
  it("sem token ou com token inválido: 401", async () => {
    expect((await grant(null, { uid: guardian.uid, role: "admin" })).status).toBe(401);
    expect((await grant("lixo", { uid: guardian.uid, role: "admin" })).status).toBe(401);
  });

  it("aluno, responsável, cantina, secretaria e conta sem perfil: 403 e nada muda", async () => {
    for (const user of [student, guardian, cantina, secretaria, noProfile]) {
      const response = await grant(user.idToken, { uid: user.uid, role: "admin" });
      expect(response.status, user.email).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect((await profileOf(guardian.uid))?.role).toBe("guardian");
    expect(await profileOf(noProfile.uid)).toBeUndefined();
  });

  it("claim de papel (inclusive forjada/antiga) não concede nada: vale só o perfil atual", async () => {
    const forged = await createTestUser("forjado");
    await setCustomClaims(forged.uid, { role: "admin" });
    const token = (await signInTestUser(forged.email)).idToken; // novo token já carrega a claim
    expect((await grant(token, { uid: forged.uid, role: "admin" })).status).toBe(403);
    expect((await photoProbe(token)).status).toBe(403);
  });

  it("dados de entrada inválidos: 400 sem alterar nada", async () => {
    expect((await grant(admin.idToken, { role: "cantina" })).status).toBe(400); // sem uid/email
    expect((await grant(admin.idToken, { uid: guardian.uid, email: "a@example.test", role: "cantina" })).status).toBe(400);
    expect((await grant(admin.idToken, { uid: guardian.uid, role: "root" })).status).toBe(400);
    expect((await grant(admin.idToken, { uid: guardian.uid, role: "cantina", reason: "" })).status).toBe(400);
    expect((await profileOf(guardian.uid))?.role).toBe("guardian");
  });

  it("conta inexistente: 404; papel obrigatório ao criar e permissões extras só da secretaria: 422", async () => {
    expect((await grant(admin.idToken, { uid: "naoexiste123", role: "cantina" })).status).toBe(404);
    expect((await grant(admin.idToken, { email: `novo-${randomUUID().slice(0, 8)}@example.test` })).status).toBe(422);
    expect((await grant(admin.idToken, { uid: cantina.uid, permissions: ["topup.reverse"] })).status).toBe(422);
    expect((await profileOf(cantina.uid))?.permissions).toEqual([]);
  });
});

describe("criação de acesso, auditoria e idempotência", () => {
  it("cria conta + perfil, audita antes/depois e o funcionário define a senha pela recuperação", async () => {
    const email = `func-${randomUUID().slice(0, 8)}@example.test`;
    const key = randomUUID();
    const body = { key, email, displayName: "Funcionária Nova", role: "secretaria", reason: "Contratação" };
    const response = await post(adminUsers, "/api/admin/users", admin.idToken, body);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { uid: string; changed: boolean; replayed: boolean };
    expect(result).toMatchObject({ changed: true, replayed: false });

    const profile = await profileOf(result.uid);
    expect(profile).toMatchObject({ email, displayName: "Funcionária Nova", role: "secretaria", status: "active", permissions: [], accessVersion: 1 });

    const audit = (await adminDb().doc(`auditLog/${admin.uid}__access__${key}`).get()).data();
    expect(audit).toMatchObject({
      action: "access.set",
      actorUid: admin.uid,
      actorRole: "admin",
      target: { type: "user", id: result.uid },
      reason: "Contratação",
      before: null,
      after: { role: "secretaria", status: "active", permissions: [], accessVersion: 1 },
    });
    expect(audit?.createdAt).toBeDefined();
    expect(JSON.stringify(audit)).not.toMatch(/password|senha/i);

    // A conta nasceu com senha aleatória descartada: a pessoa cria a própria senha pelo fluxo de recuperação.
    await expect(signInTestUser(email)).rejects.toThrow();
    await resetPasswordViaEmulator(email, TEST_PASSWORD);
    const user = await signInTestUser(email);
    expect(user.uid).toBe(result.uid);
    // Já entra com o papel concedido (perfil), sem depender de claim.
    expect((await grant(user.idToken, { uid: guardian.uid, role: "admin" })).status).toBe(403);
  });

  it("replay devolve o mesmo resultado sem duplicar perfil/auditoria; payload diferente com a mesma chave: 409", async () => {
    const key = randomUUID();
    const target = await createTestUser("replay", "guardian");
    const body = { key, uid: target.uid, role: "student", reason: "Ativação de acesso do aluno" };
    const first = await post(adminUsers, "/api/admin/users", admin.idToken, body);
    expect(first.status).toBe(200);
    const again = await post(adminUsers, "/api/admin/users", admin.idToken, body);
    expect(await again.json()).toMatchObject({ uid: target.uid, changed: true, replayed: true });
    expect((await profileOf(target.uid))?.accessVersion).toBe(2); // criado em 1, alterado uma vez
    const audits = await adminDb().collection("auditLog").where("target.id", "==", target.uid).where("action", "==", "access.set").get();
    expect(audits.size).toBe(1);

    const conflict = await post(adminUsers, "/api/admin/users", admin.idToken, { ...body, role: "admin" });
    expect(conflict.status).toBe(409);
    expect((await profileOf(target.uid))?.role).toBe("student");
  });

  it("mesma chave em disputa simultânea resulta em uma única alteração e uma única auditoria", async () => {
    const target = await createTestUser("disputa", "guardian");
    const body = { key: randomUUID(), uid: target.uid, role: "student", reason: "Disputa pela mesma chave" };
    const responses = await Promise.all(Array.from({ length: 6 }, () => post(adminUsers, "/api/admin/users", admin.idToken, body)));
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect((await profileOf(target.uid))?.accessVersion).toBe(2);
    const audits = await adminDb().collection("auditLog").where("target.id", "==", target.uid).get();
    expect(audits.size).toBe(1);
  });

  it("alteração sem efeito não grava perfil nem auditoria", async () => {
    const target = await createTestUser("semefeito", "cantina");
    const response = await grant(admin.idToken, { uid: target.uid, role: "cantina" });
    expect(await response.json()).toMatchObject({ changed: false });
    expect((await profileOf(target.uid))?.accessVersion).toBe(1);
    const audits = await adminDb().collection("auditLog").where("target.id", "==", target.uid).get();
    expect(audits.size).toBe(0);
  });

  it("auditoria é append-only: repetir o mesmo id não sobrescreve", async () => {
    const id = `teste__${randomUUID()}`;
    const entry = { action: "teste.um", actorUid: "u", actorRole: null, target: { type: "x", id: "1" } };
    await appendAudit(adminDb(), id, entry);
    await appendAudit(adminDb(), id, { ...entry, action: "teste.dois" });
    expect((await adminDb().doc(`auditLog/${id}`).get()).get("action")).toBe("teste.um");
  });
});

describe("remoção de permissão e revogação: efeito imediato no servidor (comportamento formal)", () => {
  it("rebaixar o papel nega a próxima chamada com o MESMO token; promover devolve; sem novo login", async () => {
    const user = await createTestUser("rebaixa", "cantina");
    expect((await photoProbe(user.idToken)).status).toBe(422); // autorizado (falha só por arquivo inexistente)

    expect((await grant(admin.idToken, { uid: user.uid, role: "guardian", reason: "Mudança de função" })).status).toBe(200);
    expect((await photoProbe(user.idToken)).status).toBe(403);

    expect((await grant(admin.idToken, { uid: user.uid, role: "cantina", reason: "Volta à função" })).status).toBe(200);
    expect((await photoProbe(user.idToken)).status).toBe(422);
  });

  it("permissão extra de estorno é concedida/retirada e vale só para a secretaria", async () => {
    const user = await createTestUser("estorno", "secretaria");
    expect((await grant(admin.idToken, { uid: user.uid, permissions: ["topup.reverse"] })).status).toBe(200);
    expect((await profileOf(user.uid))?.permissions).toEqual(["topup.reverse"]);
    expect((await grant(admin.idToken, { uid: user.uid, permissions: [] })).status).toBe(200);
    expect((await profileOf(user.uid))?.permissions).toEqual([]);
    // Trocar para outro papel com a permissão ainda no perfil é recusado.
    await grant(admin.idToken, { uid: user.uid, permissions: ["topup.reverse"] });
    expect((await grant(admin.idToken, { uid: user.uid, role: "cantina" })).status).toBe(422);
  });

  it("desativar encerra o acesso: Auth desabilitado, token antigo 401, novo login impossível; reativar exige novo login", async () => {
    const user = await createTestUser("desativa", "cantina");
    await wait(1100); // revogação tem granularidade de segundos
    expect((await photoProbe(user.idToken)).status).toBe(422);

    expect((await grant(admin.idToken, { uid: user.uid, status: "disabled", reason: "Desligamento" })).status).toBe(200);
    expect((await adminAuth().getUser(user.uid)).disabled).toBe(true);
    expect((await photoProbe(user.idToken)).status).toBe(401);
    await expect(signInTestUser(user.email)).rejects.toThrow();

    await wait(1100);
    expect((await grant(admin.idToken, { uid: user.uid, status: "active", reason: "Retorno" })).status).toBe(200);
    expect((await adminAuth().getUser(user.uid)).disabled).toBe(false);
    expect((await photoProbe(user.idToken)).status).toBe(401); // token anterior à revogação continua inválido
    const fresh = await signInTestUser(user.email);
    expect((await photoProbe(fresh.idToken)).status).toBe(422);
  });

  it("perfil desativado nega mesmo que o Auth ainda aceite o token (perfil atual vence): 403 account_inactive", async () => {
    const user = await createTestUser("inconsistente", "cantina");
    await adminDb().doc(`users/${user.uid}`).update({ status: "disabled" }); // Auth não foi tocado
    const response = await photoProbe(user.idToken);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_inactive" });
    const admin2 = await createTestUser("adm-off", "admin");
    await adminDb().doc(`users/${admin2.uid}`).update({ status: "disabled" });
    expect((await grant(admin2.idToken, { uid: guardian.uid, role: "admin" })).status).toBe(403);
  });

  it("administrador rebaixado no meio da requisição não consegue concluir o comando (perfil do ator relido na transação)", async () => {
    const { setUserAccess } = await import("@/modules/access/users-command");
    const target = await createTestUser("alvo-ator", "guardian");
    const stale = await createTestUser("adm-velho", "admin");
    const staleActor = { uid: stale.uid, role: "admin" as const }; // autenticado como admin antes da mudança
    await adminDb().doc(`users/${stale.uid}`).update({ role: "guardian" });
    await expect(
      setUserAccess({ auth: adminAuth(), db: adminDb() }, staleActor, { key: randomUUID(), uid: target.uid, role: "cantina", reason: "Tentativa tardia" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await profileOf(target.uid))?.role).toBe("guardian");
  });

  it("perfil malformado falha fechado (sem papel)", async () => {
    const user = await createTestUser("malformado", "cantina");
    await adminDb().doc(`users/${user.uid}`).update({ role: "superuser" });
    expect((await photoProbe(user.idToken)).status).toBe(403);
  });
});

describe("POST /api/session/revoke — sair de todos os dispositivos", () => {
  it("401 sem token; com token revoga as sessões do ator e audita", async () => {
    expect((await post(revokeSession, "/api/session/revoke", null, {})).status).toBe(401);

    const user = await createTestUser("saida", "guardian");
    await wait(1100);
    const response = await post(revokeSession, "/api/session/revoke", user.idToken, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    // O token usado deixa de valer em qualquer endpoint.
    expect((await post(revokeSession, "/api/session/revoke", user.idToken, {})).status).toBe(401);
    expect((await photoProbe(user.idToken)).status).toBe(401);
    const audits = await adminDb().collection("auditLog").where("target.id", "==", user.uid).where("action", "==", "session.revoke_all").get();
    expect(audits.size).toBe(1);
    // Novo login funciona (a conta não foi desativada).
    const fresh = await signInTestUser(user.email);
    expect((await photoProbe(fresh.idToken)).status).toBe(403); // responsável: autenticado, sem capacidade de fotos
  });

  it("revoga só o próprio ator: outra conta segue válida", async () => {
    const a = await createTestUser("saida-a", "cantina");
    const b = await createTestUser("saida-b", "cantina");
    await wait(1100);
    await post(revokeSession, "/api/session/revoke", a.idToken, {});
    expect((await photoProbe(a.idToken)).status).toBe(401);
    expect((await photoProbe(b.idToken)).status).toBe(422);
  });
});

describe("autorização de aluno com vínculo/política atuais (A02/A08)", () => {
  const studentId = `it-${randomUUID().slice(0, 8)}`;
  let guardianA: TestUser;
  let guardianB: TestUser;
  let stranger: TestUser;
  let studentUser: TestUser;
  let cantinaUser: TestUser;

  const actorOf = (user: TestUser, role: "guardian" | "student" | "cantina" | "secretaria" | "admin") => ({ uid: user.uid, role });
  const allowed = async (user: TestUser, role: Parameters<typeof actorOf>[1], action: Parameters<typeof authorizeStudent>[3]) => {
    try {
      await authorizeStudent(adminDb(), actorOf(user, role), studentId, action);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError) return false;
      throw error;
    }
  };

  beforeAll(async () => {
    guardianA = await createTestUser("resp-a", "guardian");
    guardianB = await createTestUser("resp-b", "guardian");
    stranger = await createTestUser("estranho", "guardian");
    studentUser = await createTestUser("aluno-login", "student");
    cantinaUser = await createTestUser("pdv", "cantina");
    await seedStudentAccess({
      studentId,
      guardianUids: [guardianA.uid, guardianB.uid],
      studentUid: studentUser.uid,
      allowSitePurchase: true,
      allowCounterPurchase: true,
    });
  });

  it("dois responsáveis administram o mesmo aluno; quem não tem vínculo é negado em leitura e escrita", async () => {
    for (const g of [guardianA, guardianB]) {
      expect(await allowed(g, "guardian", "view")).toBe(true);
      expect(await allowed(g, "guardian", "manage")).toBe(true);
    }
    expect(await allowed(stranger, "guardian", "view")).toBe(false);
    expect(await allowed(stranger, "guardian", "manage")).toBe(false);
    expect(await allowed(stranger, "guardian", "purchase.site")).toBe(false);
  });

  it("identificador de aluno malformado ou inexistente é negado", async () => {
    await expect(authorizeStudent(adminDb(), actorOf(guardianA, "guardian"), "../users/x", "view")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authorizeStudent(adminDb(), actorOf(guardianA, "guardian"), "nao-existe-123", "view")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("revogar o vínculo de um responsável nega na hora, sem afetar o outro", async () => {
    const other = `it-${randomUUID().slice(0, 8)}`;
    await seedStudentAccess({ studentId: other, guardianUids: [guardianA.uid, guardianB.uid] });
    await adminDb().doc(`guardianStudentLinks/${guardianB.uid}_${other}`).update({ status: "revoked" });
    const check = async (g: TestUser) => {
      try {
        await authorizeStudent(adminDb(), actorOf(g, "guardian"), other, "manage");
        return true;
      } catch {
        return false;
      }
    };
    expect(await check(guardianA)).toBe(true);
    expect(await check(guardianB)).toBe(false);
  });

  it("permissão de compra do aluno revogada bloqueia checkout do aluno e PDV autônomo; consulta e responsável seguem", async () => {
    expect(await allowed(studentUser, "student", "purchase.site")).toBe(true);
    expect(await allowed(cantinaUser, "cantina", "purchase.counter")).toBe(true);

    await adminDb().doc(`studentPolicies/${studentId}`).update({ allowSitePurchase: false, allowCounterPurchase: false });
    expect(await allowed(studentUser, "student", "purchase.site")).toBe(false);
    expect(await allowed(cantinaUser, "cantina", "purchase.counter")).toBe(false);
    // Consulta do próprio aluno e compra do responsável não dependem dessa permissão.
    expect(await allowed(studentUser, "student", "view")).toBe(true);
    expect(await allowed(guardianA, "guardian", "purchase.site")).toBe(true);

    await adminDb().doc(`studentPolicies/${studentId}`).update({ allowSitePurchase: true });
    expect(await allowed(studentUser, "student", "purchase.site")).toBe(true);
  });

  it("a mesma decisão vale dentro da transação (vínculo/política lidos antes das escritas)", async () => {
    const result = await adminDb().runTransaction(async (tx) => {
      await authorizeStudent(adminDb(), actorOf(guardianA, "guardian"), studentId, "manage", tx);
      return "ok";
    });
    expect(result).toBe("ok");
    await expect(
      adminDb().runTransaction((tx) => authorizeStudent(adminDb(), actorOf(stranger, "guardian"), studentId, "manage", tx)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("aluno inativo não compra; secretaria e cantina não administram o aluno", async () => {
    const inactive = `it-${randomUUID().slice(0, 8)}`;
    await seedStudentAccess({ studentId: inactive, guardianUids: [guardianA.uid], studentStatus: "inactive", allowCounterPurchase: true });
    await expect(authorizeStudent(adminDb(), actorOf(guardianA, "guardian"), inactive, "purchase.site")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authorizeStudent(adminDb(), actorOf(cantinaUser, "cantina"), inactive, "purchase.counter")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(authorizeStudent(adminDb(), actorOf(guardianA, "guardian"), inactive, "view")).resolves.toBeUndefined();
    expect(await allowed(cantinaUser, "cantina", "manage")).toBe(false);
    expect(await allowed(secretaria, "secretaria", "manage")).toBe(false);
  });
});

describe("último administrador", () => {
  it("o último administrador ativo não pode ser rebaixado nem desativado; em disputa, sobra um", async () => {
    // Isola o cenário: só os administradores criados aqui existem como ativos.
    const admins = await adminDb().collection("users").where("role", "==", "admin").get();
    await Promise.all(admins.docs.map((d) => d.ref.update({ status: "disabled" })));
    const first = await createTestUser("ultimo-a", "admin");
    expect((await grant(first.idToken, { uid: first.uid, role: "guardian" })).status).toBe(409);
    expect((await grant(first.idToken, { uid: first.uid, status: "disabled" })).status).toBe(409);
    expect((await profileOf(first.uid))?.role).toBe("admin");

    const second = await createTestUser("ultimo-b", "admin");
    const [a, b] = await Promise.all([
      grant(first.idToken, { uid: second.uid, role: "guardian" }),
      grant(second.idToken, { uid: first.uid, role: "guardian" }),
    ]);
    // Um dos dois vence; o outro é recusado (administrador já rebaixado: 403, ou último ativo: 409). Nunca os dois.
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect([a.status, b.status].find((s) => s !== 200)).toBeOneOf([403, 409]);
    const remaining = await adminDb().collection("users").where("role", "==", "admin").where("status", "==", "active").get();
    expect(remaining.size).toBe(1);
  });
});
