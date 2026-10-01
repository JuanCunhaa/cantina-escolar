import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context?: never) => Promise<Response>;

let schoolRoute: Handler;
let settingsRoute: { GET: Handler; POST: Handler };
let calendarRoute: { GET: Handler; POST: Handler };
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let checkPurchase: typeof import("@/modules/school/settings").checkPurchase;
let changeCalendarDay: typeof import("@/modules/school/settings").changeCalendarDay;
let localDateOf: typeof import("@/lib/dates/school-time").localDateOf;
let addDays: typeof import("@/lib/dates/school-time").addDays;

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardian: TestUser;
let shiftId: string;
let otherShiftId: string;

const tag = randomUUID().slice(0, 6);

function request(method: string, url: string, token: string | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const post = (handler: Handler, url: string, token: string | null, body: Record<string, unknown>) => handler(request("POST", url, token, { key: randomUUID(), ...body }));
const get = (handler: Handler, url: string, token: string | null) => handler(request("GET", url, token));

async function newShift(name: string): Promise<string> {
  const response = await post(schoolRoute, "/api/school", admin.idToken, { action: "create", kind: "shift", name });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

async function currentVersion(): Promise<number> {
  const response = await get(settingsRoute.GET, "/api/school/settings", admin.idToken);
  expect(response.status).toBe(200);
  return ((await response.json()) as { version: number }).version;
}

const baseSettings = (shiftPolicies: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  schoolName: `Escola Teste ${tag}`,
  weekdays: [1, 2, 3, 4, 5],
  shiftPolicies,
  ...extra,
});

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  schoolRoute = (await import("@/app/api/school/route")).POST as Handler;
  settingsRoute = (await import("@/app/api/school/settings/route")) as never;
  calendarRoute = (await import("@/app/api/school/calendar/route")) as never;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ checkPurchase, changeCalendarDay } = await import("@/modules/school/settings"));
  ({ localDateOf, addDays } = await import("@/lib/dates/school-time"));
  admin = await createTestUser("adm5", "admin");
  cantina = await createTestUser("cantina5", "cantina");
  secretaria = await createTestUser("secretaria5", "secretaria");
  guardian = await createTestUser("resp5", "guardian");
  shiftId = await newShift(`Turno Integral ${tag}`);
  otherShiftId = await newShift(`Turno Noite ${tag}`);
});

describe("F05: configurações e calendário — autorização", () => {
  it("só a administração altera/lê configurações e dias; sem token = 401", async () => {
    const settings = { expectedVersion: 0, ...baseSettings({}) };
    for (const user of [cantina, secretaria, guardian]) {
      expect((await post(settingsRoute.POST, "/api/school/settings", user.idToken, settings)).status).toBe(403);
      expect((await get(settingsRoute.GET, "/api/school/settings", user.idToken)).status).toBe(403);
      expect((await post(calendarRoute.POST, "/api/school/calendar", user.idToken, { action: "set", date: addDays(localDateOf(new Date()), 3), kind: "closed", reason: "x" })).status).toBe(403);
    }
    expect((await post(settingsRoute.POST, "/api/school/settings", null, settings)).status).toBe(401);
    expect((await get(calendarRoute.GET, `/api/school/calendar?shiftId=${shiftId}`, null)).status).toBe(401);
  });
});

