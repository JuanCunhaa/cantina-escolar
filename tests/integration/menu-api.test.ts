// Cardápio por data/turno (F07) contra Auth/Firestore Emulator: autorização, validação, idempotência e concorrência dos
// comandos; leitura canônica de venda dentro de transação; GET autorizado do portal com janela/horário/fuso (relógio
// fixo injetado nas funções do módulo).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request) => Promise<Response>;
let menu: { GET: Handler; POST: Handler };
let products: Handler;
let categories: Handler;
let school: Handler;
let settings: Handler;
let students: Handler;
let links: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let changeMenu: typeof import("@/modules/menu/commands").changeMenu;
let readMenuForSale: typeof import("@/modules/menu/queries").readMenuForSale;
let getMenuWeek: typeof import("@/modules/menu/queries").getMenuWeek;
let loadSettings: typeof import("@/modules/school/settings").loadSettings;
let localDateOf: typeof import("@/lib/dates/school-time").localDateOf;
let addDays: typeof import("@/lib/dates/school-time").addDays;

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let studentUser: TestUser;
let noProfile: TestUser;
let M: string; // turno manhã do teste (fecha compra 07:00)
let T: string; // turno tarde do teste (fecha compra 14:00)
let category: string;
let pDefault: string; // padrão manhã e tarde
let pExtra: string; // fora do padrão; extra em data/turno
let pHidden: string; // padrão manhã; oculto numa data
let pCounter: string; // só balcão, padrão manhã
let pAfternoon: string; // vendido só à tarde
let pInactive: string; // desativado
let studentM: string; // aluno da manhã (responsável A; login do aluno)
let studentT: string; // aluno da tarde (responsável A)

const tag = randomUUID().slice(0, 6);
// Quinta 01/10/2026 09:00 em São Paulo: manhã do dia já encerrada (07:00), tarde ainda aberta (14:00).
const NOW = new Date("2026-10-01T12:00:00Z");
const D_EXTRA = "2026-10-05"; // segunda
const D_SUSP = "2026-10-06"; // terça

