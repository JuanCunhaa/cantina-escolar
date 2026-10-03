import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context?: never) => Promise<Response>;
type Json = Record<string, unknown>;
type Role = "guardian" | "student" | "cantina" | "admin";

let policies: Handler;
let exceptions: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let runIdempotentCommand: typeof import("@/lib/firebase/command").runIdempotentCommand;
let guard: typeof import("@/modules/policies/purchase-guard");
let usageLib: typeof import("@/modules/policies/usage");
let dates: typeof import("@/lib/dates/school-time");

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let outsider: TestUser;
let studentLogin: TestUser;

const tag = randomUUID().slice(0, 6);
let counter = 0;
const sid = (name: string) => `stu_${tag}_${name}_${++counter}`;
const target = () => targetFromEnv();

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  policies = (await import("@/app/api/policies/route")).POST as Handler;
  exceptions = (await import("@/app/api/policies/exceptions/route")).POST as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ runIdempotentCommand } = await import("@/lib/firebase/command"));
  guard = await import("@/modules/policies/purchase-guard");
  usageLib = await import("@/modules/policies/usage");
  dates = await import("@/lib/dates/school-time");
  admin = await createTestUser("padm", "admin");
  cantina = await createTestUser("pcant", "cantina");
  secretaria = await createTestUser("psec", "secretaria");
  guardianA = await createTestUser("presp-a", "guardian");
  guardianB = await createTestUser("presp-b", "guardian");
  outsider = await createTestUser("pfora", "guardian");
  studentLogin = await createTestUser("palu", "student");
});

const post = (handler: Handler, url: string, user: TestUser | null, body: unknown) =>
  handler(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.idToken}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
const setPolicy = (user: TestUser | null, studentId: string, change: Json, key: string = randomUUID()) =>
  post(policies, "/api/policies", user, { key, studentId, ...change });
const exception = (user: TestUser | null, body: Json) => post(exceptions, "/api/policies/exceptions", user, { key: randomUUID(), ...body });

const doc = async (path: string) => (await adminDb().doc(path).get()).data();
const usageDay = async (studentId: string, date: string) => ((await doc(`studentUsage/${studentId}/days/${date}`))?.committedCents as number | undefined) ?? 0;
const usageWeek = async (studentId: string, date: string) => ((await doc(`studentUsage/${studentId}/weeks/${dates.weekStartOf(date)}`))?.committedCents as number | undefined) ?? 0;

/** Aluno com login (studentLogin só liga a um aluno por vez: o vínculo `userUid` é só do cadastro de teste). */
async function newStudent(over: { site?: boolean; counter?: boolean; guardians?: TestUser[]; login?: boolean } = {}): Promise<string> {
  const id = sid("s");
  await seedStudentAccess({
    studentId: id,
    guardianUids: (over.guardians ?? [guardianA, guardianB]).map((g) => g.uid),
    studentUid: over.login === false ? undefined : studentLogin.uid,
    allowSitePurchase: over.site ?? true,
    allowCounterPurchase: over.counter ?? true,
  });
  return id;
}
async function catalog(): Promise<{ catA: string; catB: string; prdA: string; prdB: string }> {
  const ids = { catA: `cat_${tag}_a`, catB: `cat_${tag}_b`, prdA: `prd_${tag}_a`, prdB: `prd_${tag}_b` };
  await writeDemoDoc(target(), `categories/${ids.catA}`, { name: "A", status: "active" });
  await writeDemoDoc(target(), `categories/${ids.catB}`, { name: "B", status: "active" });
  await writeDemoDoc(target(), `products/${ids.prdA}`, { name: "Produto A", categoryId: ids.catA, status: "active" });
  await writeDemoDoc(target(), `products/${ids.prdB}`, { name: "Produto B", categoryId: ids.catB, status: "active" });
  return ids;
}

const today = () => dates.localDateOf(new Date());
const dayPlus = (n: number) => dates.addDays(today(), n);
const line = (consumptionDate: string, amountCents: number, productId = "prd_x", categoryId = "cat_x") => ({ consumptionDate, productId, categoryId, amountCents });

