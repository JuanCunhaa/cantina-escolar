// Cardápio (F07) pelas rotas reais e pelas Security Rules PUBLICADAS (REST com ID token real): comandos sem permissão
// recusados sem efeito; configuração do cardápio fechada à família (que recebe só o cardápio resolvido pelo servidor);
// leitura autorizada por vínculo; janela hoje…hoje+7; extra/ocultação/suspensão valendo só na data/turno configurados.
// Usa famílias com alunos fictícios e produtos temporários (desativados ao fim); exceções criadas são desfeitas e nada é
// apagado. Os produtos "(exemplo)" só são lidos.
import { expect, test } from "@playwright/test";
import { admin } from "../../scripts/staging/admin.ts";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { createTempProduct, fixtureIds, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { isCloud } from "../helpers/cloud.ts";
import { adminPost, createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

type Week = {
  today: string;
  student: { id: string; shiftId: string };
  days: { date: string; allowed: boolean; service: string; reason: string | null; items: { productId: string; source: string; limited: boolean }[] }[];
};

const tag = Math.random().toString(36).slice(2, 7);
const REASON = `Motivo interno ${tag}`;
let morning: Family;
let afternoon: Family;
let cantina: TestUser;
let secretaria: TestUser;
let studentLogin: TestUser;

test.beforeAll(async ({ request }) => {
  expect(isCloud()).toBe(true);
  morning = await createFamily(request, "hml-menu-manha");
  afternoon = await createFamily(request, "hml-menu-tarde", "Tarde (exemplo)");
  [cantina, secretaria, studentLogin] = await Promise.all([
    createTestUser("hml-menu-cantina", "cantina"),
    createTestUser("hml-menu-sec", "secretaria"),
    createTestUser("hml-menu-aluno", "student"),
  ]);
});

const getWeek = async (request: import("@playwright/test").APIRequestContext, family: Family, query = "") => {
  const response = await request.get(`/api/menu?studentId=${family.studentId}${query}`, { headers: bearer(family.guardian.idToken) });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as Week;
};

test("comandos do cardápio sem permissão são recusados e nada é gravado; configuração fechada à família (A30/A33)", async ({ request }) => {
  const ids = await fixtureIds();
  const suco = ids.product("Suco de laranja (exemplo)");
  const shift = ids.shift("Manhã (exemplo)");
  const week = await getWeek(request, morning);
  const date = week.days.at(-1)!.date;
  const ruleBefore = (await admin().db.doc(`defaultMenuRules/${suco}`).get()).data();
  const overrideBefore = (await admin().db.doc(`menuOverrides/${date}__${shift}`).get()).data();
  const attempts = [
    { action: "setDefault", productId: suco, shiftIds: [], expectedVersion: Number(ruleBefore?.version ?? 0) },
    { action: "setItem", date, shiftId: shift, productId: suco, expectedVersion: Number(overrideBefore?.version ?? 0), include: "hidden", limit: null, reason: "golpe" },
    { action: "setService", date, shiftId: shift, expectedVersion: Number(overrideBefore?.version ?? 0), suspended: true, reason: "golpe" },
  ];
  for (const data of attempts) {
    expect((await request.post("/api/menu", { data: { key: newKey("x"), ...data } })).status(), `${data.action} sem token`).toBe(401);
    for (const [label, user] of [["cantina", cantina], ["secretaria", secretaria], ["família", morning.guardian], ["aluno", studentLogin]] as const) {
      const response = await request.post("/api/menu", { headers: bearer(user.idToken), data: { key: newKey("x"), ...data } });
      expect(response.status(), `${data.action} por ${label}`).toBe(403);
    }
  }
  expect((await admin().db.doc(`defaultMenuRules/${suco}`).get()).data()).toEqual(ruleBefore);
  expect((await admin().db.doc(`menuOverrides/${date}__${shift}`).get()).data()).toEqual(overrideBefore);

  // Rules publicadas: configuração do cardápio só para a operação; escrita direta negada a todos (inclusive administração).
  for (const user of [morning.guardian, studentLogin, secretaria]) {
    for (const path of [`defaultMenuRules/${suco}`, "defaultMenuRules", "menuOverrides"]) {
      expect((await fsRequest(user.idToken, "GET", path)).status, `GET ${path}`).toBe(403);
    }
  }
  expect((await fsRequest(cantina.idToken, "GET", `defaultMenuRules/${suco}`)).status).toBe(200);
  for (const user of [morning.guardian, morning.admin]) {
    expect((await fsRequest(user.idToken, "PATCH", `defaultMenuRules/${suco}`, { shiftIds: { arrayValue: {} } })).status).toBe(403);
    expect((await fsRequest(user.idToken, "PATCH", `menuOverrides/${date}__${shift}`, { suspended: { booleanValue: true } })).status).toBe(403);
  }
});

test("família lê só o cardápio do próprio aluno, na janela hoje…hoje+7 (A14/A33)", async ({ request }) => {
  const week = await getWeek(request, morning);
  expect(week.days).toHaveLength(8);
  expect(week.days[0]!.date).toBe(week.today);
  expect(week.student.id).toBe(morning.studentId);
  // Fim de semana (sem funcionamento) dentro da janela: fechado, sem itens.
  expect(week.days.some((d) => d.service === "closed" && d.reason === "non_operating_day" && d.items.length === 0)).toBe(true);

  const plus8 = new Date(`${week.today}T12:00:00Z`);
  plus8.setUTCDate(plus8.getUTCDate() + 8);
  const as = (family: Family, query: string) => request.get(`/api/menu?${query}`, { headers: bearer(family.guardian.idToken) });
  expect((await as(morning, `studentId=${morning.studentId}&date=${plus8.toISOString().slice(0, 10)}`)).status()).toBe(422);
  expect((await getWeek(request, morning, `&date=${week.days.at(-1)!.date}`)).days).toHaveLength(1);
  expect((await as(morning, `studentId=${afternoon.studentId}`)).status()).toBe(403);
  expect((await as(afternoon, `studentId=${morning.studentId}`)).status()).toBe(403);
  expect((await as(morning, "")).status()).toBe(422);
  expect((await request.get("/api/menu", { headers: bearer(studentLogin.idToken) })).status()).toBe(404); // conta de aluno sem cadastro ligado
  expect((await request.get(`/api/menu?studentId=${morning.studentId}`)).status()).toBe(401);
  expect((await request.get(`/api/menu?studentId=${morning.studentId}`, { headers: bearer(cantina.idToken) })).status()).toBe(200);
});

test("extra, ocultação e suspensão valem só na data/turno configurados; motivo interno não chega à família (A15)", async ({ request }) => {
  const ids = await fixtureIds();
  const shift = ids.shift("Manhã (exemplo)");
  const adminUser = morning.admin;
  const extra = await createTempProduct(request, adminUser.idToken, `Hot-dog HML ${tag}`);
  const hidden = await createTempProduct(request, adminUser.idToken, `Pão HML ${tag}`);
  const menu = (data: Record<string, unknown>) => adminPost(request, adminUser, "/api/menu", data);
  const version = async (date: string) => Number((await admin().db.doc(`menuOverrides/${date}__${shift}`).get()).get("version") ?? 0);
  const week = await getWeek(request, morning);
  const [d1, d2, d3] = week.days.filter((d) => d.allowed && d.date !== week.today).map((d) => d.date);
  expect(d1 && d2 && d3, "três datas com compra permitida").toBeTruthy();
  try {
    await menu({ action: "setDefault", productId: hidden, shiftIds: [shift], expectedVersion: 0 });
    await menu({ action: "setItem", date: d1, shiftId: shift, productId: extra, expectedVersion: await version(d1!), include: "extra", limit: 25, reason: REASON });
    await menu({ action: "setItem", date: d1, shiftId: shift, productId: hidden, expectedVersion: await version(d1!), include: "hidden", limit: null, reason: REASON });
    await menu({ action: "setService", date: d2, shiftId: shift, expectedVersion: await version(d2!), suspended: true, reason: REASON });

    const after = await getWeek(request, morning);
    const day = (date: string) => after.days.find((d) => d.date === date)!;
    const offered = (date: string) => day(date).items.map((i) => i.productId);
    expect(day(d1!).items.find((i) => i.productId === extra)).toMatchObject({ source: "extra", limited: true });
    expect(offered(d1!)).not.toContain(hidden);
    expect(day(d2!)).toMatchObject({ service: "suspended", allowed: false, reason: "service_suspended", items: [] });
    expect(offered(d3!)).toContain(hidden);
    expect(offered(d3!)).not.toContain(extra);
    // O turno é do aluno: o aluno da tarde não recebe nada da manhã.
    const tarde = await getWeek(request, afternoon);
    expect(tarde.days.flatMap((d) => d.items.map((i) => i.productId)).filter((id) => id === extra || id === hidden)).toEqual([]);
    expect(tarde.days.find((d) => d.date === d2)!.service).not.toBe("suspended");
    // O motivo fica só na configuração (operação) e na auditoria.
    expect(JSON.stringify(after)).not.toContain(REASON);
    expect(JSON.stringify((await fsRequest(cantina.idToken, "GET", `menuOverrides/${d1}__${shift}`)).body)).toContain(REASON);
    expect((await fsRequest(morning.guardian.idToken, "GET", `menuOverrides/${d1}__${shift}`)).status).toBe(403);
  } finally {
    await menu({ action: "setService", date: d2, shiftId: shift, expectedVersion: await version(d2!), suspended: false });
    await menu({ action: "setItem", date: d1, shiftId: shift, productId: extra, expectedVersion: await version(d1!), include: "default", limit: null });
    await menu({ action: "setItem", date: d1, shiftId: shift, productId: hidden, expectedVersion: await version(d1!), include: "default", limit: null });
    await retireTempProduct(request, adminUser.idToken, extra);
    await retireTempProduct(request, adminUser.idToken, hidden);
  }
});