function request(method: string, url: string, token: string | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const post = (handler: Handler, token: string | null, body: Record<string, unknown>) => handler(request("POST", "/api", token, { key: randomUUID(), ...body }));
async function ok<T = Record<string, unknown>>(handler: Handler, user: TestUser, body: Record<string, unknown>): Promise<T> {
  const response = await post(handler, user.idToken, body);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return (await response.json()) as T;
}
async function failure(response: Response): Promise<{ status: number; error: string }> {
  return { status: response.status, error: ((await response.json()) as { error: string }).error };
}
const menuGet = (token: string | null, query: string) => menu.GET(request("GET", `/api/menu?${query}`, token));
const data = async (path: string) => (await adminDb().doc(path).get()).data();
const actorOf = (user: TestUser, role: "admin" | "guardian" | "student" | "cantina") => ({ uid: user.uid, role });
const futureDate = (days: number) => addDays(localDateOf(new Date()), days);

let seq = 0;
async function newProduct(name: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const result = await ok<{ id: string }>(products, admin, {
    action: "create",
    name: `${name} ${tag} ${++seq}`,
    description: "Produto de teste (fictício).",
    categoryId: category,
    priceCents: 600,
    channels: ["advance", "counter"],
    shiftIds: [M, T],
    availabilityMode: "planned",
    ...overrides,
  });
  return result.id;
}
const ruleVersion = async (productId: string) => Number((await data(`defaultMenuRules/${productId}`))?.version ?? 0);
const overrideVersion = async (date: string, shiftId: string) => Number((await data(`menuOverrides/${date}__${shiftId}`))?.version ?? 0);
const setDefault = async (productId: string, shiftIds: string[]) =>
  ok(menu.POST, admin, { action: "setDefault", productId, shiftIds, expectedVersion: await ruleVersion(productId) });

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  menu = (await import("@/app/api/menu/route")) as never;
  products = (await import("@/app/api/catalog/products/route")).POST as Handler;
  categories = (await import("@/app/api/catalog/categories/route")).POST as Handler;
  school = (await import("@/app/api/school/route")).POST as Handler;
  settings = (await import("@/app/api/school/settings/route")).POST as Handler;
  students = (await import("@/app/api/students/route")).POST as Handler;
  links = (await import("@/app/api/links/route")).POST as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ changeMenu } = await import("@/modules/menu/commands"));
  ({ readMenuForSale, getMenuWeek } = await import("@/modules/menu/queries"));
  ({ loadSettings } = await import("@/modules/school/settings"));
  ({ localDateOf, addDays } = await import("@/lib/dates/school-time"));
  [admin, cantina, secretaria, guardianA, guardianB, studentUser, noProfile] = await Promise.all([
    createTestUser("adm7", "admin"),
    createTestUser("cantina7", "cantina"),
    createTestUser("secretaria7", "secretaria"),
    createTestUser("resp7a", "guardian"),
    createTestUser("resp7b", "guardian"),
    createTestUser("aluno7", "student"),
    createTestUser("semperfil7"),
  ]);
  M = (await ok<{ id: string }>(school, admin, { action: "create", kind: "shift", name: `Manhã Cardápio ${tag}` })).id;
  T = (await ok<{ id: string }>(school, admin, { action: "create", kind: "shift", name: `Tarde Cardápio ${tag}` })).id;
  const classId = (await ok<{ id: string }>(school, admin, { action: "create", kind: "class", name: `Turma Cardápio ${tag}` })).id;
  // Horários dos turnos do teste e dias de funcionamento seg–sex (demais turnos mantidos).
  const current = await loadSettings(adminDb());
  await ok(settings, admin, {
    expectedVersion: current.version,
    schoolName: current.schoolName || "Escola Teste",
    weekdays: [1, 2, 3, 4, 5],
    shiftPolicies: { ...current.shiftPolicies, [M]: { purchaseCutoff: "07:00", cancelCutoff: "08:00" }, [T]: { purchaseCutoff: "14:00", cancelCutoff: "15:00" } },
  });
  category = (await ok<{ id: string }>(categories, admin, { action: "create", name: `Cardápio ${tag}` })).id;
  pDefault = await newProduct("Suco");
  pExtra = await newProduct("Hot-dog");
  pHidden = await newProduct("Pão de queijo");
  pCounter = await newProduct("Bolo", { channels: ["counter"], shiftIds: [M] });
  pAfternoon = await newProduct("Pipoca", { shiftIds: [T] });
  pInactive = await newProduct("Picolé");
  await ok(products, admin, { action: "deactivate", id: pInactive, reason: "Fora de época" });
  await setDefault(pDefault, [M, T]);
  await setDefault(pHidden, [M]);
  await setDefault(pCounter, [M]);
  for (const [shiftId, name] of [[M, "Ana"], [T, "Beto"]] as const) {
    const enrollment = `C${tag}${shiftId === M ? "1" : "2"}`.toUpperCase();
    const { studentId } = await ok<{ studentId: string }>(students, admin, { action: "create", enrollment, name: `${name} Cardápio ${tag}`, classId, shiftId });
    await ok(links, admin, { action: "add", studentId, guardianEmail: guardianA.email, reason: "Teste do cardápio" });
    if (shiftId === M) studentM = studentId;
    else studentT = studentId;
  }
  // Login do aluno da manhã (como o resgate de convite faz: students.userUid + chave de unicidade).
  await adminDb().doc(`students/${studentM}`).update({ userUid: studentUser.uid });
  await adminDb().doc(`uniquenessKeys/studentLogin_${studentUser.uid}`).set({ studentId: studentM });
  // Exceções no relógio fixo: extra + ocultação em D_EXTRA/manhã e suspensão em D_SUSP/manhã.
  const adm = actorOf(admin, "admin");
  await changeMenu(adminDb(), adm, { key: randomUUID(), action: "setItem", date: D_EXTRA, shiftId: M, productId: pExtra, expectedVersion: 0, include: "extra", limit: 40, reason: "Dia do hot-dog" }, NOW);
  await changeMenu(adminDb(), adm, { key: randomUUID(), action: "setItem", date: D_EXTRA, shiftId: M, productId: pHidden, expectedVersion: 1, include: "hidden", limit: null, reason: "Fornecedor não entrega" }, NOW);
  await changeMenu(adminDb(), adm, { key: randomUUID(), action: "setService", date: D_SUSP, shiftId: M, expectedVersion: 0, suspended: true, reason: "Passeio da escola" }, NOW);
}, 120_000);