/**
 * Comando de compra de TESTE: exatamente a sequência que F11 (site) e F15 (PDV) devem seguir — leitura do guard,
 * decisão e gravação do consumo na MESMA transação idempotente do pedido. O pedido real/saldo/estoque não existem
 * ainda (F10/F11/F15): aqui só provamos a política e o uso por data/semana, e `calls` conta as execuções do callback.
 */
let calls = 0;
async function buy(user: TestUser, role: Role, request: import("@/modules/policies/purchase-guard").PurchaseRequest, opts: { key?: string; failAfterWrite?: boolean } = {}) {
  const key = opts.key ?? randomUUID();
  return runIdempotentCommand(
    adminDb(),
    { uid: user.uid, role, permissions: [] },
    { scope: "test.purchase", key, payload: request, allow: () => true },
    async ({ tx, actor }) => {
      calls++;
      const g = await guard.readPurchaseGuard(adminDb(), tx, actor, request);
      const decision = guard.decidePurchase(g);
      if (!decision.allowed) return { allowed: false as const, decision, orderId: null };
      const orderId = `ord_${key}`;
      guard.commitPurchaseUsage(adminDb(), tx, actor, g, decision, orderId);
      tx.create(adminDb().doc(`testOrders/${orderId}`), { studentId: request.studentId, totalCents: decision.totalCents, lines: request.lines });
      if (opts.failAfterWrite) throw new Error("falha forçada depois das escritas");
      return { allowed: true as const, decision, orderId };
    },
  );
}
const ordersOf = async (studentId: string) => (await adminDb().collection("testOrders").where("studentId", "==", studentId).get()).size;

describe("comando de política: limites, bloqueios e autorização (A02/A09)", () => {
  it("qualquer responsável vinculado define limite diário/semanal e bloqueios; autor/versão auditados; sem vínculo, equipe e aluno negados", async () => {
    const id = await newStudent();
    const { catA, prdA } = await catalog();
    const a = await setPolicy(guardianA, id, { dailyLimitCents: 1000, weeklyLimitCents: 4000 });
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ changed: true, configVersion: 1, appliesTo: "new_purchases_only", existingCommitments: [], policy: { dailyLimitCents: 1000, weeklyLimitCents: 4000 } });
    const b = await setPolicy(guardianB, id, { blockedProductIds: [prdA], blockedCategoryIds: [catA] });
    expect(b.status).toBe(200);
    expect(await doc(`studentPolicies/${id}`)).toMatchObject({
      dailyLimitCents: 1000,
      weeklyLimitCents: 4000,
      blockedProductIds: [prdA],
      blockedCategoryIds: [catA],
      allowSitePurchase: true,
      configVersion: 2,
      updatedBy: guardianB.uid,
    });
    const audits = (await adminDb().collection("auditLog").where("target.id", "==", id).where("action", "==", "policy.set").get()).docs.map((d) => d.data());
    expect(audits.map((x) => x.actorUid).sort()).toEqual([guardianA.uid, guardianB.uid].sort());
    expect(audits.find((x) => x.actorUid === guardianA.uid)).toMatchObject({ before: { dailyLimitCents: null, configVersion: 0 }, after: { dailyLimitCents: 1000, configVersion: 1, appliesTo: "new_purchases_only" } });

    for (const user of [outsider, studentLogin, cantina, secretaria, null]) {
      expect((await setPolicy(user, id, { dailyLimitCents: 1 })).status).toBe(user ? 403 : 401);
    }
    expect(await doc(`studentPolicies/${id}`)).toMatchObject({ dailyLimitCents: 1000, configVersion: 2 });
    expect((await setPolicy(admin, id, { weeklyLimitCents: null })).status).toBe(200); // administração também gerencia
    expect((await doc(`studentPolicies/${id}`))?.weeklyLimitCents).toBeNull();
  });

  it("valida entradas, item bloqueado inexistente, diário > semanal e versão esperada; mesma chave é idempotente e payload diferente é conflito", async () => {
    const id = await newStudent();
    for (const bad of [{ dailyLimitCents: 0 }, { dailyLimitCents: 12.5 }, { weeklyLimitCents: 99_999_999 }, {}, { blockedProductIds: ["a/b"] }]) {
      expect((await setPolicy(guardianA, id, bad)).status).toBe(400);
    }
    expect((await setPolicy(guardianA, id, { blockedProductIds: ["prd_inexistente"] })).status).toBe(404);
    expect(await (await setPolicy(guardianA, id, { dailyLimitCents: 2000, weeklyLimitCents: 1000 })).json()).toEqual({ error: "daily_exceeds_weekly" });
    expect((await setPolicy(guardianA, id, { dailyLimitCents: 500, expectedConfigVersion: 7 })).status).toBe(409);
    expect(await doc(`studentPolicies/${id}`)).not.toHaveProperty("dailyLimitCents");

    const key = randomUUID();
    const first = await (await setPolicy(guardianA, id, { dailyLimitCents: 700, expectedConfigVersion: 0 }, key)).json();
    const again = await setPolicy(guardianA, id, { dailyLimitCents: 700, expectedConfigVersion: 0 }, key);
    expect(await again.json()).toMatchObject({ ...first, replayed: true });
    expect((await doc(`studentPolicies/${id}`))?.configVersion).toBe(1);
    expect((await setPolicy(guardianA, id, { dailyLimitCents: 701, expectedConfigVersion: 0 }, key)).status).toBe(409);
    // Sem mudança efetiva não incrementa a versão.
    expect(await (await setPolicy(guardianA, id, { dailyLimitCents: 700 })).json()).toMatchObject({ changed: false, configVersion: 1 });
  });
});

