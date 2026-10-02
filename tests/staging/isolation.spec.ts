// Isolamento entre famílias, papéis, conta desativada, vínculo revogado e consultas — pelas Security Rules PUBLICADAS
// (REST com ID token real) e pelas rotas reais da aplicação. Estrutura criada pelas próprias APIs de administração.
import { expect, test } from "@playwright/test";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { bearer, fsRequest, newKey } from "./helpers";

const tag = Math.random().toString(36).slice(2, 7);
let admin: TestUser;
let famA: TestUser;
let famB: TestUser;
let studentA = "";
let studentB = "";
let classId = "";
let shiftId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  [admin, famA, famB] = await Promise.all([createTestUser("hml-adm", "admin"), createTestUser("hml-fama", "guardian"), createTestUser("hml-famb", "guardian")]);
  const post = async (url: string, data: Record<string, unknown>) => {
    const response = await request.post(url, { headers: bearer(admin.idToken), data });
    expect(response.status(), `${url} ${JSON.stringify(data).slice(0, 80)}`).toBe(200);
    return (await response.json()) as Record<string, string>;
  };
  classId = (await post("/api/school", { key: newKey("cls"), action: "create", kind: "class", name: `HML ${tag}` }))!.id!;
  shiftId = (await post("/api/school", { key: newKey("shf"), action: "create", kind: "shift", name: `Turno ${tag}` }))!.id!;
  studentA = (await post("/api/students", { key: newKey("stu"), action: "create", enrollment: `A${tag}01`, name: `Aluno Alfa ${tag}`, classId, shiftId }))!.studentId!;
  studentB = (await post("/api/students", { key: newKey("stu"), action: "create", enrollment: `B${tag}02`, name: `Aluno Beta ${tag}`, classId, shiftId }))!.studentId!;
  await post("/api/links", { key: newKey("lnk"), action: "add", studentId: studentA, guardianEmail: famA.email, reason: "Homologação" });
  await post("/api/links", { key: newKey("lnk"), action: "add", studentId: studentB, guardianEmail: famB.email, reason: "Homologação" });
});

test("rules publicadas: a família lê só o que é seu e nunca escreve (A33)", async () => {
  // Próprios dados: permitido.
  expect((await fsRequest(famA.idToken, "GET", `students/${studentA}`)).status).toBe(200);
  expect((await fsRequest(famA.idToken, "GET", `studentPolicies/${studentA}`)).status).toBe(200);
  expect((await fsRequest(famA.idToken, "GET", `guardianStudentLinks/${famA.uid}_${studentA}`)).status).toBe(200);
  expect((await fsRequest(famA.idToken, "GET", `users/${famA.uid}`)).status).toBe(200);
  expect((await fsRequest(famA.idToken, "GET", `classes/${classId}`)).status).toBe(200);

  // Dados da outra família: negado em leitura de documento, vínculo, política, perfil e listagens.
  for (const path of [`students/${studentB}`, `studentPolicies/${studentB}`, `guardianStudentLinks/${famB.uid}_${studentB}`, `users/${famB.uid}`, "students", "guardianStudentLinks", "users", "studentPolicies", "uniquenessKeys", "auditLog", "foundationProbes"]) {
    const { status } = await fsRequest(famA.idToken, "GET", path);
    expect(status, `GET ${path}`).toBe(403);
  }
  // Sem login: nada.
  expect((await fsRequest(null, "GET", `students/${studentA}`)).status).toBe(403);

  // Escrita financeira/cadastral/de papel pelo cliente: sempre negada, inclusive nos próprios documentos.
  const str = (value: string) => ({ stringValue: value });
  for (const [path, fields] of [
    [`students/${studentA}`, { name: str("Hackeado") }],
    [`studentPolicies/${studentA}`, { allowSitePurchase: { booleanValue: true } }],
    [`users/${famA.uid}`, { role: str("admin") }],
    [`guardianStudentLinks/${famA.uid}_${studentB}`, { guardianUid: str(famA.uid), studentId: str(studentB), status: str("active") }],
    [`settings/school`, { schoolName: str("x") }],
    [`foundationProbes/${famA.uid}`, { balanceCents: { integerValue: "99999" } }],
  ] as const) {
    const { status } = await fsRequest(famA.idToken, "PATCH", path, fields);
    expect(status, `PATCH ${path}`).toBe(403);
  }
  // Nada mudou.
  const student = await fsRequest(famA.idToken, "GET", `students/${studentA}`);
  expect(JSON.stringify(student.body)).toContain(`Aluno Alfa ${tag}`);
});