describe("F07: autorização dos comandos (A30/A33)", () => {
  it("só a administração altera o cardápio; sem token = 401; sem perfil = 403; nada é gravado", async () => {
    const date = futureDate(12);
    const attempts = [
      { action: "setDefault", productId: pExtra, shiftIds: [M], expectedVersion: 0 },
      { action: "setItem", date, shiftId: M, productId: pExtra, expectedVersion: 0, include: "extra", limit: null },
      { action: "setService", date, shiftId: M, expectedVersion: 0, suspended: true, reason: "Golpe" },
    ];
    for (const user of [cantina, secretaria, guardianA, studentUser, noProfile]) {
      for (const body of attempts) expect((await post(menu.POST, user.idToken, body)).status).toBe(403);
    }
    for (const body of attempts) expect((await post(menu.POST, null, body)).status).toBe(401);
    expect(await data(`defaultMenuRules/${pExtra}`)).toBeUndefined();
    expect(await data(`menuOverrides/${date}__${M}`)).toBeUndefined();
  });

  it("administração rebaixada perde o acesso na próxima chamada, com o mesmo token", async () => {
    const temp = await createTestUser("adm7-temp", "admin");
    const date = futureDate(13);
    await ok(menu.POST, temp, { action: "setService", date, shiftId: T, expectedVersion: 0, suspended: true, reason: "Teste" });
    await adminDb().doc(`users/${temp.uid}`).update({ role: "cantina" });
    expect((await post(menu.POST, temp.idToken, { action: "setService", date, shiftId: T, expectedVersion: 1, suspended: false })).status).toBe(403);
    expect((await data(`menuOverrides/${date}__${T}`))!.suspended).toBe(true);
  });
});

describe("F07: cardápio padrão", () => {
  it("define turnos com auditoria; replay devolve a mesma resposta; versão antiga, chave reutilizada e referências inválidas são recusadas", async () => {
    const id = await newProduct("Água");
    const key = randomUUID();
    const body = { key, action: "setDefault", productId: id, shiftIds: [T, M, M], expectedVersion: 0 };
    const first = await menu.POST(request("POST", "/api/menu", admin.idToken, body));
    expect(await first.json()).toMatchObject({ id, changed: true, version: 1, replayed: false });
    const replay = await menu.POST(request("POST", "/api/menu", admin.idToken, body));
    expect(await replay.json()).toMatchObject({ id, changed: true, version: 1, replayed: true });
    expect(await failure(await menu.POST(request("POST", "/api/menu", admin.idToken, { ...body, shiftIds: [M] })))).toEqual({ status: 409, error: "idempotency_conflict" });
    expect(await data(`defaultMenuRules/${id}`)).toMatchObject({ productId: id, shiftIds: [M, T].sort(), version: 1, updatedBy: admin.uid });

    expect(await failure(await post(menu.POST, admin.idToken, { action: "setDefault", productId: id, shiftIds: [M], expectedVersion: 0 }))).toEqual({ status: 409, error: "stale_menu" });
    expect(await ok(menu.POST, admin, { action: "setDefault", productId: id, shiftIds: [M, T], expectedVersion: 1 })).toMatchObject({ changed: false, version: 1 });
    expect(await failure(await post(menu.POST, admin.idToken, { action: "setDefault", productId: pAfternoon, shiftIds: [M], expectedVersion: 0 }))).toEqual({ status: 422, error: "shift_not_allowed" });
    expect(await failure(await post(menu.POST, admin.idToken, { action: "setDefault", productId: pInactive, shiftIds: [M], expectedVersion: 0 }))).toEqual({ status: 422, error: "product_inactive" });
    expect(await failure(await post(menu.POST, admin.idToken, { action: "setDefault", productId: "prd_inexistente", shiftIds: [M], expectedVersion: 0 }))).toEqual({ status: 404, error: "product_not_found" });

    // Tirar do padrão (lista vazia) não apaga nada: a regra fica com versão nova e a auditoria guarda antes/depois.
    expect(await ok(menu.POST, admin, { action: "setDefault", productId: id, shiftIds: [], expectedVersion: 1 })).toMatchObject({ changed: true, version: 2 });
    const audit = (await adminDb().collection("auditLog").where("target.id", "==", id).where("action", "==", "menu.default.set").get()).docs.map((d) => d.data());
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.after.appliesTo === "new_orders_only" && a.actorRole === "admin")).toBe(true);
    expect(audit.some((a) => a.before.shiftIds.length === 2 && a.after.shiftIds.length === 0)).toBe(true);
  });
});