describe("reduzir limite ou bloquear produto NÃO cancela compromissos existentes", () => {
  it("mostra os compromissos acima do novo teto e mantém pedidos e uso exatamente como estavam", async () => {
    const id = await newStudent();
    const monday = dates.weekStartOf(dayPlus(7));
    const d1 = monday;
    const d2 = dates.addDays(monday, 1);
    // Compromissos anteriores: R$ 8 em d1 e R$ 6 em d2 (mesma semana: R$ 14).
    for (const [date, cents] of [[d1, 800], [d2, 600]] as const) {
      const result = await buy(guardianA, "guardian", { studentId: id, channel: "advance", lines: [line(date, cents)] });
      expect(result.allowed).toBe(true);
    }
    const before = { ordersCount: await ordersOf(id), d1: await usageDay(id, d1), d2: await usageDay(id, d2), week: await usageWeek(id, d1) };
    expect(before).toEqual({ ordersCount: 2, d1: 800, d2: 600, week: 1400 });

    const response = await setPolicy(guardianB, id, { dailyLimitCents: 500, weeklyLimitCents: 1000 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { existingCommitments: Json[]; appliesTo: string };
    expect(body.appliesTo).toBe("new_purchases_only");
    expect(body.existingCommitments).toEqual([
      { scope: "day", key: d1, committedCents: 800, limitCents: 500, excessCents: 300 },
      { scope: "day", key: d2, committedCents: 600, limitCents: 500, excessCents: 100 },
      { scope: "week", key: monday, committedCents: 1400, limitCents: 1000, excessCents: 400 },
    ]);
    // Nada foi cancelado, reembolsado ou reescrito.
    expect({ ordersCount: await ordersOf(id), d1: await usageDay(id, d1), d2: await usageDay(id, d2), week: await usageWeek(id, d1) }).toEqual(before);
    // Novas compras autônomas ficam bloqueadas (dia já acima do teto) e as existentes continuam contando.
    const next = await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(d1, 100)] });
    expect(next.allowed).toBe(false);
    expect(await usageDay(id, d1)).toBe(800);
  });

  it("bloquear um produto depois de um pedido pago mantém o pedido e o uso; só a nova compra autônoma é negada", async () => {
    const id = await newStudent();
    const { prdA, catA } = await catalog();
    const date = dayPlus(1);
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 500, prdA, catA)] })).allowed).toBe(true);
    expect((await setPolicy(guardianA, id, { blockedProductIds: [prdA] })).status).toBe(200);
    expect(await ordersOf(id)).toBe(1);
    expect(await usageDay(id, date)).toBe(500);
    const denied = await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 100, prdA, catA)] });
    expect(denied.allowed).toBe(false);
    expect(denied.decision.violations).toEqual([{ kind: "product_blocked", productId: prdA }]);
  });
});

