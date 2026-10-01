import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, signInTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context?: never) => Promise<Response>;
type ParamsHandler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

let school: Handler;
let students: { GET: Handler; POST: Handler };
let importRoute: Handler;
let detail: ParamsHandler;
let policies: Handler;
let links: Handler;
let invitations: { GET: Handler; POST: Handler };
let redeem: Handler;
let guardiansRoute: Handler;
let adminUsersRoute: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let adminAuth: typeof import("@/lib/firebase/admin").adminAuth;
let tokenHash: typeof import("@/modules/guardians/invitations").tokenHash;
let authorizeStudent: typeof import("@/modules/access/authorize").authorizeStudent;
let Timestamp: typeof import("firebase-admin/firestore").Timestamp;

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let outsider: TestUser;
let studentUser: TestUser;
let classId: string;
let class2Id: string;
let shiftId: string;

const tag = randomUUID().slice(0, 6);

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  school = (await import("@/app/api/school/route")).POST as Handler;
  students = (await import("@/app/api/students/route")) as never;
  importRoute = (await import("@/app/api/students/import/route")).POST as Handler;
  detail = (await import("@/app/api/students/[id]/route")).GET as ParamsHandler;
  policies = (await import("@/app/api/policies/route")).POST as Handler;
  links = (await import("@/app/api/links/route")).POST as Handler;
  invitations = (await import("@/app/api/invitations/route")) as never;
  redeem = (await import("@/app/api/invitations/redeem/route")).POST as Handler;
  guardiansRoute = (await import("@/app/api/guardians/route")).GET as Handler;
  adminUsersRoute = (await import("@/app/api/admin/users/route")).POST as Handler;
  ({ adminDb, adminAuth } = await import("@/lib/firebase/admin"));
  ({ tokenHash } = await import("@/modules/guardians/invitations"));
  ({ authorizeStudent } = await import("@/modules/access/authorize"));
  ({ Timestamp } = await import("firebase-admin/firestore"));
  admin = await createTestUser("adm4", "admin");
  cantina = await createTestUser("cantina4", "cantina");
  secretaria = await createTestUser("secretaria4", "secretaria");
  guardianA = await createTestUser("respa", "guardian");
  guardianB = await createTestUser("respb", "guardian");
  outsider = await createTestUser("fora", "guardian");
  studentUser = await createTestUser("alunologin", "student");
  classId = (await unit("class", `Turma ${tag} A`)).id;
  class2Id = (await unit("class", `Turma ${tag} B`)).id;
  shiftId = (await unit("shift", `Manhã ${tag}`)).id;
});