describe("F07: exceções por data e turno", () => {
  it("extra só de produto ativo, vendido no turno e fora do padrão; ocultar/limitar exigem produto do padrão; data e turno validados", async () => {
    const date = futureDate(10);
    const v = () => overrideVersion(date, M);
    const item = async (productId: string, include: string, limit: number | null, extra: Record<string, unknown> = {}) =>
      failure(await post(menu.POST, admin.idToken, { action: "setItem", date, shiftId: M, productId, expectedVersion: await v(), include, limit, reason: "Teste", ...extra }));
    expect(await item(pDefault, "extra", null)).toEqual({ status: 409, error: "already_in_default" });
    expect(await item(pAfternoon, "extra", null)).toEqual({ status: 422, error: "shift_not_allowed" });
    expect(await item(pInactive, "extra", null)).toEqual({ status: 422, error: "product_inactive" });
    expect(await item(pExtra, "hidden", null)).toEqual({ status: 422, error: "not_in_default" });
    expect(await item(pExtra, "default", 10)).toEqual({ status: 422, error: "not_in_default" });
    expect(await item("prd_inexistente", "extra", null)).toEqual({ status: 404, error: "product_not_found" });
    expect(await item(pExtra, "extra", null, { shiftId: "shf_inexistente" })).toEqual({ status: 422, error: "shift_unavailable" });
    expect(await item(pExtra, "extra", null, { date: futureDate(-1) })).toEqual({ status: 422, error: "past_date" });
    expect(await item(pExtra, "extra", null, { date: futureDate(401) })).toEqual({ status: 422, error: "too_far" });
    expect(await item(pExtra, "extra", 0)).toEqual({ status: 400, error: "invalid_input" });
    expect(await data(`menuOverrides/${date}__${M}`)).toBeUndefined();

    // Válidos: extra com limite, limite no padrão, e voltar ao padrão remove a entrada (versão sobe a cada mudança).
    await ok(menu.POST, admin, { action: "setItem", date, shiftId: M, productId: pExtra, expectedVersion: 0, include: "extra", limit: 25, reason: "Festa junina" });
    await ok(menu.POST, admin, { action: "setItem", date, shiftId: M, productId: pDefault, expectedVersion: 1, include: "default", limit: 80 });
    expect(await ok(menu.POST, admin, { action: "setItem", date, shiftId: M, productId: pDefault, expectedVersion: 2, include: "default", limit: 80 })).toMatchObject({ changed: false, version: 2 });
    expect(await failure(await post(menu.POST, admin.idToken, { action: "setItem", date, shiftId: M, productId: pDefault, expectedVersion: 1, include: "default", limit: null }))).toEqual({
      status: 409,
      error: "stale_menu",
    });
    await ok(menu.POST, admin, { action: "setItem", date, shiftId: M, productId: pDefault, expectedVersion: 2, include: "default", limit: null });
    expect(await data(`menuOverrides/${date}__${M}`)).toMatchObject({
      date,
      shiftId: M,
      suspended: false,
      version: 3,
      items: { [pExtra]: { include: "extra", limit: 25, reason: "Festa junina" } },
    });
    const audit = (await adminDb().collection("auditLog").where("target.id", "==", `${date}__${M}`).get()).docs.map((d) => d.data());
    expect(audit.map((a) => a.action).sort()).toEqual(["menu.item.set", "menu.item.set", "menu.item.set"]);
    expect(audit.every((a) => a.after.appliesTo === "new_orders_only")).toBe(true);
  });

  it("duas alterações simultâneas na mesma data/turno com a mesma versão: exatamente uma vence (nenhuma perda silenciosa)", async () => {
    const date = futureDate(11);
    const attempt = (productId: string, include: string) =>
      post(menu.POST, admin.idToken, { action: "setItem", date, shiftId: M, productId, expectedVersion: 0, include, limit: null, reason: "Concorrência" });
    const results = await Promise.all([attempt(pExtra, "extra"), attempt(pHidden, "hidden"), attempt(pExtra, "extra")]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const stored = (await data(`menuOverrides/${date}__${M}`))!;
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.items)).toHaveLength(1);
  });

  it("suspender e retomar com motivo e auditoria; ocultar não apaga produto, regra padrão nem outras datas", async () => {
    const date = futureDate(9);
    const productBefore = (await data(`products/${pHidden}`))!;
    await ok(menu.POST, admin, { action: "setItem", date, shiftId: M, productId: pHidden, expectedVersion: 0, include: "hidden", limit: null, reason: "Sem entrega" });
    await ok(menu.POST, admin, { action: "setService", date, shiftId: M, expectedVersion: 1, suspended: true, reason: "Reunião de pais" });
    expect(await data(`menuOverrides/${date}__${M}`)).toMatchObject({ suspended: true, serviceReason: "Reunião de pais", version: 2 });
    await ok(menu.POST, admin, { action: "setService", date, shiftId: M, expectedVersion: 2, suspended: false });
    expect(await data(`menuOverrides/${date}__${M}`)).toMatchObject({ suspended: false, serviceReason: "", version: 3, items: { [pHidden]: { include: "hidden" } } });
    const actions = (await adminDb().collection("auditLog").where("target.id", "==", `${date}__${M}`).get()).docs.map((d) => d.data().action);
    expect(actions.sort()).toEqual(["menu.item.set", "menu.service.resume", "menu.service.suspend"]);

    expect((await data(`products/${pHidden}`))!.version).toBe(productBefore.version);
    expect((await data(`defaultMenuRules/${pHidden}`))!.shiftIds).toEqual([M]);
    const sale = await adminDb().runTransaction((tx) => readMenuForSale(adminDb(), tx, { date: futureDate(8), shiftId: M, channel: "advance", productIds: [pHidden] }));
    expect(sale.get(pHidden)).toMatchObject({ ok: true, source: "default" });
  });
});