describe("A10 — limite diário por data do consumo (guard compartilhado, transação real)", () => {
  it("R$ 10 para cada dia diferente passa; o 2º pedido do mesmo dia que exceder é negado; uso por dia e por semana consistentes", async () => {
    const id = await newStudent();
    expect((await setPolicy(guardianA, id, { dailyLimitCents: 1000 })).status).toBe(200);
    const days = [dayPlus(1), dayPlus(2), dayPlus(3)];
    for (const d of days) expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(d, 1000)] })).allowed).toBe(true);
    for (const d of days) expect(await usageDay(id, d)).toBe(1000);
    const weekTotals = new Map<string, number>();
    for (const d of days) weekTotals.set(dates.weekStartOf(d), (weekTotals.get(dates.weekStartOf(d)) ?? 0) + 1000);
    for (const [week, total] of weekTotals) expect((await doc(`studentUsage/${id}/weeks/${week}`))?.committedCents).toBe(total);
    const over = await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(days[0]!, 1)] });
    expect(over.allowed).toBe(false);
    expect(await usageDay(id, days[0]!)).toBe(1000);
    // Um carrinho com vários dias é avaliado por data: R$ 10 + R$ 10 em dois dias livres passa em uma única transação.
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(dayPlus(4), 1000), line(dayPlus(5), 1000)] })).allowed).toBe(true);
  });
});

describe("A11 — balcão, semana e reembolso", () => {
  it("R$ 8 agendados deixam R$ 2 no balcão: R$ 3 negado, R$ 2 aceito; reembolso libera o valor devido", async () => {
    const id = await newStudent();
    expect((await setPolicy(guardianA, id, { dailyLimitCents: 1000 })).status).toBe(200);
    const date = dayPlus(1);
    expect((await buy(guardianA, "guardian", { studentId: id, channel: "advance", lines: [line(date, 800)] })).allowed).toBe(true);
    const three = await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(date, 300)] });
    expect(three.allowed).toBe(false);
    expect(three.decision.violations).toEqual([{ kind: "daily_limit_exceeded", date, limitCents: 1000, committedCents: 800, requestedCents: 300 }]);
    expect(await usageDay(id, date)).toBe(800);
    const two = await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(date, 200)] });
    expect(two.allowed).toBe(true);
    expect(await usageDay(id, date)).toBe(1000);

    // Reembolso/cancelamento do pedido de R$ 8 libera exatamente R$ 8 (mesma transação que reservaria o novo uso).
    await adminDb().runTransaction(async (tx) => {
      const write = await guard.releaseUsage(adminDb(), tx, id, [{ consumptionDate: date, amountCents: 800 }]);
      write();
    });
    expect(await usageDay(id, date)).toBe(200);
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(date, 800)] })).allowed).toBe(true);
  });

  it("liberar mais do que está comprometido é violação de invariante e não grava nada", async () => {
    const id = await newStudent();
    const date = dayPlus(1);
    await buy(guardianA, "guardian", { studentId: id, channel: "advance", lines: [line(date, 300)] });
    await expect(
      adminDb().runTransaction(async (tx) => {
        const write = await guard.releaseUsage(adminDb(), tx, id, [{ consumptionDate: date, amountCents: 301 }]);
        write();
      }),
    ).rejects.toBeInstanceOf(usageLib.UsageInvariantError);
    expect(await usageDay(id, date)).toBe(300);
    expect(await usageWeek(id, date)).toBe(300);
  });

  it("limite semanal vale por semana do consumo; transferência/recarga não consomem (não há uso sem compra)", async () => {
    const id = await newStudent();
    expect((await setPolicy(guardianA, id, { weeklyLimitCents: 2000 })).status).toBe(200);
    const monday = dates.weekStartOf(dayPlus(7));
    const next = dates.addDays(monday, 7);
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(monday, 1200), line(dates.addDays(monday, 2), 800)] })).allowed).toBe(true);
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(dates.addDays(monday, 6), 1)] })).allowed).toBe(false); // domingo, mesma semana
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(next, 2000)] })).allowed).toBe(true); // semana seguinte
    expect(await usageWeek(id, monday)).toBe(2000);
    expect(await usageWeek(id, next)).toBe(2000);
  });
});