describe("F05: configurações da escola (identidade, dias, horários) — A13", () => {
  it("valida entradas: horário, dia da semana, nome, turno inexistente", async () => {
    const v = await currentVersion();
    const bad = async (body: Record<string, unknown>, status: number) =>
      expect((await post(settingsRoute.POST, "/api/school/settings", admin.idToken, { expectedVersion: v, ...body })).status).toBe(status);
    await bad(baseSettings({ [shiftId]: { purchaseCutoff: "7:00", cancelCutoff: "08:00" } }), 400);
    await bad(baseSettings({ [shiftId]: { purchaseCutoff: "24:00", cancelCutoff: "08:00" } }), 400);
    await bad(baseSettings({}, { weekdays: [7] }), 400);
    await bad(baseSettings({}, { weekdays: [] }), 400);
    await bad(baseSettings({}, { schoolName: "=cmd()" }), 400);
    await bad(baseSettings({ shf_inexistente: { purchaseCutoff: "07:00", cancelCutoff: "08:00" } }), 404);
    expect(await currentVersion()).toBe(v);
  });

  it("grava, audita, repete com a mesma chave (replay) e rejeita versão antiga e chave com payload diferente", async () => {
    const v = await currentVersion();
    const key = randomUUID();
    const body = { key, expectedVersion: v, ...baseSettings({ [shiftId]: { purchaseCutoff: "06:30", cancelCutoff: "07:45" } }) };
    const first = await settingsRoute.POST(request("POST", "/api/school/settings", admin.idToken, body));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ version: v + 1, replayed: false });
    const replay = await settingsRoute.POST(request("POST", "/api/school/settings", admin.idToken, body));
    expect(await replay.json()).toMatchObject({ version: v + 1, replayed: true });
    expect(await currentVersion()).toBe(v + 1);

    const other = await settingsRoute.POST(request("POST", "/api/school/settings", admin.idToken, { ...body, schoolName: "Outro nome" }));
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: "idempotency_conflict" });

    const stale = await post(settingsRoute.POST, "/api/school/settings", admin.idToken, { expectedVersion: v, ...baseSettings({}) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_settings" });

    const stored = (await adminDb().doc("settings/school").get()).data()!;
    expect(stored).toMatchObject({ schoolName: `Escola Teste ${tag}`, weekdays: [1, 2, 3, 4, 5], version: v + 1 });
    const audit = (await adminDb().collection("auditLog").where("target.id", "==", "school").where("action", "==", "school.settings.update").get()).docs.map((d) => d.data());
    expect(audit.some((a) => a.after?.version === v + 1 && a.after?.appliesTo === "new_orders_only" && a.actorRole === "admin")).toBe(true);
  });

  it("duas alterações concorrentes com a mesma versão: exatamente uma vence", async () => {
    const v = await currentVersion();
    const keep = { [shiftId]: { purchaseCutoff: "06:30", cancelCutoff: "07:45" } };
    const attempt = (name: string) => post(settingsRoute.POST, "/api/school/settings", admin.idToken, { expectedVersion: v, ...baseSettings(keep, { schoolName: name }) });
    const results = await Promise.all([attempt(`A ${tag}`), attempt(`B ${tag}`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await currentVersion()).toBe(v + 1);
  });
});

describe("F05: dias extras e fechados", () => {
  const today = () => localDateOf(new Date());

  it("define, repete, altera, remove e audita; data passada/inválida/distante é recusada", async () => {
    const date = addDays(today(), 40);
    const set = (kind: string, reason: string, key = randomUUID()) => calendarRoute.POST(request("POST", "/api/school/calendar", admin.idToken, { key, action: "set", date, kind, reason }));
    expect((await (await set("extra", "Sábado letivo")).json())).toMatchObject({ date, changed: true });
    expect((await (await set("extra", "Sábado letivo")).json())).toMatchObject({ changed: false });
    expect((await (await set("closed", "Recesso")).json())).toMatchObject({ changed: true });
    expect((await adminDb().doc(`calendarDays/${date}`).get()).data()).toMatchObject({ kind: "closed", reason: "Recesso" });
    const cleared = await post(calendarRoute.POST, "/api/school/calendar", admin.idToken, { action: "clear", date });
    expect(await cleared.json()).toMatchObject({ changed: true });
    expect((await adminDb().doc(`calendarDays/${date}`).get()).exists).toBe(false);
    const audits = (await adminDb().collection("auditLog").where("target.id", "==", date).get()).docs.map((d) => d.data().action);
    expect(audits.sort()).toEqual(["school.calendar.clear", "school.calendar.set", "school.calendar.set"]);

    const status = async (body: Record<string, unknown>) => (await post(calendarRoute.POST, "/api/school/calendar", admin.idToken, body)).status;
    expect(await status({ action: "set", date: addDays(today(), -1), kind: "closed", reason: "x" })).toBe(422);
    expect(await status({ action: "set", date: addDays(today(), 500), kind: "closed", reason: "x" })).toBe(422);
    expect(await status({ action: "set", date: "2026-02-30", kind: "closed", reason: "x" })).toBe(400);
    expect(await status({ action: "set", date, kind: "feriado", reason: "x" })).toBe(400);
    expect(await status({ action: "set", date, kind: "closed", reason: "=1+1" })).toBe(400);
  });

  it("fuso: às 23:30 locais de hoje o servidor ainda trata hoje como hoje (data local, não UTC)", async () => {
    const actor = { uid: admin.uid, role: "admin" as const };
    const date = "2026-10-01";
    const set = (now: string) => changeCalendarDay(adminDb(), actor, { key: randomUUID(), action: "set", date, kind: "closed", reason: "Teste de fuso" }, new Date(now));
    // 01/10 23:30 em São Paulo (02/10 02:30 UTC): ainda é hoje, não é data passada
    expect(await set("2026-10-02T02:30:00Z")).toMatchObject({ date, changed: true });
    await adminDb().doc(`calendarDays/${date}`).delete();
    // 02/10 00:00 local (03:00 UTC): 01/10 já passou
    await expect(set("2026-10-02T03:00:00Z")).rejects.toMatchObject({ code: "past_date" });
  });
});