function request(method: string, url: string, token: string | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const post = (handler: Handler, url: string, token: string | null, body: Record<string, unknown>) =>
  handler(request("POST", url, token, { key: randomUUID(), ...body }));
const get = (handler: Handler, url: string, token: string | null) => handler(request("GET", url, token));

async function unit(kind: "class" | "shift", name: string): Promise<{ id: string }> {
  const response = await post(school, "/api/school", admin.idToken, { action: "create", kind, name });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

let enrollmentSeq = 0;
const nextEnrollment = () => `M${tag}${String(++enrollmentSeq).padStart(3, "0")}`.toUpperCase();

async function newStudent(name = "Maria Souza", overrides: Record<string, unknown> = {}): Promise<{ id: string; enrollment: string }> {
  const enrollment = nextEnrollment();
  const response = await post(students.POST, "/api/students", admin.idToken, { action: "create", enrollment, name, classId, shiftId, ...overrides });
  expect(response.status).toBe(200);
  return { id: ((await response.json()) as { studentId: string }).studentId, enrollment };
}

async function link(studentId: string, guardian: TestUser) {
  const response = await post(links, "/api/links", admin.idToken, { action: "add", studentId, guardianEmail: guardian.email, reason: "Teste de vínculo" });
  expect(response.status).toBe(200);
}

const doc = async (path: string) => (await adminDb().doc(path).get()).data();
const auditActions = async (target: string) =>
  (await adminDb().collection("auditLog").where("target.id", "==", target).get()).docs.map((d) => d.data());

describe("turmas e turnos (administração)", () => {
  it("só a administração cria; nome duplicado (mesmo ignorando acento/caixa) é recusado", async () => {
    for (const user of [cantina, secretaria, guardianA]) {
      expect((await post(school, "/api/school", user.idToken, { action: "create", kind: "class", name: `X ${tag}` })).status).toBe(403);
    }
    expect((await post(school, "/api/school", null, { action: "create", kind: "class", name: "Sem token" })).status).toBe(401);
    const dup = await post(school, "/api/school", admin.idToken, { action: "create", kind: "class", name: `turma ${tag} a` });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("name_taken");
  });

  it("renomear libera o nome antigo; arquivar é bloqueado enquanto há aluno ativo", async () => {
    const temp = await unit("class", `Temporária ${tag}`);
    const renamed = await post(school, "/api/school", admin.idToken, { action: "rename", kind: "class", id: temp.id, name: `Renomeada ${tag}` });
    expect(renamed.status).toBe(200);
    expect(await doc(`uniquenessKeys/class_temporaria-${tag}`)).toBeUndefined();
    await unit("class", `Temporária ${tag}`); // nome antigo ficou livre
    const student = await newStudent("Aluno Em Uso", { classId: temp.id });
    const blocked = await post(school, "/api/school", admin.idToken, { action: "archive", kind: "class", id: temp.id });
    expect(blocked.status).toBe(409);
    await post(students.POST, "/api/students", admin.idToken, { action: "update", studentId: student.id, status: "inactive", reason: "Saída da escola" });
    expect((await post(school, "/api/school", admin.idToken, { action: "archive", kind: "class", id: temp.id })).status).toBe(200);
    // Turma arquivada não aceita novo aluno.
    const rejected = await post(students.POST, "/api/students", admin.idToken, { action: "create", enrollment: nextEnrollment(), name: "Novo Aluno", classId: temp.id, shiftId });
    expect(rejected.status).toBe(422);
  });
});

describe("alunos: cadastro, matrícula única, homônimos e arquivamento", () => {
  it("cria aluno com política padrão negada e auditoria; só a administração cadastra", async () => {
    const student = await newStudent("Ana Beatriz Lima");
    expect(await doc(`students/${student.id}`)).toMatchObject({ enrollment: student.enrollment, name: "Ana Beatriz Lima", nameNormalized: "ana beatriz lima", status: "active", userUid: null });
    expect(await doc(`studentPolicies/${student.id}`)).toMatchObject({ allowSitePurchase: false, allowCounterPurchase: false, configVersion: 1 });
    expect((await auditActions(student.id)).map((a) => a.action)).toContain("student.create");
    for (const user of [cantina, secretaria, guardianA]) {
      const denied = await post(students.POST, "/api/students", user.idToken, { action: "create", enrollment: nextEnrollment(), name: "Intruso", classId, shiftId });
      expect(denied.status).toBe(403);
    }
  });

  it("matrícula é única mesmo sob criação concorrente (normalizada: caixa e espaços)", async () => {
    const enrollment = nextEnrollment();
    const attempts = await Promise.all(
      [enrollment, enrollment.toLowerCase(), ` ${enrollment} `].map((e, i) =>
        post(students.POST, "/api/students", admin.idToken, { action: "create", enrollment: e, name: `Aluno Concorrente ${i} Silva`, classId, shiftId }),
      ),
    );
    const statuses = attempts.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const count = await adminDb().collection("students").where("enrollment", "==", enrollment).get();
    expect(count.size).toBe(1);
  });

  it("homônimos com matrículas distintas são aceitos e a busca mostra turma/turno de cada um", async () => {
    const twin1 = await newStudent(`João Silva ${tag}`);
    const twin2 = await newStudent(`João Silva ${tag}`, { classId: class2Id });
    const response = await get(students.GET, `/api/students?q=${encodeURIComponent(`joão silva ${tag}`)}`, cantina.idToken);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { students: { id: string; classId: string; shiftId: string }[] };
    const found = body.students.filter((s) => [twin1.id, twin2.id].includes(s.id));
    expect(found.map((s) => s.classId).sort()).toEqual([classId, class2Id].sort());
    expect(found.every((s) => s.shiftId === shiftId)).toBe(true);
  });

  it("busca por prefixo, matrícula exata e paginação por cursor; só equipe com students.search", async () => {
    const a = await newStudent(`Zeca Busca ${tag}`);
    await newStudent(`Zélia Busca ${tag}`);
    const byPrefix = (await (await get(students.GET, `/api/students?q=z%C3%A9lia%20busca%20${tag}`, secretaria.idToken)).json()) as { students: { name: string }[] };
    expect(byPrefix.students.map((s) => s.name)).toEqual([`Zélia Busca ${tag}`]);
    const byEnrollment = (await (await get(students.GET, `/api/students?q=${a.enrollment.toLowerCase()}`, cantina.idToken)).json()) as { students: { id: string }[] };
    expect(byEnrollment.students.map((s) => s.id)).toContain(a.id);
    const page1 = (await (await get(students.GET, "/api/students?limit=2", admin.idToken)).json()) as { students: { id: string }[]; nextCursor: string | null };
    expect(page1.students).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await (await get(students.GET, `/api/students?limit=2&after=${page1.nextCursor}`, admin.idToken)).json()) as { students: { id: string }[] };
    expect(page2.students.some((s) => page1.students.some((p) => p.id === s.id))).toBe(false);
    for (const user of [guardianA, studentUser, outsider]) expect((await get(students.GET, "/api/students", user.idToken)).status).toBe(403);
    expect((await get(students.GET, "/api/students", null)).status).toBe(401);
  });

  it("alterar turma/turno e arquivar preserva matrícula, vínculos e histórico; replay e payload diferente", async () => {
    const student = await newStudent("Carlos Pereira");
    await link(student.id, guardianA);
    const key = randomUUID();
    const body = { action: "update", key, studentId: student.id, classId: class2Id, reason: "Mudança de turma" };
    const first = await students.POST(request("POST", "/api/students", admin.idToken, body));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ changed: true, scheduleChanged: true, replayed: false });
    const replay = await students.POST(request("POST", "/api/students", admin.idToken, body));
    expect(await replay.json()).toMatchObject({ replayed: true });
    const other = await students.POST(request("POST", "/api/students", admin.idToken, { ...body, classId: classId }));
    expect(other.status).toBe(409);
    expect(await doc(`students/${student.id}`)).toMatchObject({ classId: class2Id, version: 2, enrollment: student.enrollment });
    const audits = (await auditActions(student.id)).filter((a) => a.action === "student.update");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ reason: "Mudança de turma", before: { classId }, after: { classId: class2Id }, actorUid: admin.uid });

    await post(students.POST, "/api/students", admin.idToken, { action: "update", studentId: student.id, status: "inactive", reason: "Arquivado" });
    expect(await doc(`students/${student.id}`)).toMatchObject({ status: "inactive" });
    expect(await doc(`guardianStudentLinks/${guardianA.uid}_${student.id}`)).toMatchObject({ status: "active" });
    // Aluno arquivado ainda é visível ao responsável, mas não pode comprar.
    await expect(authorizeStudent(adminDb(), { uid: guardianA.uid, role: "guardian" }, student.id, "view")).resolves.toBeUndefined();
    await expect(authorizeStudent(adminDb(), { uid: guardianA.uid, role: "guardian" }, student.id, "purchase.site")).rejects.toThrow();
    // Matrícula não é reutilizável por outro cadastro.
    const reuse = await post(students.POST, "/api/students", admin.idToken, { action: "create", enrollment: student.enrollment, name: "Outro Aluno", classId, shiftId });
    expect(reuse.status).toBe(409);
  });
});