describe("A08 — permissão de compra revogada (site e balcão separados)", () => {
  it("revogar bloqueia checkout/PDV autônomos e mantém o uso/pedidos existentes; o responsável continua podendo comprar", async () => {
    const id = await newStudent({ site: true, counter: true });
    const date = dayPlus(1);
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 400)] })).allowed).toBe(true);
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(today(), 100)] })).allowed).toBe(true);
    // Só o balcão é revogado: site continua; o PDV é negado.
    expect((await setPolicy(guardianA, id, { allowCounterPurchase: false })).status).toBe(200);
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(today(), 100)] })).allowed).toBe(false);
    expect((await buy(admin, "admin", { studentId: id, channel: "counter", lines: [line(today(), 100)] })).allowed).toBe(false);
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 100)] })).allowed).toBe(true);
    // Agora o site também.
    expect((await setPolicy(guardianB, id, { allowSitePurchase: false })).status).toBe(200);
    const denied = await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 100)] });
    expect(denied).toMatchObject({ allowed: false });
    expect(denied.decision.violations).toEqual([{ kind: "channel_not_allowed", channel: "advance" }]);
    // Revogação não apaga pedidos nem uso; permissão não é contornada por confirmação nem por exceção.
    expect(await ordersOf(id)).toBe(3);
    expect(await usageDay(id, date)).toBe(500);
    expect((await buy(guardianA, "guardian", { studentId: id, channel: "advance", lines: [line(date, 100)] })).allowed).toBe(true); // responsável compra para o aluno
    // Balcão para o responsável não existe; quem não está vinculado, equipe sem PDV e aluno de outra conta são negados.
    expect((await buy(guardianA, "guardian", { studentId: id, channel: "counter", lines: [line(date, 100)] })).allowed).toBe(false);
    expect((await buy(outsider, "guardian", { studentId: id, channel: "advance", lines: [line(date, 100)] })).allowed).toBe(false);
    expect((await buy(secretaria, "cantina", { studentId: id, channel: "advance", lines: [line(date, 100)] })).allowed).toBe(false);
  });

  it("aluno arquivado não compra por nenhum canal", async () => {
    const id = sid("arq");
    await seedStudentAccess({ studentId: id, guardianUids: [guardianA.uid], studentUid: studentLogin.uid, studentStatus: "inactive", allowSitePurchase: true, allowCounterPurchase: true });
    expect((await buy(guardianA, "guardian", { studentId: id, channel: "advance", lines: [line(dayPlus(1), 100)] })).allowed).toBe(false);
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(today(), 100)] })).allowed).toBe(false);
  });
});