describe("F05: janela e horários no servidor (A12, A14)", () => {
  const NOW = new Date("2026-10-01T12:00:00Z"); // quinta 09:00 local

  it("compra: manhã fecha às 07:00 (limite exato), amanhã pode, hoje+7 pode, hoje+8 não, fim de semana não", async () => {
    const db = adminDb();
    // limites explícitos configurados no teste anterior: 06:30/07:45 para shiftId
    const check = (date: string, now: Date, id = shiftId) => checkPurchase(db, { shiftId: id, date, now });
    expect((await check("2026-10-01", new Date("2026-10-01T09:29:59.999Z"))).allowed).toBe(true);
    expect(await check("2026-10-01", new Date("2026-10-01T09:30:00.000Z"))).toEqual({ allowed: false, reason: "after_cutoff" });
    expect((await check("2026-10-02", new Date("2026-10-01T09:30:00.000Z"))).allowed).toBe(true);
    expect((await check("2026-10-08", NOW)).allowed).toBe(true);
    expect(await check("2026-10-09", NOW)).toEqual({ allowed: false, reason: "beyond_window" });
    expect(await check("2026-10-03", NOW)).toEqual({ allowed: false, reason: "non_operating_day" });
    expect(await check("2026-10-01", NOW, "shf_nao_existe")).toEqual({ allowed: false, reason: "shift_unavailable" });
    expect(await check("2026-10-01", NOW, otherShiftId)).toEqual({ allowed: false, reason: "shift_not_configured" });
  });

  it("turno padrão manhã/tarde: 07:00 e 14:00 sem configuração; snapshot guarda limites UTC e versão", async () => {
    const db = adminDb();
    await db.doc("shifts/shf_f05_manha").set({ name: "Manhã", nameSlug: "manha", status: "active" });
    await db.doc("shifts/shf_f05_tarde").set({ name: "Tarde", nameSlug: "tarde", status: "active" });
    const morning = await checkPurchase(db, { shiftId: "shf_f05_manha", date: "2026-10-01", now: new Date("2026-10-01T09:59:59.999Z") });
    expect(morning.allowed).toBe(true);
    if (morning.allowed) {
      expect(morning.snapshot.purchaseCutoffAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
      expect(morning.snapshot.cancelCutoffAt.toISOString()).toBe("2026-10-01T11:00:00.000Z");
      expect(morning.snapshot.timezone).toBe("America/Sao_Paulo");
      expect(morning.snapshot.settingsVersion).toBeGreaterThan(0);
    }
    expect(await checkPurchase(db, { shiftId: "shf_f05_manha", date: "2026-10-01", now: new Date("2026-10-01T10:00:00.000Z") })).toEqual({ allowed: false, reason: "after_cutoff" });
    expect((await checkPurchase(db, { shiftId: "shf_f05_tarde", date: "2026-10-01", now: new Date("2026-10-01T16:59:59.999Z") })).allowed).toBe(true);
    expect(await checkPurchase(db, { shiftId: "shf_f05_tarde", date: "2026-10-01", now: new Date("2026-10-01T17:00:00.000Z") })).toEqual({ allowed: false, reason: "after_cutoff" });
  });

  it("dia extra libera sábado e dia fechado bloqueia dia útil; limpar volta ao padrão; carrinho antigo não contorna (revalidação a cada chamada)", async () => {
    const db = adminDb();
    const now = new Date("2026-10-01T12:00:00Z");
    await db.doc("calendarDays/2026-10-03").set({ date: "2026-10-03", kind: "extra", reason: "Sábado letivo" });
    await db.doc("calendarDays/2026-10-07").set({ date: "2026-10-07", kind: "closed", reason: "Recesso" });
    try {
      expect((await checkPurchase(db, { shiftId: "shf_f05_manha", date: "2026-10-03", now })).allowed).toBe(true);
      expect(await checkPurchase(db, { shiftId: "shf_f05_manha", date: "2026-10-07", now })).toEqual({ allowed: false, reason: "non_operating_day" });
      // mesma "carrinho" (data/turno) avaliada de novo após o limite: negada
      expect(await checkPurchase(db, { shiftId: "shf_f05_manha", date: "2026-10-01", now: new Date("2026-10-01T10:00:00Z") })).toEqual({ allowed: false, reason: "after_cutoff" });
    } finally {
      await db.doc("calendarDays/2026-10-03").delete();
      await db.doc("calendarDays/2026-10-07").delete();
    }
    expect(await checkPurchase(db, { shiftId: "shf_f05_manha", date: "2026-10-03", now })).toEqual({ allowed: false, reason: "non_operating_day" });
  });

  it("GET da janela (qualquer perfil ativo): 8 datas locais a partir de hoje, reflete extra/fechado e turno inválido falha", async () => {
    const t = localDateOf(new Date());
    const extra = addDays(t, 2);
    const closed = addDays(t, 3);
    for (const [date, kind] of [[extra, "extra"], [closed, "closed"]] as const) {
      expect((await post(calendarRoute.POST, "/api/school/calendar", admin.idToken, { action: "set", date, kind, reason: "Teste" })).status).toBe(200);
    }
    try {
      const response = await get(calendarRoute.GET, `/api/school/calendar?shiftId=${shiftId}`, guardian.idToken);
      expect(response.status).toBe(200);
      const window = (await response.json()) as { today: string; timezone: string; days: { date: string; operating: boolean; allowed: boolean; reason: string | null }[] };
      expect(window.timezone).toBe("America/Sao_Paulo");
      expect(window.today).toBe(t);
      expect(window.days.map((d) => d.date)).toEqual(Array.from({ length: 8 }, (_, i) => addDays(t, i)));
      expect(window.days.find((d) => d.date === extra)?.operating).toBe(true);
      expect(window.days.find((d) => d.date === closed)).toMatchObject({ operating: false, allowed: false, reason: "non_operating_day" });
      expect(window.days.some((d) => d.reason === "beyond_window")).toBe(false);
    } finally {
      for (const date of [extra, closed]) await post(calendarRoute.POST, "/api/school/calendar", admin.idToken, { action: "clear", date });
    }
    expect((await get(calendarRoute.GET, "/api/school/calendar?shiftId=shf_nao_existe", guardian.idToken)).status).toBe(404);
    expect((await get(calendarRoute.GET, "/api/school/calendar?shiftId=../x", guardian.idToken)).status).toBe(422);
    expect((await get(calendarRoute.GET, `/api/school/calendar?shiftId=${otherShiftId}`, guardian.idToken)).status).toBe(409);
  });
});