describe("vínculos e política: responsáveis equivalentes, sem auto-vínculo (A02/A33)", () => {
  it("dois responsáveis administram a mesma conta; autor auditado; sem vínculo é negado; irmãos independentes (A01 parcial)", async () => {
    const child = await newStudent("Filha Um");
    const sibling = await newStudent("Filho Dois");
    await link(child.id, guardianA);
    await link(child.id, guardianB);
    await link(sibling.id, guardianA);

    const a = await post(policies, "/api/policies", guardianA.idToken, { studentId: child.id, allowSitePurchase: true });
    expect(a.status).toBe(200);
    const b = await post(policies, "/api/policies", guardianB.idToken, { studentId: child.id, allowCounterPurchase: true });
    expect(b.status).toBe(200);
    expect(await doc(`studentPolicies/${child.id}`)).toMatchObject({ allowSitePurchase: true, allowCounterPurchase: true, configVersion: 3 });
    const audits = (await auditActions(child.id)).filter((x) => x.action === "policy.set");
    expect(audits.map((x) => x.actorUid).sort()).toEqual([guardianA.uid, guardianB.uid].sort());
    // Mudança de A vale para a conta do aluno e não afeta o irmão.
    expect(await doc(`studentPolicies/${sibling.id}`)).toMatchObject({ allowSitePurchase: false, allowCounterPurchase: false });

    // Sem vínculo (outro responsável, aluno, cantina, secretaria): negado, sem alterar nada.
    for (const user of [outsider, studentUser, cantina, secretaria]) {
      expect((await post(policies, "/api/policies", user.idToken, { studentId: child.id, allowSitePurchase: false })).status).toBe(403);
    }
    // Responsável de outra criança também não escreve na política do irmão sem vínculo.
    expect((await post(policies, "/api/policies", guardianB.idToken, { studentId: sibling.id, allowSitePurchase: true })).status).toBe(403);
    expect(await doc(`studentPolicies/${child.id}`)).toMatchObject({ allowSitePurchase: true, configVersion: 3 });
    expect(await doc(`studentPolicies/${sibling.id}`)).toMatchObject({ allowSitePurchase: false, configVersion: 1 });
  });

  it("revogar o vínculo nega o responsável de imediato; política com a mesma chave é idempotente", async () => {
    const child = await newStudent("Aluno Revogação");
    await link(child.id, guardianA);
    const key = randomUUID();
    const body = { key, studentId: child.id, allowSitePurchase: true };
    expect((await policies(request("POST", "/api/policies", guardianA.idToken, body))).status).toBe(200);
    const replay = await policies(request("POST", "/api/policies", guardianA.idToken, body));
    expect(await replay.json()).toMatchObject({ replayed: true, configVersion: 2 });
    expect((await policies(request("POST", "/api/policies", guardianA.idToken, { ...body, allowSitePurchase: false }))).status).toBe(409);

    const revoked = await post(links, "/api/links", admin.idToken, { action: "revoke", studentId: child.id, guardianUid: guardianA.uid, reason: "Guarda alterada" });
    expect(revoked.status).toBe(200);
    expect((await post(policies, "/api/policies", guardianA.idToken, { studentId: child.id, allowSitePurchase: false })).status).toBe(403);
    expect(await doc(`studentPolicies/${child.id}`)).toMatchObject({ allowSitePurchase: true });
    expect(await doc(`guardianStudentLinks/${guardianA.uid}_${child.id}`)).toMatchObject({ status: "revoked" }); // nunca apagado
  });

  it("vínculos administrativos: só a administração; conta que não é responsável ou inexistente é recusada", async () => {
    const child = await newStudent("Aluno Vínculos");
    const body = { action: "add", studentId: child.id, guardianEmail: guardianA.email, reason: "Cadastro" };
    for (const user of [guardianA, cantina, secretaria, studentUser]) expect((await post(links, "/api/links", user.idToken, body)).status).toBe(403);
    expect((await post(links, "/api/links", admin.idToken, { ...body, guardianEmail: cantina.email })).status).toBe(422);
    expect((await post(links, "/api/links", admin.idToken, { ...body, guardianEmail: `ninguem-${tag}@example.test` })).status).toBe(404);
    expect((await post(links, "/api/links", admin.idToken, { ...body, studentId: "inexistente" })).status).toBe(404);
    expect(await doc(`guardianStudentLinks/${guardianA.uid}_${child.id}`)).toBeUndefined();
  });

  it("ficha administrativa e diretório de responsáveis são só da administração", async () => {
    const child = await newStudent("Aluno Ficha");
    await link(child.id, guardianB);
    const response = await detail(request("GET", `/api/students/${child.id}`, admin.idToken), { params: Promise.resolve({ id: child.id }) });
    const body = (await response.json()) as { links: { guardianUid: string; email: string }[]; policy: object };
    expect(body.links.map((l) => l.guardianUid)).toEqual([guardianB.uid]);
    for (const user of [cantina, secretaria, guardianB]) {
      expect((await detail(request("GET", `/api/students/${child.id}`, user.idToken), { params: Promise.resolve({ id: child.id }) })).status).toBe(403);
      expect((await get(guardiansRoute, "/api/guardians", user.idToken)).status).toBe(403);
    }
    const directory = (await (await get(guardiansRoute, "/api/guardians", admin.idToken)).json()) as { guardians: { uid: string; studentIds: string[] }[] };
    expect(directory.guardians.find((g) => g.uid === guardianB.uid)?.studentIds).toContain(child.id);
  });
});