describe("A09 — bloqueio por produto/categoria e exceção explícita", () => {
  it("bloqueio vale no site e no balcão; o responsável confirma vendo o efeito e a compra continua contando como consumo", async () => {
    const id = await newStudent();
    const { prdA, catA, prdB, catB } = await catalog();
    expect((await setPolicy(guardianA, id, { blockedProductIds: [prdA], blockedCategoryIds: [catB], dailyLimitCents: 1000 })).status).toBe(200);
    const date = dayPlus(1);
    const site = await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 300, prdA, catA)] });
    const counterCat = await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(today(), 300, "prd_z", catB)] });
    expect([site.allowed, counterCat.allowed]).toEqual([false, false]);
    expect(site.decision.violations).toEqual([{ kind: "product_blocked", productId: prdA }]);
    expect(counterCat.decision.violations).toEqual([{ kind: "category_blocked", categoryId: catB }]);
    // Funcionário não ignora a restrição "porque está no PDV" (nem com confirmação).
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(today(), 300, prdB, catB)], confirmed: true })).allowed).toBe(false);
    expect((await buy(admin, "admin", { studentId: id, channel: "counter", lines: [line(today(), 300, prdB, catB)], confirmed: true })).allowed).toBe(false);

    // Responsável: sem confirmação pede confirmação e não grava; com confirmação passa e conta no consumo (inclusive acima do teto).
    const guardianLines = [line(date, 1200, prdA, catA)];
    const ask = await buy(guardianA, "guardian", { studentId: id, channel: "advance", lines: guardianLines });
    expect(ask).toMatchObject({ allowed: false, decision: { needsConfirmation: true } });
    expect(ask.decision.days[0]).toMatchObject({ requestedCents: 1200, limitCents: 1000, exceeds: true });
    expect(await usageDay(id, date)).toBe(0);
    const ok = await buy(guardianA, "guardian", { studentId: id, channel: "advance", lines: guardianLines, confirmed: true });
    expect(ok).toMatchObject({ allowed: true, decision: { override: { via: "guardian_confirmation" } } });
    expect(await usageDay(id, date)).toBe(1200);
    // O consumo do responsável conta para as próximas compras autônomas do aluno.
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 1, "prd_ok", "cat_ok")] })).allowed).toBe(false);
  });

  it("autorização específica do responsável: exceção de uso único (data e valor máximos) para o balcão; replay não consome de novo", async () => {
    const id = await newStudent();
    const { prdA, catA } = await catalog();
    expect((await setPolicy(guardianA, id, { blockedProductIds: [prdA] })).status).toBe(200);
    const date = dayPlus(1);
    const created = await exception(guardianB, { action: "create", studentId: id, consumptionDate: date, maxCents: 500 });
    expect(created.status).toBe(200);
    const { exceptionId } = (await created.json()) as { exceptionId: string };
    expect(await doc(`studentPolicies/${id}/exceptions/${exceptionId}`)).toMatchObject({ kind: "guardian", status: "active", consumptionDate: date, maxCents: 500, createdBy: guardianB.uid });
    const lines = [line(date, 400, prdA, catA)];
    // Sem a exceção, data errada, valor acima: negado. Com a exceção: aceito e consumida na mesma transação.
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines })).allowed).toBe(false);
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(dayPlus(2), 400, prdA, catA)], exceptionId })).allowed).toBe(false);
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(date, 501, prdA, catA)], exceptionId })).allowed).toBe(false);
    const key = randomUUID();
    const used = await buy(cantina, "cantina", { studentId: id, channel: "counter", lines, exceptionId }, { key });
    expect(used).toMatchObject({ allowed: true, decision: { override: { via: "exception", exceptionId, kind: "guardian" } } });
    expect(await doc(`studentPolicies/${id}/exceptions/${exceptionId}`)).toMatchObject({ status: "used", usedBy: cantina.uid, usedFor: `ord_${key}` });
    expect(await usageDay(id, date)).toBe(400);
    // Replay (mesma chave) devolve o resultado original sem novo consumo; nova compra com a mesma exceção é negada.
    expect(await buy(cantina, "cantina", { studentId: id, channel: "counter", lines, exceptionId }, { key })).toMatchObject({ allowed: true, replayed: true });
    expect(await usageDay(id, date)).toBe(400);
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines, exceptionId })).allowed).toBe(false);
    // Exceção usada não pode ser revogada.
    expect((await exception(guardianA, { action: "revoke", studentId: id, exceptionId })).status).toBe(409);
  });

  it("exceção administrativa exige motivo e é auditada; revogada não vale; cantina/secretaria/aluno/outra família não criam nem revogam", async () => {
    const id = await newStudent();
    const date = dayPlus(1);
    expect((await exception(admin, { action: "create", studentId: id, consumptionDate: date, maxCents: 500, reason: "curto" })).status).toBe(422);
    const created = await exception(admin, { action: "create", studentId: id, consumptionDate: date, maxCents: 500, reason: "Autorização da direção por telefone" });
    expect(created.status).toBe(200);
    const { exceptionId } = (await created.json()) as { exceptionId: string };
    expect(await doc(`studentPolicies/${id}/exceptions/${exceptionId}`)).toMatchObject({ kind: "admin", createdByRole: "admin" });
    expect(await adminDb().collection("auditLog").where("target.id", "==", id).where("action", "==", "policy.exception.create").get().then((s) => s.size)).toBe(1);
    for (const user of [cantina, secretaria, studentLogin, outsider, null]) {
      expect((await exception(user, { action: "create", studentId: id, consumptionDate: date, maxCents: 500 })).status).toBe(user ? 403 : 401);
      expect((await exception(user, { action: "revoke", studentId: id, exceptionId })).status).toBe(user ? 403 : 401);
    }
    expect((await exception(guardianA, { action: "revoke", studentId: id, exceptionId })).status).toBe(200);
    expect(await doc(`studentPolicies/${id}/exceptions/${exceptionId}`)).toMatchObject({ status: "revoked", revokedBy: guardianA.uid });
    const { prdA, catA } = await catalog();
    await setPolicy(guardianA, id, { blockedProductIds: [prdA] });
    expect((await buy(cantina, "cantina", { studentId: id, channel: "counter", lines: [line(date, 100, prdA, catA)], exceptionId })).allowed).toBe(false);
    // Janela e data inválidas.
    expect((await exception(guardianA, { action: "create", studentId: id, consumptionDate: dayPlus(8), maxCents: 100 })).status).toBe(422);
    expect((await exception(guardianA, { action: "create", studentId: id, consumptionDate: dayPlus(-1), maxCents: 100 })).status).toBe(422);
  });
});