describe("F07: leitura canônica de venda no servidor (A15)", () => {
  const sale = (date: string, shiftId: string, productIds: string[], channel: "advance" | "counter" = "advance") =>
    adminDb().runTransaction((tx) => readMenuForSale(adminDb(), tx, { date, shiftId, channel, productIds }));

  it("extra vendável SOMENTE na data e no turno configurados; oculto e fora do cardápio recusados mesmo com ID manual", async () => {
    const extraDay = await sale(D_EXTRA, M, [pExtra, pHidden, pDefault, pCounter, "prd_inexistente", "../x"]);
    expect(extraDay.get(pExtra)).toMatchObject({ ok: true, source: "extra", limit: 40, product: { priceCents: 600, priceVersion: 1 } });
    expect(extraDay.get(pHidden)).toEqual({ ok: false, reason: "not_on_menu" });
    expect(extraDay.get(pDefault)).toMatchObject({ ok: true, source: "default", limit: null });
    expect(extraDay.get(pCounter)).toEqual({ ok: false, reason: "channel_not_allowed" });
    expect(extraDay.get("prd_inexistente")).toEqual({ ok: false, reason: "product_not_found" });
    expect(extraDay.get("../x")).toEqual({ ok: false, reason: "product_not_found" });
    expect((await sale(D_EXTRA, M, [pCounter], "counter")).get(pCounter)).toMatchObject({ ok: true, source: "default" });

    // Outra data (mesmo turno) e outro turno (mesma data): o extra não existe; o oculto volta.
    const otherDay = await sale("2026-10-02", M, [pExtra, pHidden]);
    expect(otherDay.get(pExtra)).toEqual({ ok: false, reason: "not_on_menu" });
    expect(otherDay.get(pHidden)).toMatchObject({ ok: true, source: "default" });
    expect((await sale(D_EXTRA, T, [pExtra])).get(pExtra)).toEqual({ ok: false, reason: "not_on_menu" });
    // Suspensão: nada é vendido na data/turno; desativado continua recusado pelo catálogo.
    expect((await sale(D_SUSP, M, [pDefault])).get(pDefault)).toEqual({ ok: false, reason: "service_suspended" });
    expect((await sale(D_EXTRA, M, [pInactive])).get(pInactive)).toEqual({ ok: false, reason: "product_inactive" });
    await expect(sale("2026-02-30", M, [pDefault])).rejects.toMatchObject({ code: "invalid_date" });
  });
});