test("rotas reais: a família não alcança administração/diretório; sem token = 401 (A30)", async ({ request }) => {
  const calls: [string, string, Record<string, unknown> | undefined][] = [
    ["GET", "/api/students", undefined],
    ["GET", `/api/students/${studentA}`, undefined],
    ["GET", "/api/guardians", undefined],
    ["GET", "/api/school/settings", undefined],
    ["POST", "/api/students", { key: newKey("x"), action: "create", enrollment: "Z1", name: "Zé Silva", classId, shiftId }],
    ["POST", "/api/school", { key: newKey("x"), action: "create", kind: "class", name: "Invasora" }],
    ["POST", "/api/links", { key: newKey("x"), action: "add", studentId: studentB, guardianEmail: famA.email, reason: "invasão" }],
    ["POST", "/api/admin/users", { key: newKey("x"), uid: famA.uid, role: "admin", reason: "escalada" }],
    ["POST", "/api/school/settings", { key: newKey("x"), expectedVersion: 0, schoolName: "X", weekdays: [1], shiftPolicies: {} }],
    ["POST", "/api/admin/storage/sweep", {}],
  ];
  for (const [method, url, data] of calls) {
    const denied = await request.fetch(url, { method, headers: bearer(famA.idToken), data });
    expect(denied.status(), `${method} ${url} (família)`).toBe(403);
    const anonymous = await request.fetch(url, { method, data });
    expect(anonymous.status(), `${method} ${url} (sem token)`).toBe(401);
  }
  // Política do aluno de OUTRA família é negada; a do próprio é aceita.
  const other = await request.post("/api/policies", { headers: bearer(famA.idToken), data: { key: newKey("pol"), studentId: studentB, allowSitePurchase: true } });
  expect(other.status()).toBe(403);
  const own = await request.post("/api/policies", { headers: bearer(famA.idToken), data: { key: newKey("pol"), studentId: studentA, allowSitePurchase: true } });
  expect(own.status()).toBe(200);
  const policy = await fsRequest(famA.idToken, "GET", `studentPolicies/${studentA}`);
  expect(JSON.stringify(policy.body)).toContain('"allowSitePurchase":{"booleanValue":true}');
  const untouched = await fsRequest(famB.idToken, "GET", `studentPolicies/${studentB}`);
  expect(JSON.stringify(untouched.body)).toContain('"allowSitePurchase":{"booleanValue":false}');
});