describe("convites: uso único, validade e limite (sem auto-vínculo por nome)", () => {
  async function invite(token: string, kind: "guardian" | "student", studentId: string, extra: Record<string, unknown> = {}) {
    return post(invitations.POST, "/api/invitations", token, { action: "create", kind, studentId, ...extra });
  }
  const redeemBody = (token: string, name: string) => ({ token, email: `${name}-${randomUUID().slice(0, 6)}@example.test`, displayName: `Pessoa ${name}`, password: TEST_PASSWORD });

  it("convite de responsável: só a administração cria; token só aparece na criação e só o hash é guardado", async () => {
    const child = await newStudent("Aluno Convite");
    await link(child.id, guardianA);
    for (const user of [guardianA, cantina, secretaria, studentUser, outsider]) expect((await invite(user.idToken, "guardian", child.id)).status).toBe(403);
    const created = await invite(admin.idToken, "guardian", child.id);
    expect(created.status).toBe(200);
    const { token, invitationId } = (await created.json()) as { token: string; invitationId: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitationId).toBe(tokenHash(token));
    const stored = await doc(`invitations/${invitationId}`);
    expect(stored).toMatchObject({ kind: "guardian", studentId: child.id, status: "pending", createdBy: admin.uid });
    expect(JSON.stringify(stored)).not.toContain(token);
    // Replay da mesma chave não devolve o token.
    const key = randomUUID();
    const first = await invitations.POST(request("POST", "/api/invitations", admin.idToken, { key, action: "create", kind: "guardian", studentId: child.id }));
    expect(((await first.json()) as { token?: string }).token).toBeTruthy();
    const replay = (await (await invitations.POST(request("POST", "/api/invitations", admin.idToken, { key, action: "create", kind: "guardian", studentId: child.id }))).json()) as { token?: string; replayed: boolean };
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.token).toBeUndefined();
  });

  it("resgate sem sessão cria conta + vínculo ativo; segundo uso do mesmo token falha; conta nova não vê outro aluno", async () => {
    const child = await newStudent("Aluno Resgate");
    const other = await newStudent("Aluno Alheio");
    const { token } = (await (await invite(admin.idToken, "guardian", child.id)).json()) as { token: string };
    const first = await redeem(request("POST", "/api/invitations/redeem", null, redeemBody(token, "novo")));
    expect(first.status).toBe(200);
    const result = (await first.json()) as { uid: string; accountCreated: boolean };
    expect(result.accountCreated).toBe(true);
    expect(await doc(`users/${result.uid}`)).toMatchObject({ role: "guardian", status: "active" });
    expect(await doc(`guardianStudentLinks/${result.uid}_${child.id}`)).toMatchObject({ status: "active", source: "invitation" });
    await expect(authorizeStudent(adminDb(), { uid: result.uid, role: "guardian" }, child.id, "manage")).resolves.toBeUndefined();
    await expect(authorizeStudent(adminDb(), { uid: result.uid, role: "guardian" }, other.id, "view")).rejects.toThrow();

    const used = await redeem(request("POST", "/api/invitations/redeem", null, redeemBody(token, "segundo")));
    expect(used.status).toBe(422);
    expect(((await used.json()) as { error: string }).error).toBe("invitation_invalid");
    const login = await signInTestUser((await adminAuth().getUser(result.uid)).email!);
    expect(login.uid).toBe(result.uid);
  });

  it("token inválido, adulterado, expirado ou revogado: mesma resposta; nada é criado", async () => {
    const child = await newStudent("Aluno Expira");
    const make = async () => (await (await invite(admin.idToken, "guardian", child.id)).json()) as { token: string; invitationId: string };
    const expired = await make();
    await adminDb().doc(`invitations/${expired.invitationId}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const revokedInv = await make();
    const revoke = await post(invitations.POST, "/api/invitations", admin.idToken, { action: "revoke", invitationId: revokedInv.invitationId });
    expect(revoke.status).toBe(200);
    for (const token of [expired.token, revokedInv.token, "A".repeat(43), "curto", `${expired.token.slice(0, 42)}x`]) {
      const email = `nunca-${randomUUID().slice(0, 6)}@example.test`;
      const response = await redeem(request("POST", "/api/invitations/redeem", null, { token, email, displayName: "Pessoa Nunca", password: TEST_PASSWORD }));
      expect([400, 422]).toContain(response.status);
      await expect(adminAuth().getUserByEmail(email)).rejects.toThrow(); // conta não foi criada
    }
    const links = await adminDb().collection("guardianStudentLinks").where("studentId", "==", child.id).get();
    expect(links.empty).toBe(true);
    const list = (await (await get(invitations.GET, `/api/invitations?studentId=${child.id}`, admin.idToken)).json()) as { invitations: { status: string }[] };
    expect(list.invitations.map((i) => i.status).sort()).toEqual(["expired", "revoked"]);
  });

  it("duas pessoas disputando o mesmo token: exatamente uma vence e a conta da perdedora é removida", async () => {
    const child = await newStudent("Aluno Disputa");
    const { token } = (await (await invite(admin.idToken, "guardian", child.id)).json()) as { token: string };
    const bodies = ["d1", "d2", "d3"].map((n) => redeemBody(token, n));
    const responses = await Promise.all(bodies.map((b) => redeem(request("POST", "/api/invitations/redeem", null, b))));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 422, 422]);
    const winners = await adminDb().collection("guardianStudentLinks").where("studentId", "==", child.id).get();
    expect(winners.size).toBe(1);
    let existing = 0;
    for (const b of bodies) {
      try {
        await adminAuth().getUserByEmail(b.email);
        existing++;
      } catch {
        /* removida */
      }
    }
    expect(existing).toBe(1);
  });

  it("conta já autenticada vincula outro filho; perfil de outro papel não resgata convite de responsável", async () => {
    const child = await newStudent("Aluno Segundo Filho");
    const { token } = (await (await invite(admin.idToken, "guardian", child.id)).json()) as { token: string };
    const wrong = await redeem(request("POST", "/api/invitations/redeem", cantina.idToken, { token }));
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { error: string }).error).toBe("account_role_mismatch");
    const ok = await redeem(request("POST", "/api/invitations/redeem", outsider.idToken, { token }));
    expect(ok.status).toBe(200);
    expect(await doc(`guardianStudentLinks/${outsider.uid}_${child.id}`)).toMatchObject({ status: "active" });
    const again = await redeem(request("POST", "/api/invitations/redeem", outsider.idToken, { token }));
    expect(await again.json()).toMatchObject({ replayed: true });
  });

  it("limite de convites pendentes por aluno e validade máxima", async () => {
    const child = await newStudent("Aluno Limite");
    for (let i = 0; i < 5; i++) expect((await invite(admin.idToken, "guardian", child.id)).status).toBe(200);
    const sixth = await invite(admin.idToken, "guardian", child.id);
    expect(sixth.status).toBe(409);
    expect(((await sixth.json()) as { error: string }).error).toBe("too_many_invitations");
    expect((await invite(admin.idToken, "guardian", child.id, { ttlHours: 24 * 365 })).status).toBe(400);
  });

  it("criação concorrente de convites não ultrapassa o limite de pendentes", async () => {
    const child = await newStudent("Aluno Limite Concorrente");
    const responses = await Promise.all(Array.from({ length: 8 }, () => invite(admin.idToken, "guardian", child.id)));
    const ok = responses.filter((r) => r.status === 200).length;
    expect(responses.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect(ok).toBe(5);
    const pending = await adminDb().collection("invitations").where("studentId", "==", child.id).where("status", "==", "pending").get();
    expect(pending.size).toBe(5);
  }, 90000);

  it("contato do responsável (cadastro por convite) sobrevive a alteração de acesso pela administração", async () => {
    const child = await newStudent("Aluno Contato");
    const { token } = (await (await invite(admin.idToken, "guardian", child.id)).json()) as { token: string };
    const r = await redeem(request("POST", "/api/invitations/redeem", null, { ...redeemBody(token, "contato"), contact: "(11) 90000-0000" }));
    const { uid } = (await r.json()) as { uid: string };
    expect(await doc(`users/${uid}`)).toMatchObject({ contact: "(11) 90000-0000" });
    const changed = await post(adminUsersRoute, "/api/admin/users", admin.idToken, { uid, displayName: "Nome Alterado", reason: "Correção de nome" });
    expect(changed.status).toBe(200);
    expect(await doc(`users/${uid}`)).toMatchObject({ displayName: "Nome Alterado", contact: "(11) 90000-0000", role: "guardian" });
  });

  it("login do aluno: convite pelo responsável vinculado, uso único, aluno só consulta (sem permissão de compra)", async () => {
    const child = await newStudent("Aluno Com Login");
    await link(child.id, guardianA);
    expect((await invite(outsider.idToken, "student", child.id)).status).toBe(403); // responsável sem vínculo
    expect((await invite(cantina.idToken, "student", child.id)).status).toBe(403);
    const created = await invite(guardianA.idToken, "student", child.id);
    expect(created.status).toBe(200);
    const { token, invitationId } = (await created.json()) as { token: string; invitationId: string };
    // Responsável vê e revoga apenas os convites de aluno.
    const seen = (await (await get(invitations.GET, `/api/invitations?studentId=${child.id}`, guardianA.idToken)).json()) as { invitations: { id: string }[] };
    expect(seen.invitations.map((i) => i.id)).toEqual([invitationId]);
    expect((await get(invitations.GET, `/api/invitations?studentId=${child.id}`, outsider.idToken)).status).toBe(403);

    const redeemed = await redeem(request("POST", "/api/invitations/redeem", null, redeemBody(token, "aluno")));
    expect(redeemed.status).toBe(200);
    const { uid } = (await redeemed.json()) as { uid: string };
    expect(await doc(`students/${child.id}`)).toMatchObject({ userUid: uid });
    expect(await doc(`users/${uid}`)).toMatchObject({ role: "student", status: "active" });
    await expect(authorizeStudent(adminDb(), { uid, role: "student" }, child.id, "view")).resolves.toBeUndefined();
    await expect(authorizeStudent(adminDb(), { uid, role: "student" }, child.id, "purchase.site")).rejects.toThrow();
    // Aluno não administra nada: política e convites são negados.
    const studentToken = (await signInTestUser((await adminAuth().getUser(uid)).email!)).idToken;
    expect((await post(policies, "/api/policies", studentToken, { studentId: child.id, allowSitePurchase: true })).status).toBe(403);
    expect((await invite(studentToken, "student", child.id)).status).toBe(403);
    // Aluno já tem login: novo convite recusado; revogar o login libera.
    expect((await invite(guardianA.idToken, "student", child.id)).status).toBe(409);
    const revoked = await post(links, "/api/links", guardianA.idToken, { action: "revokeStudentLogin", studentId: child.id, reason: "Trocar conta" });
    expect(revoked.status).toBe(200);
    expect(await doc(`students/${child.id}`)).toMatchObject({ userUid: null });
    await expect(authorizeStudent(adminDb(), { uid, role: "student" }, child.id, "view")).rejects.toThrow();
    // Responsável sem vínculo não revoga login de outro aluno.
    expect((await post(links, "/api/links", outsider.idToken, { action: "revokeStudentLogin", studentId: child.id, reason: "Tentativa" })).status).toBe(403);
  });

  it("aluno com a conta já usada em outro aluno não resgata segundo convite de login", async () => {
    const s1 = await newStudent("Aluno Login Um");
    const s2 = await newStudent("Aluno Login Dois");
    const t1 = (await (await invite(admin.idToken, "student", s1.id)).json()) as { token: string };
    const t2 = (await (await invite(admin.idToken, "student", s2.id)).json()) as { token: string };
    const r1 = await redeem(request("POST", "/api/invitations/redeem", null, redeemBody(t1.token, "um")));
    const { uid } = (await r1.json()) as { uid: string };
    const token = (await signInTestUser((await adminAuth().getUser(uid)).email!)).idToken;
    const r2 = await redeem(request("POST", "/api/invitations/redeem", token, { token: t2.token }));
    expect(r2.status).toBe(409);
    expect(await doc(`students/${s2.id}`)).toMatchObject({ userUid: null });
  });
});

describe("importação CSV: prévia, validação e duplicidades", () => {
  const header = "matrícula;nome;turma;turno";
  const csvOf = (...lines: string[]) => [header, ...lines].join("\n");
  const importCall = (body: Record<string, unknown>, token = admin.idToken) => importRoute(request("POST", "/api/students/import", token, body));
  const className = `Turma ${tag} A`;
  const shiftName = `Manhã ${tag}`;

  it("só a administração importa; prévia não grava nada", async () => {
    const enrollment = nextEnrollment();
    const csv = csvOf(`${enrollment};Pedro Alves;${className};${shiftName}`);
    for (const user of [cantina, secretaria, guardianA]) expect((await importCall({ mode: "preview", csv }, user.idToken)).status).toBe(403);
    const preview = await importCall({ mode: "preview", csv });
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as { ok: boolean; plan: { summary: { create: number }; rows: { action: string }[] }; digest: string };
    expect(body.plan.summary.create).toBe(1);
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await doc(`uniquenessKeys/enrollment_${enrollment}`)).toBeUndefined();
  });

  it("valida linhas: matrícula/turma/turno inexistentes, repetidas e fórmulas; linhas com erro impedem a confirmação", async () => {
    const dup = nextEnrollment();
    const csv = csvOf(
      `${dup};Ana Dupla;${className};${shiftName}`,
      `${dup};Ana Dupla Repetida;${className};${shiftName}`,
      `;Sem Matrícula;${className};${shiftName}`,
      `${nextEnrollment()};Turma Errada;Turma Fantasma;${shiftName}`,
      `${nextEnrollment()};Turno Errado;${className};Noite`,
      `${nextEnrollment()};=HYPERLINK("x");${className};${shiftName}`,
    );
    const preview = (await (await importCall({ mode: "preview", csv })).json()) as { plan: { rows: { action: string; errors: string[] }[]; summary: { error: number; create: number } }; digest: string };
    expect(preview.plan.summary).toMatchObject({ create: 1, error: 5 });
    expect(preview.plan.rows[1]!.errors.join()).toMatch(/repetida/i);
    const commit = await importCall({ mode: "commit", key: randomUUID(), csv, digest: preview.digest });
    expect(commit.status).toBe(422);
    expect(((await commit.json()) as { error: string }).error).toBe("rows_with_errors");
    expect(await doc(`uniquenessKeys/enrollment_${dup}`)).toBeUndefined();
  });

  it("arquivo inválido: sem colunas obrigatórias, vazio, aspas abertas e acima do limite de linhas", async () => {
    const bad = async (csv: string) => (await (await importCall({ mode: "preview", csv })).json()) as { ok: boolean; error: string };
    expect(await bad("nome;turma\nA;B")).toMatchObject({ ok: false, error: "missing_columns" });
    expect(await bad('matrícula;nome;turma;turno\n1;"Aberta;x;y')).toMatchObject({ ok: false, error: "unterminated_quote" });
    const many = csvOf(...Array.from({ length: 501 }, (_, i) => `L${i};Aluno ${i} Teste;${className};${shiftName}`));
    expect(await bad(many)).toMatchObject({ ok: false, error: "too_many_rows" });
  });

  it("confirma, cria alunos com política negada e auditoria; replay devolve o mesmo resumo; prévia desatualizada é recusada", async () => {
    const e1 = nextEnrollment();
    const e2 = nextEnrollment();
    const csv = csvOf(`${e1};Lucas Prado ${tag};${className};${shiftName}`, `${e2};Lúcia Prado ${tag};${className};${shiftName}`);
    const preview = (await (await importCall({ mode: "preview", csv })).json()) as { digest: string };
    const key = randomUUID();
    const commit = await importCall({ mode: "commit", key, csv, digest: preview.digest });
    expect(commit.status).toBe(200);
    expect(await commit.json()).toMatchObject({ created: 2, failed: 0, replayed: false });
    const created = await adminDb().collection("students").where("enrollment", "in", [e1, e2]).get();
    expect(created.size).toBe(2);
    for (const d of created.docs) {
      expect(await doc(`studentPolicies/${d.id}`)).toMatchObject({ allowSitePurchase: false, allowCounterPurchase: false });
      expect((await auditActions(d.id)).map((a) => a.action)).toContain("student.create");
    }
    const replay = await importCall({ mode: "commit", key, csv, digest: preview.digest });
    expect(await replay.json()).toMatchObject({ created: 2, replayed: true });
    // Mesma chave com outro arquivo: conflito. Outro commit com a prévia antiga (estado mudou): recusado.
    expect((await importCall({ mode: "commit", key, csv: `${csv}\n`, digest: preview.digest })).status).toBe(409);
    const stale = await importCall({ mode: "commit", key: randomUUID(), csv, digest: preview.digest });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("stale_preview");
    expect((await adminDb().collection("students").where("enrollment", "in", [e1, e2]).get()).size).toBe(2);
  });

  it("matrícula já cadastrada: ignora por padrão; 'update' atualiza nome/turma; possível duplicidade exige confirmação", async () => {
    const existing = await newStudent(`Rita Moura ${tag}`);
    const csv = csvOf(`${existing.enrollment};Rita Moura Nova ${tag};${`Turma ${tag} B`};${shiftName}`);
    const skip = (await (await importCall({ mode: "preview", csv })).json()) as { plan: { summary: { skip: number } }; digest: string };
    expect(skip.plan.summary.skip).toBe(1);
    const skipped = await (await importCall({ mode: "commit", key: randomUUID(), csv, digest: skip.digest })).json();
    expect(skipped).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(await doc(`students/${existing.id}`)).toMatchObject({ name: `Rita Moura ${tag}`, classId });

    const upd = (await (await importCall({ mode: "preview", csv, onDuplicate: "update" })).json()) as { plan: { summary: { update: number } }; digest: string };
    expect(upd.plan.summary.update).toBe(1);
    const updated = await (await importCall({ mode: "commit", key: randomUUID(), csv, digest: upd.digest, onDuplicate: "update" })).json();
    expect(updated).toMatchObject({ updated: 1 });
    expect(await doc(`students/${existing.id}`)).toMatchObject({ name: `Rita Moura Nova ${tag}`, classId: class2Id });

    const same = csvOf(`${nextEnrollment()};Rita Moura Nova ${tag};${`Turma ${tag} B`};${shiftName}`);
    const warn = (await (await importCall({ mode: "preview", csv: same })).json()) as { plan: { summary: { warnings: number } }; digest: string };
    expect(warn.plan.summary.warnings).toBe(1);
    const refused = await importCall({ mode: "commit", key: randomUUID(), csv: same, digest: warn.digest });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("warnings_not_accepted");
    const accepted = await importCall({ mode: "commit", key: randomUUID(), csv: same, digest: warn.digest, acceptWarnings: true });
    expect(await accepted.json()).toMatchObject({ created: 1 });
  });

  it("importação de ~300 alunos (volume da escola) conclui e respeita matrícula única", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `V${tag}${String(i).padStart(4, "0")};Aluno Volume ${i} ${tag};${className};${shiftName}`);
    const csv = csvOf(...lines);
    const preview = (await (await importCall({ mode: "preview", csv })).json()) as { plan: { summary: { create: number } }; digest: string };
    expect(preview.plan.summary.create).toBe(300);
    const commit = await importCall({ mode: "commit", key: randomUUID(), csv, digest: preview.digest });
    expect(await commit.json()).toMatchObject({ created: 300, failed: 0 });
    const again = (await (await importCall({ mode: "preview", csv })).json()) as { plan: { summary: { skip: number; create: number } } };
    expect(again.plan.summary).toMatchObject({ skip: 300, create: 0 });
  }, 120000);
});