describe("A35 — documentos de uso impedem contornar os limites sob concorrência", () => {
  it("8 compras simultâneas de R$ 3 no mesmo dia com teto de R$ 10: exatamente 3 passam, uso = R$ 9, nenhuma passa do teto", async () => {
    const id = await newStudent();
    expect((await setPolicy(guardianA, id, { dailyLimitCents: 1000 })).status).toBe(200);
    const date = dayPlus(1);
    calls = 0;
    const results = await Promise.all(Array.from({ length: 8 }, () => buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 300)] })));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(await usageDay(id, date)).toBe(900);
    expect(await usageWeek(id, date)).toBe(900);
    expect(await ordersOf(id)).toBe(3);
    expect(calls).toBeGreaterThanOrEqual(8); // retentativas do callback não duplicam consumo nem pedidos
  });

  it("compras simultâneas em dias diferentes respeitam o teto SEMANAL compartilhado e o diário de cada dia", async () => {
    const id = await newStudent();
    expect((await setPolicy(guardianA, id, { dailyLimitCents: 1000, weeklyLimitCents: 2500 })).status).toBe(200);
    const monday = dates.weekStartOf(dayPlus(7));
    const week = Array.from({ length: 5 }, (_, i) => dates.addDays(monday, i));
    const results = await Promise.all(week.flatMap((d) => [0, 1].map(() => buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(d, 500)] }))));
    const accepted = results.filter((r) => r.allowed).length;
    expect(accepted).toBe(5); // 5 × R$ 5 = R$ 25 = teto semanal exato
    expect(await usageWeek(id, monday)).toBe(2500);
    for (const d of week) expect(await usageDay(id, d)).toBeLessThanOrEqual(1000);
    expect((await Promise.all(week.map((d) => usageDay(id, d)))).reduce((a, b) => a + b, 0)).toBe(2500);
  });

  it("mesma chave simultânea ×6 comete uma única vez; falha depois das escritas desfaz pedido e uso", async () => {
    const id = await newStudent();
    const date = dayPlus(1);
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 6 }, () => buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 300)] }, { key })));
    expect(same.every((r) => r.allowed)).toBe(true);
    expect(same.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await usageDay(id, date)).toBe(300);
    expect(await ordersOf(id)).toBe(1);

    await expect(buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 300)] }, { failAfterWrite: true })).rejects.toThrow("falha forçada");
    expect(await usageDay(id, date)).toBe(300);
    expect(await usageWeek(id, date)).toBe(300);
    expect(await ordersOf(id)).toBe(1);
  });

  it("política lida na transação: bloqueio feito durante a disputa vale para quem ainda não confirmou (sem decisão com dado velho)", async () => {
    const id = await newStudent();
    const { prdA, catA } = await catalog();
    const date = dayPlus(1);
    const [, ...rest] = await Promise.all([
      setPolicy(guardianA, id, { blockedProductIds: [prdA] }),
      ...Array.from({ length: 4 }, () => buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 100, prdA, catA)] })),
    ]);
    const accepted = rest.filter((r) => r.allowed).length;
    // Qualquer ordem é serializável: o uso comprometido bate exatamente com os pedidos aceitos.
    expect(await usageDay(id, date)).toBe(accepted * 100);
    expect(await ordersOf(id)).toBe(accepted);
    expect((await buy(studentLogin, "student", { studentId: id, channel: "advance", lines: [line(date, 100, prdA, catA)] })).allowed).toBe(false);
  });
});