describe("F07: cardápio do portal — GET autorizado (A12/A14/A15)", () => {
  it("responsável vinculado e equipe leem; outra família, aluno de outro cadastro, sem perfil e sem token não", async () => {
    const own = await menuGet(guardianA.idToken, `studentId=${studentM}`);
    expect(own.status).toBe(200);
    const week = (await own.json()) as { days: unknown[]; student: { id: string; shiftId: string }; canPurchase: boolean };
    expect(week.days).toHaveLength(8);
    expect(week.student).toMatchObject({ id: studentM, shiftId: M });
    expect(week.canPurchase).toBe(true);

    const self = (await (await menuGet(studentUser.idToken, "")).json()) as { student: { id: string }; canPurchase: boolean };
    expect(self.student.id).toBe(studentM);
    expect(self.canPurchase).toBe(false); // aluno sem permissão de compra pelo site: só consulta
    expect((await menuGet(studentUser.idToken, `studentId=${studentT}`)).status).toBe(403);
    const staff = (await (await menuGet(cantina.idToken, `studentId=${studentM}`)).json()) as { canPurchase: boolean };
    expect(staff.canPurchase).toBe(false);

    expect((await menuGet(guardianB.idToken, `studentId=${studentM}`)).status).toBe(403);
    expect((await menuGet(guardianB.idToken, "studentId=stu_inexistente")).status).toBe(403);
    expect((await menuGet(noProfile.idToken, `studentId=${studentM}`)).status).toBe(403);
    expect(await failure(await menuGet(guardianA.idToken, ""))).toEqual({ status: 422, error: "student_required" });
    expect((await menuGet(null, `studentId=${studentM}`)).status).toBe(401);
  });

  it("semana do aluno da manhã: extra só na data configurada, oculto some só nela, suspensão e dia sem funcionamento bloqueiam; nada interno vaza", async () => {
    const week = await getMenuWeek(adminDb(), actorOf(guardianA, "guardian"), { studentId: studentM, date: null }, NOW);
    expect(week.today).toBe("2026-10-01");
    expect(week.days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    const day = (date: string) => week.days.find((d) => d.date === date)!;
    const items = (date: string) => day(date).items.map((i) => `${i.productId === pExtra ? "extra" : i.productId === pHidden ? "pao" : i.productId === pDefault ? "suco" : i.productId === pCounter ? "bolo" : i.productId}:${i.source}${i.limited ? ":limitado" : ""}`).sort();

    // Hoje 09:00: a compra antecipada da manhã fechou às 07:00 — o cardápio é exibido, a compra não.
    expect(day("2026-10-01")).toMatchObject({ service: "open", allowed: false, reason: "after_cutoff", purchaseCutoffAt: null });
    expect(items("2026-10-01")).toEqual(["bolo:default", "pao:default", "suco:default"]);
    // Amanhã continua permitido, com o prazo de compra e de cancelamento informados em UTC.
    expect(day("2026-10-02")).toMatchObject({ allowed: true, reason: null, purchaseCutoffAt: "2026-10-02T10:00:00.000Z", cancelCutoffAt: "2026-10-02T11:00:00.000Z" });
    expect(items("2026-10-02")).toEqual(["bolo:default", "pao:default", "suco:default"]);
    // Fim de semana: sem funcionamento, sem itens.
    expect(day("2026-10-03")).toMatchObject({ operating: false, service: "closed", allowed: false, reason: "non_operating_day", items: [] });
    // Data do extra: hot-dog limitado aparece e o pão (oculto) some.
    expect(items(D_EXTRA)).toEqual(["bolo:default", "extra:extra:limitado", "suco:default"]);
    // Suspensão do atendimento.
    expect(day(D_SUSP)).toMatchObject({ service: "suspended", allowed: false, reason: "service_suspended", items: [] });
    // Hoje+7 continua dentro da janela.
    expect(day("2026-10-08")).toMatchObject({ allowed: true });

    expect(week.products.map((p) => p.id).sort()).toEqual([pCounter, pDefault, pExtra, pHidden].sort());
    const json = JSON.stringify(week);
    for (const internal of ["Fornecedor não entrega", "Dia do hot-dog", "Passeio da escola", "serviceReason", "updatedBy", "defaultSupplier", "internalNotes"]) {
      expect(json).not.toContain(internal);
    }
  });

  it("turno é do aluno: o aluno da tarde não vê o extra nem o padrão da manhã e compra hoje até 14:00", async () => {
    const week = await getMenuWeek(adminDb(), actorOf(guardianA, "guardian"), { studentId: studentT, date: null }, NOW);
    const today = week.days[0]!;
    expect(today).toMatchObject({ date: "2026-10-01", allowed: true, purchaseCutoffAt: "2026-10-01T17:00:00.000Z" });
    for (const d of week.days.filter((x) => x.service === "open")) expect(d.items.map((i) => i.productId)).toEqual([pDefault]);
    expect(week.days.find((d) => d.date === D_EXTRA)!.items.map((i) => i.productId)).not.toContain(pExtra);
  });

  it("janela: hoje+7 pode, hoje+8 e passado não; fuso: 23:30 locais ainda são hoje", async () => {
    const actor = actorOf(guardianA, "guardian");
    const one = await getMenuWeek(adminDb(), actor, { studentId: studentM, date: "2026-10-08" }, NOW);
    expect(one.days.map((d) => d.date)).toEqual(["2026-10-08"]);
    await expect(getMenuWeek(adminDb(), actor, { studentId: studentM, date: "2026-10-09" }, NOW)).rejects.toMatchObject({ code: "beyond_window" });
    await expect(getMenuWeek(adminDb(), actor, { studentId: studentM, date: "2026-09-30" }, NOW)).rejects.toMatchObject({ code: "past_date" });
    await expect(getMenuWeek(adminDb(), actor, { studentId: studentM, date: "2026-02-30" }, NOW)).rejects.toMatchObject({ code: "invalid_date" });
    // 01/10 23:30 em São Paulo = 02/10 02:30 UTC: o servidor ainda trata 01/10 como hoje.
    const late = await getMenuWeek(adminDb(), actor, { studentId: studentM, date: null }, new Date("2026-10-02T02:30:00Z"));
    expect(late.today).toBe("2026-10-01");
    expect(late.days.at(-1)!.date).toBe("2026-10-08");
    const midnight = await getMenuWeek(adminDb(), actor, { studentId: studentM, date: null }, new Date("2026-10-02T03:00:00Z"));
    expect(midnight.today).toBe("2026-10-02");
    // Pela rota: data fora da janela recusada com o relógio real.
    expect(await failure(await menuGet(guardianA.idToken, `studentId=${studentM}&date=${futureDate(8)}`))).toEqual({ status: 422, error: "beyond_window" });
    expect((await menuGet(guardianA.idToken, `studentId=${studentM}&date=${futureDate(7)}`)).status).toBe(200);
  });

  it("vínculo revogado perde a leitura na hora; aluno inativo continua visível ao responsável, sem compra", async () => {
    const guardianC = await createTestUser("resp7c", "guardian");
    await ok(links, admin, { action: "add", studentId: studentT, guardianEmail: guardianC.email, reason: "Teste" });
    expect((await menuGet(guardianC.idToken, `studentId=${studentT}`)).status).toBe(200);
    await ok(links, admin, { action: "revoke", studentId: studentT, guardianUid: guardianC.uid, reason: "Teste" });
    expect((await menuGet(guardianC.idToken, `studentId=${studentT}`)).status).toBe(403);

    await adminDb().doc(`students/${studentT}`).update({ status: "inactive" });
    try {
      const week = (await (await menuGet(guardianA.idToken, `studentId=${studentT}`)).json()) as { canPurchase: boolean; student: { active: boolean } };
      expect(week).toMatchObject({ canPurchase: false, student: { active: false } });
    } finally {
      await adminDb().doc(`students/${studentT}`).update({ status: "active" });
    }
  });
});