test("consultas e índices reais: diretório por prefixo/matrícula, paginação, ficha, convites e calendário (A12/A13)", async ({ request }) => {
  const get = async (url: string) => {
    const response = await request.get(url, { headers: bearer(admin.idToken) });
    expect(response.status(), url).toBe(200);
    return (await response.json()) as { students: { id: string }[]; version: number; timezone: string; days: unknown[] };
  };
  const byPrefix = await get(`/api/students?q=${encodeURIComponent(`aluno alfa ${tag}`)}`);
  expect(byPrefix.students.map((s) => s.id)).toEqual([studentA]);
  const byEnrollment = await get(`/api/students?q=B${tag}02`);
  expect(byEnrollment.students.map((s) => s.id)).toContain(studentB);
  const page1 = await get("/api/students?limit=1");
  expect(page1.students).toHaveLength(1);
  const page2 = await get(`/api/students?limit=1&after=${page1.students[0]!.id}`);
  expect(page2.students[0]?.id).not.toBe(page1.students[0]!.id);

  const access = await get(`/api/students/${studentA}`);
  expect(JSON.stringify(access)).toContain(famA.email);
  expect(JSON.stringify(access)).not.toContain(famB.email);

  // Convite de responsável: token só na criação; resgate cria conta real e vincula; reuso é recusado.
  const created = await request.post("/api/invitations", { headers: bearer(admin.idToken), data: { key: newKey("inv"), action: "create", kind: "guardian", studentId: studentA } });
  expect(created.status()).toBe(200);
  const { token } = (await created.json()) as { token: string };
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const list = await get(`/api/invitations?studentId=${studentA}`);
  expect(JSON.stringify(list)).not.toContain(token);
  const redeemed = await request.post("/api/invitations/redeem", { data: { token, email: `mae-hml-${tag}@e2e.example.test`, displayName: "Mãe Homologação", password: "senha-fake-123" } });
  expect(redeemed.status()).toBe(200);
  const again = await request.post("/api/invitations/redeem", { data: { token, email: `outra-hml-${tag}@e2e.example.test`, displayName: "Outra Pessoa", password: "senha-fake-123" } });
  expect(again.status()).toBe(422); // convite de uso único: invitation_invalid

  // Calendário: janela de compra do turno (hoje…hoje+7) e dia fechado. A homologação é compartilhada: os horários dos
  // DEMAIS turnos são mantidos (substituir o mapa deixava os turnos de exemplo sem horário e o portal sem cardápio) e,
  // ao fim, a configuração volta a ser a encontrada (sem acumular um turno por execução; limite de 50 turnos).
  type Settings = { version: number; schoolName: string; weekdays: number[]; shiftPolicies: Record<string, unknown> };
  const settings = (await get("/api/school/settings")) as unknown as Settings;
  const save = (data: Omit<Settings, "version">, expectedVersion: number) =>
    request.post("/api/school/settings", { headers: bearer(admin.idToken), data: { key: newKey("set"), expectedVersion, ...data } });
  const saved = await save(
    { schoolName: `Escola HML ${tag}`, weekdays: [1, 2, 3, 4, 5], shiftPolicies: { ...settings.shiftPolicies, [shiftId]: { purchaseCutoff: "07:00", cancelCutoff: "08:00" } } },
    settings.version,
  );
  expect(saved.status()).toBe(200);
  try {
    const window = await get(`/api/school/calendar?shiftId=${shiftId}`);
    expect(window.timezone).toBe("America/Sao_Paulo");
    expect(window.days.length).toBeGreaterThan(0);
    expect(window.days.length).toBeLessThanOrEqual(8);
    const asFamily = await request.get(`/api/school/calendar?shiftId=${shiftId}`, { headers: bearer(famA.idToken) });
    expect(asFamily.status()).toBe(200);
  } finally {
    const { version } = (await saved.json()) as { version: number };
    const restored = await save({ schoolName: settings.schoolName || `Escola HML ${tag}`, weekdays: settings.weekdays, shiftPolicies: settings.shiftPolicies }, version);
    expect(restored.status()).toBe(200);
  }
});

test("vínculo revogado: negado na hora nas Rules e no servidor; o outro responsável não é afetado (A02/A34)", async ({ request }) => {
  const revoke = await request.post("/api/links", { headers: bearer(admin.idToken), data: { key: newKey("rev"), action: "revoke", studentId: studentA, guardianUid: famA.uid, reason: "Homologação: revogar" } });
  expect(revoke.status()).toBe(200);
  // Mesmo ID token (ainda válido): a decisão vem do vínculo ATUAL.
  expect((await fsRequest(famA.idToken, "GET", `students/${studentA}`)).status).toBe(403);
  expect((await fsRequest(famA.idToken, "GET", `studentPolicies/${studentA}`)).status).toBe(403);
  const policy = await request.post("/api/policies", { headers: bearer(famA.idToken), data: { key: newKey("pol"), studentId: studentA, allowSitePurchase: false } });
  expect(policy.status()).toBe(403);
  expect((await fsRequest(famB.idToken, "GET", `students/${studentB}`)).status).toBe(200);
});

test("conta desativada: servidor recusa o token vigente, Rules fecham e novo login não reabre (A34)", async ({ request }) => {
  const off = await request.post("/api/admin/users", { headers: bearer(admin.idToken), data: { key: newKey("off"), uid: famB.uid, status: "disabled", reason: "Homologação: desativar" } });
  expect(off.status()).toBe(200);
  const denied = await request.get("/api/school/calendar?shiftId=" + shiftId, { headers: bearer(famB.idToken) });
  expect(denied.status()).toBe(401);
  expect((await fsRequest(famB.idToken, "GET", `students/${studentB}`)).status).toBe(403);
  const { signInCloud } = await import("../helpers/cloud.ts");
  const relogin = await signInCloud(famB.email, "senha-fake-123").then(
    (session) => session,
    () => null, // Firebase Auth também recusa a conta desabilitada: igualmente correto.
  );
  if (relogin) {
    expect((await request.get("/api/school/calendar?shiftId=" + shiftId, { headers: bearer(relogin.idToken) })).status()).toBe(401);
    expect((await fsRequest(relogin.idToken, "GET", `students/${studentB}`)).status).toBe(403);
  }
});
