// Projeção diária dos relatórios de vendas (F21): robustez, invalidação e custo de leitura, contra Auth/Firestore Emulator.
// Prova: dia fechado só recebe fato novo se alguém gravar com carimbo antigo (eventos reais — reembolso, estorno, troca, conferência de
// taxa — caem no dia em que acontecem), e então a contagem das fontes invalida o dia; cache ausente, de outra versão, incompleto,
// adulterado ou com falha de gravação nunca derruba nem falseia o relatório; mudança DURANTE a reconstrução não é gravada; conferência
// de taxa/liquidação (F20) é lida ao vivo e não exige reconstruir; custo de leitura medido por interceptação no cliente Admin
// (ESTIMATIVA do que a aplicação pediu, não a cobrança oficial): abrir de novo um período não relê o histórico.
// Os dados de origem são SINTÉTICOS, gravados direto com carimbo de dias passados (o único jeito de ter dias fechados no emulador).
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { measureReads } from "../helpers/read-meter";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string };
type Stats = { cachedDays: number; builtDays: number; liveDays: number; building: string[]; staleDays: number; repairedDays: number; unstableDays: number; cacheErrors: number; reads?: { estimatedReads: number; estimatedWrites: number; byLabel: Record<string, number> } };
type Full = Record<string, unknown> & {
  projection: Stats;
  realized: { totals: { units: number; revenueCents: number; costMicros: number }; byDay: { key: string; units: number; revenueCents: number }[] };
  cancellations: { totals: { events: number; refundCents: number } } | null;
  ledger: { rows: { type: string; amountCents: number }[] } | null;
  losses: { totals: { units: number } } | null;
  fees: { effectiveCents: number; unknownCount: number } | null;
  receipts: { feeConfirmedCents: number; feeInformedCents: number; settledGrossCents: number; pendingGrossCents: number } | null;
  checks: { id: string; ok: boolean }[];
};

let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let school: typeof import("@/lib/dates/school-time");
let reports: typeof import("@/modules/reports/sales-report");
const routes: Record<string, Handler> = {};
let admin: TestUser;
let secretaria: TestUser;
let guardian: TestUser;

const tag = randomUUID().slice(0, 6);
const PID = `pj_${tag}_a`;
const PID2 = `pj_${tag}_b`;
const SHIFT = `pjs_${tag}`;
const CAT = `pjc_${tag}`;
let BASE = "";
let seq = 0;
const d = (n: number) => school.addDays(BASE, n);
const noCtx = { params: Promise.resolve({ id: "" }) };
const created: string[] = [];

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  ({ adminDb } = await import("@/lib/firebase/admin"));
  school = await import("@/lib/dates/school-time");
  reports = await import("@/modules/reports/sales-report");
  routes["POST topups"] = (await import("@/app/api/topups/route")).POST as unknown as Handler;
  routes["POST reverse"] = (await import("@/app/api/topups/[id]/reverse/route")).POST as unknown as Handler;
  routes["POST reconcile"] = (await import("@/app/api/admin/finance/reconcile/route")).POST as unknown as Handler;
  BASE = school.localDateOf(new Date());
  await writeDemoDoc(targetFromEnv(), `shifts/${SHIFT}`, { name: `Turno Proj ${tag}`, nameSlug: "turno-proj", status: "active" });
  await writeDemoDoc(targetFromEnv(), `classes/pjk_${tag}`, { name: `Turma Proj ${tag}`, nameSlug: "turma-proj", status: "active" });
  created.push(`shifts/${SHIFT}`, `classes/pjk_${tag}`);
  [admin, secretaria, guardian] = await Promise.all([createTestUser("pjadm", "admin"), createTestUser("pjsec", "secretaria", { displayName: "Secretaria Projeção" }), createTestUser("pjresp", "guardian")]);
});

afterAll(async () => {
  const db = adminDb();
  for (const path of created.splice(0)) await db.doc(path).delete();
  await db.recursiveDelete(db.collection("reportDays"));
});

/* ---------------------------------------------------------------------------------------------------- apoio */

const db = () => adminDb();
const at = (date: string, time = "12:00") => Timestamp.fromDate(school.localInstant(date, time));
const actor = (u: TestUser, role: "admin" | "secretaria" | "cantina") => ({ uid: u.uid, role });
const track = async (path: string, data: Record<string, unknown>) => {
  created.push(path);
  await db().doc(path).set(data);
};

/** Venda sintética (baixa de estoque + venda direta de origem) carimbada em `date`. Receita em centavos; custo em centavos. */
async function sale(date: string, revenueCents: number, costCents: number, units = 1, productId = PID): Promise<string> {
  const id = `${tag}s${++seq}`;
  await track(`directSales/${id}`, { shiftId: SHIFT, totalCents: revenueCents, items: [{ productId, name: `Produto ${productId}`, categoryId: CAT }], createdAt: at(date) });
  await track(`stockCosts/${productId}/movements/m${String(1000 + seq).padStart(9, "0")}`, { seq: 1000 + seq, type: "sale_exit", quantity: -units, totalCostMicros: -costCents * 1_000_000, revenueCents, referenceType: "directSale", referenceId: id, createdAt: at(date) });
  return id;
}
async function loss(date: string, units: number, costCents: number, productId = PID) {
  await track(`stockCosts/${productId}/movements/m${String(5000 + ++seq).padStart(9, "0")}`, { seq: 5000 + seq, type: "loss", quantity: -units, totalCostMicros: -costCents * 1_000_000, reasonCode: "breakage", referenceType: "loss", referenceId: `l${seq}`, createdAt: at(date) });
}
async function entry(date: string, type: string, amountCents: number) {
  await track(`wallets/${tag}stu/entries/e${++seq}`, { type, amountCents, createdAt: at(date) });
}
async function cancellation(date: string, refundCents: number, units = 1, productId = PID) {
  const order = `${tag}o${++seq}`;
  await track(`orders/${order}`, { channel: "advance", shiftId: SHIFT, status: "cancelled", items: [{ productId, name: `Produto ${productId}`, categoryId: CAT }] });
  await track(`orders/${order}/cancellations/c${seq}`, { kind: "family", lines: [{ productId, name: `Produto ${productId}`, quantity: units, refundCents }], createdAt: at(date) });
}

const asAdmin = () => actor(admin, "admin");
/** Escola inteira (sem filtro): é onde existem livro, taxas, recebimentos e conferências. */
const ALL: Record<string, string> = {};
const report = async (range: { from: string; to: string }, clock: () => Date = () => new Date(), opts: Parameters<typeof reports.salesReport>[4] = {}, filters: Record<string, string> = { productId: PID }): Promise<Full> =>
  (await reports.salesReport(db(), asAdmin(), { ...range, ...filters }, clock, opts)) as unknown as Full;
const verify = async (from: string, to: string, mode: "verify" | "rebuild" = "verify", clock: () => Date = () => new Date(), opts: Parameters<typeof reports.maintainDays>[4] = {}) => reports.maintainDays(db(), asAdmin(), { mode, from, to }, clock, opts);
const meta = async (date: string) => (await db().doc(`reportDays/${date}`).get()).data() as { digest: string; parts: number; schemaVersion: number; sourceCounts: Record<string, number> } | undefined;
const wipeDay = (date: string) => db().recursiveDelete(db().doc(`reportDays/${date}`));
const wipeAll = () => db().recursiveDelete(db().collection("reportDays"));
const dayUnits = (r: Full, date: string) => r.realized.byDay.find((x) => x.key === date)?.units ?? 0;

async function call(key: string, user: TestUser, method: string, url: string, body: unknown, id = ""): Promise<{ status: number; body: Json }> {
  const request = new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${user.idToken}` }, body: JSON.stringify(body) });
  const response = await routes[key]!(request, id ? { params: Promise.resolve({ id }) } : noCtx);
  return { status: response.status, body: (await response.json()) as Json };
}

/* ------------------------------------------------------------------------------ eventos posteriores e invalidação */

describe("dia fechado: eventos posteriores caem no dia em que acontecem; fato tardio invalida o dia", () => {
  it("reembolso, estorno e perda DEPOIS da venda aparecem no dia do evento; o dia da venda continua igual ao das fontes (verify)", async () => {
    await wipeAll();
    await sale(d(-9), 1000, 400, 4); // venda
    await cancellation(d(-7), 250); // reembolso dois dias depois
    await entry(d(-7), "order_refund", 250);
    await entry(d(-7), "topup_reversal", -300); // estorno de recarga no mesmo dia do reembolso
    await loss(d(-6), 1, 100); // perda depois
    const first = await report({ from: d(-9), to: d(-5) });
    expect(first.projection).toMatchObject({ builtDays: 5, cachedDays: 0, liveDays: 0 });
    expect([dayUnits(first, d(-9)), dayUnits(first, d(-7))]).toEqual([4, 0]); // a venda é do dia -9; o reembolso não mexe nela
    expect(first.cancellations!.totals).toEqual({ events: 1, units: 1, refundCents: 250 }); // o reembolso é do dia -7
    expect(first.losses!.totals.units).toBe(1);
    const days = (await verify(d(-9), d(-5))).days;
    expect(days.map((x) => x.status)).toEqual(["equal", "equal", "equal", "equal", "equal"]);
    // um evento NOVO (agora) cai no dia de hoje: nenhum dia fechado muda
    await cancellation(BASE, 500);
    expect((await verify(d(-9), d(-5))).days.map((x) => x.status)).toEqual(["equal", "equal", "equal", "equal", "equal"]);
    const again = await report({ from: d(-9), to: d(-5) });
    expect(again.projection).toMatchObject({ cachedDays: 5, builtDays: 0, staleDays: 0 });
    expect(again.cancellations!.totals.refundCents).toBe(250);
  });

  it("documento tardio carimbado em dia já materializado (reembolso, estorno e troca com carimbo antigo) muda a contagem das fontes: o dia é descartado e reconstruído sozinho", async () => {
    const before = await report({ from: d(-9), to: d(-5) });
    expect(before.projection.cachedDays).toBe(5);
    const digestBefore = (await meta(d(-7)))!.digest;
    await cancellation(d(-7), 400, 2); // reembolso tardio no dia -7
    await entry(d(-7), "order_refund", 400);
    await entry(d(-7), "order_exchange", -120); // troca com cobrança
    const healed = await report({ from: d(-9), to: d(-5) }, () => new Date(), {}, ALL);
    expect(healed.projection).toMatchObject({ staleDays: 1, builtDays: 1, cachedDays: 4 }); // só o dia -7 foi reconstruído
    expect(healed.cancellations!.totals).toEqual({ events: 2, units: 3, refundCents: 650 });
    expect(healed.checks.find((c) => c.id === "refunds_ledger")?.ok).toBe(true); // livro e cancelamentos conferem de novo
    expect((await meta(d(-7)))!.digest).not.toBe(digestBefore);
    expect((await verify(d(-9), d(-5))).days.map((x) => x.status)).toEqual(["equal", "equal", "equal", "equal", "equal"]);
    const stable = await report({ from: d(-9), to: d(-5) });
    expect(stable.projection).toMatchObject({ cachedDays: 5, staleDays: 0, builtDays: 0 });
  });

  it("documento de origem REMOVIDO depois da materialização também invalida o dia", async () => {
    const victim = created.find((p) => p.includes(`stockCosts/${PID}/movements/`))!;
    await db().doc(victim).delete();
    const r = await report({ from: d(-9), to: d(-9) });
    expect(r.projection).toMatchObject({ staleDays: 1, builtDays: 1 });
    expect(dayUnits(r, d(-9))).toBe(0);
  });
});

/* ------------------------------------------------------- projeção ausente, antiga, incompleta, adulterada ou com falha */

describe("projeção ausente, antiga, incompleta, adulterada ou com falha: o relatório continua correto", () => {
  const range = () => ({ from: d(-12), to: d(-12) });
  const rebuilt = async (stats: Partial<Stats>) => {
    const r = await report(range());
    expect(r.projection).toMatchObject(stats);
    expect(dayUnits(r, d(-12))).toBe(3);
    expect((await report(range())).projection).toMatchObject({ cachedDays: 1, builtDays: 0, repairedDays: 0, staleDays: 0 });
    return r;
  };

  it("monta o dia de referência", async () => {
    await wipeDay(d(-12));
    await sale(d(-12), 600, 200, 3);
    const r = await report(range());
    expect(r.projection).toMatchObject({ builtDays: 1 });
    expect(dayUnits(r, d(-12))).toBe(3);
  });

  it("resumo de OUTRA VERSÃO é descartado e o dia é reconstruído", async () => {
    await db().doc(`reportDays/${d(-12)}`).update({ schemaVersion: 1 });
    await rebuilt({ repairedDays: 1, builtDays: 1 });
  });

  it("parte AUSENTE e resumo apontando mais partes do que existem são reconstruídos", async () => {
    await db().doc(`reportDays/${d(-12)}/parts/p000`).delete();
    await rebuilt({ repairedDays: 1, builtDays: 1 });
    await db().doc(`reportDays/${d(-12)}`).update({ parts: 3 });
    await rebuilt({ repairedDays: 1, builtDays: 1 });
  });

  it("parte ilegível (JSON quebrado) e resumo sem a contagem das fontes são reconstruídos", async () => {
    await db().doc(`reportDays/${d(-12)}/parts/p000`).update({ json: "{ isto não é json" });
    await rebuilt({ repairedDays: 1, builtDays: 1 });
    await db().doc(`reportDays/${d(-12)}`).update({ sourceCounts: null });
    await rebuilt({ repairedDays: 1, builtDays: 1 });
  });

  it("só as partes, sem resumo (queda antes de gravar o resumo) = ausente: reconstrói e grava o resumo", async () => {
    await db().doc(`reportDays/${d(-12)}`).delete();
    expect(await meta(d(-12))).toBeUndefined();
    const r = await report(range());
    expect(r.projection).toMatchObject({ builtDays: 1, repairedDays: 0 });
    expect(await meta(d(-12))).toBeDefined();
  });

  it("queda entre as partes e o resumo durante uma reconstrução: o relatório sai certo e o cache antigo não é aceito depois", async () => {
    await sale(d(-12), 200, 50, 1); // muda o dia: o cache fica obsoleto (contagem)
    const failing = await report(range(), () => new Date(), { hooks: { beforeMeta: async () => { throw new Error("queda simulada"); } } });
    expect(failing.projection).toMatchObject({ staleDays: 1, cacheErrors: 1, builtDays: 0 });
    expect(dayUnits(failing, d(-12))).toBe(4); // números certos mesmo sem gravar
    // as PARTES novas já estavam gravadas e o resumo continua o antigo (partes primeiro, resumo por último)
    const oldDigest = (await meta(d(-12)))!.digest;
    const partNow = JSON.parse((await db().doc(`reportDays/${d(-12)}/parts/p000`).get()).get("json") as string) as { sales: unknown[] };
    expect(partNow.sales).toHaveLength(2);
    const next = await report(range());
    expect(next.projection).toMatchObject({ builtDays: 1, repairedDays: 1 }); // partes novas + resumo antigo: o digest não confere, descarta e reconstrói
    expect((await meta(d(-12)))!.digest).not.toBe(oldDigest);
    expect(dayUnits(next, d(-12))).toBe(4);
    expect((await report(range())).projection).toMatchObject({ cachedDays: 1 });
  });

  it("falha de gravação do cache não derruba o relatório", async () => {
    await wipeDay(d(-12));
    const r = await report(range(), () => new Date(), { hooks: { failWrite: () => true } });
    expect(r.projection).toMatchObject({ cacheErrors: 1, builtDays: 0, liveDays: 1 });
    expect(dayUnits(r, d(-12))).toBe(4);
    expect(await meta(d(-12))).toBeUndefined();
  });

  it("fontes que mudam DURANTE a reconstrução: o dia é usado agora, NÃO é gravado, e a leitura seguinte (estável) o inclui", async () => {
    await wipeDay(d(-12));
    const racing = await report(range(), () => new Date(), { hooks: { afterRead: async () => void (await sale(d(-12), 100, 10, 1)) } });
    expect(racing.projection).toMatchObject({ unstableDays: 1, builtDays: 0, liveDays: 1 });
    expect(await meta(d(-12))).toBeUndefined();
    const settled = await report(range());
    expect(settled.projection).toMatchObject({ builtDays: 1, unstableDays: 0 });
    expect(dayUnits(settled, d(-12))).toBe(5); // a venda que apareceu durante a corrida entrou
  });

  it("a manutenção distingue ausente, inválido, divergente e instável sem gravar no verify", async () => {
    await wipeDay(d(-12));
    expect((await verify(d(-12), d(-12))).days[0]!.status).toBe("missing");
    await report(range());
    await db().doc(`reportDays/${d(-12)}`).update({ schemaVersion: 1 });
    expect((await verify(d(-12), d(-12))).days[0]!.status).toBe("invalid");
    expect((await verify(d(-12), d(-12), "rebuild")).days[0]!.status).toBe("rebuilt");
    const unstable = await verify(d(-12), d(-12), "verify", () => new Date(), { hooks: { afterRead: async () => void (await sale(d(-12), 100, 10, 1)) } });
    expect(unstable.days[0]!.status).toBe("unstable");
    expect((await verify(d(-12), d(-12))).days[0]!.status).toBe("diverged"); // a contagem mudou desde a materialização
    expect((await verify(d(-12), d(-12), "rebuild")).days[0]!.status).toBe("rebuilt");
    expect((await verify(d(-12), d(-12), "rebuild")).days[0]!.status).toBe("unchanged");
  });
});

/* ------------------------------------------------------ custo e lucro nos documentos persistidos / visão da cantina */

describe("custo e lucro nos documentos persistidos", () => {
  it("o resumo e as partes guardam custo (só o servidor lê); a visão operacional montada a partir do cache não tem custo; nada de aluno nas partes", async () => {
    await wipeDay(d(-11));
    await sale(d(-11), 900, 300, 3);
    await track(`students/${tag}stu`, { name: `Aluno Persistência ${tag}`, status: "active" });
    await entry(d(-11), "topup", 5000);
    const full = await report({ from: d(-11), to: d(-11) });
    expect(full.projection.builtDays).toBe(1);
    const parts = await db().collection(`reportDays/${d(-11)}/parts`).get();
    const raw = parts.docs.map((x) => x.get("json") as string).join("");
    expect(raw).toContain("costMicros"); // o custo existe na parte (por isso o cache é fechado ao cliente)
    expect(raw).not.toContain(`Aluno Persistência ${tag}`); // nenhum nome de aluno
    expect(raw).not.toMatch(/@|email|password/i);
    const cantina = await createTestUser("pjcan", "cantina");
    const op = (await reports.salesReport(db(), actor(cantina, "cantina"), { from: d(-11), to: d(-11), productId: PID }, () => new Date())) as unknown as Record<string, unknown> & { projection: Stats };
    expect(op.projection.cachedDays).toBe(1); // veio do cache
    expect(op.projection.reads).toBeUndefined(); // a estimativa de leituras é da administração
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
      }
    };
    walk(op);
    expect(keys.filter((k) => /cost|cogs|profit|margin|fee|result|purchase|ledger|wallet|estimate|check|reads/i.test(k))).toEqual([]);
    expect((op.realized as { totals: { revenueCents: number } }).totals.revenueCents).toBe(900);
  });
});

/* ------------------------------------------------ conferência de taxa e liquidação (F20) ao vivo, sem reconstruir */

describe("conferência de taxa e liquidação não exige reconstruir o dia; estorno de recarga tardio invalida", () => {
  const later = () => school.localInstant(d(2), "12:00");
  let student = "";
  let pixRef = "";
  let cardRef = "";
  let pixId = "";

  it("registra recebimentos reais (Pix com taxa informada, cartão pendente) e materializa o dia (relógio adiantado)", async () => {
    student = `${tag}fs`;
    await seedStudentAccess({ studentId: student, name: `Aluno Taxa ${tag}`, guardianUids: [guardian.uid], allowSitePurchase: true, allowCounterPurchase: false });
    await writeDemoDoc(targetFromEnv(), `students/${student}`, { name: `Aluno Taxa ${tag}`, enrollment: `T${tag}`, status: "active", userUid: null, shiftId: SHIFT, classId: `pjk_${tag}`, version: 1 });
    await writeDemoDoc(targetFromEnv(), `studentPolicies/${student}`, { allowSitePurchase: true, allowCounterPurchase: false, configVersion: 1 });
    const pix = await call("POST topups", secretaria, "POST", "/api/topups", { key: randomUUID(), studentId: student, amountCents: 4000, method: "pix", receivedConfirmed: true, reference: `PJ${tag}P${Date.now()}`, feeCents: 40 });
    expect(pix.status, JSON.stringify(pix.body)).toBe(200);
    pixId = String(pix.body.topupId);
    pixRef = `topup:${pixId}`;
    const card = await call("POST topups", secretaria, "POST", "/api/topups", { key: randomUUID(), studentId: student, amountCents: 3000, method: "card_credit", receivedConfirmed: true, reference: `PJ${tag}C${Date.now()}` });
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    cardRef = `topup:${String(card.body.topupId)}`;
    await wipeDay(BASE);
    const r = await report({ from: BASE, to: BASE }, later, {}, ALL);
    expect(r.projection).toMatchObject({ builtDays: 1 });
    expect(r.receipts!.feeInformedCents).toBeGreaterThanOrEqual(40);
    expect(r.receipts!.pendingGrossCents).toBeGreaterThanOrEqual(3000); // cartão aprovado ≠ liquidado
  });

  it("conferir a taxa real e a liquidação muda taxas e liquidação AO VIVO; o dia do cache segue válido (sem reconstruir)", async () => {
    const before = await report({ from: BASE, to: BASE }, later, {}, ALL);
    expect(before.projection).toMatchObject({ cachedDays: 1, builtDays: 0 });
    const digest = (await meta(BASE))!.digest;
    const pix = await call("POST reconcile", admin, "POST", "/api/admin/finance/reconcile", { key: randomUUID(), ref: pixRef, expectedVersion: 0, actualFeeCents: 38 });
    expect(pix.status, JSON.stringify(pix.body)).toBe(200);
    const card = await call("POST reconcile", admin, "POST", "/api/admin/finance/reconcile", { key: randomUUID(), ref: cardRef, expectedVersion: 0, actualFeeCents: 90, settledOn: BASE });
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    const after = await report({ from: BASE, to: BASE }, later, {}, ALL);
    expect(after.projection).toMatchObject({ cachedDays: 1, builtDays: 0, staleDays: 0, repairedDays: 0 }); // nada foi reconstruído
    expect((await meta(BASE))!.digest).toBe(digest);
    expect(after.receipts!.feeConfirmedCents - before.receipts!.feeConfirmedCents).toBe(38 + 90);
    expect(before.receipts!.feeInformedCents - after.receipts!.feeInformedCents).toBe(40); // a taxa informada virou conferida (uma só por recebimento)
    expect(after.receipts!.settledGrossCents - before.receipts!.settledGrossCents).toBe(3000);
    expect(before.receipts!.pendingGrossCents - after.receipts!.pendingGrossCents).toBe(3000);
    expect(before.fees!.unknownCount - after.fees!.unknownCount).toBe(1); // o cartão deixou de ter taxa desconhecida
  });

  it("estorno de recarga feito depois da materialização (evento novo no dia) invalida o dia e entra no livro; o crédito original não muda", async () => {
    const before = await report({ from: BASE, to: BASE }, later, {}, ALL);
    const credit = before.ledger!.rows.find((x) => x.type === "topup")!.amountCents;
    const reversal = await call("POST reverse", admin, "POST", `/api/topups/${pixId}/reverse`, { key: randomUUID(), amountCents: 1000, reasonCode: "registration_error", reason: "Valor digitado errado na recarga", expectedReversedCents: 0 }, pixId);
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(200);
    const after = await report({ from: BASE, to: BASE }, later, {}, ALL);
    expect(after.projection).toMatchObject({ staleDays: 1, builtDays: 1 });
    expect(after.ledger!.rows.find((x) => x.type === "topup_reversal")!.amountCents).toBe((before.ledger!.rows.find((x) => x.type === "topup_reversal")?.amountCents ?? 0) - 1000);
    expect(after.ledger!.rows.find((x) => x.type === "topup")!.amountCents).toBe(credit);
    expect(after.checks.filter((c) => /^(units|revenue|cost)_/.test(c.id)).every((c) => c.ok)).toBe(true);
  });
});

/* ----------------------------------------------------------- posição de pedidos a realizar: janela de leitura */

describe("pedidos a realizar: a janela limita a leitura; os antigos são só contados e ficam visíveis", () => {
  const openOrder = async (date: string) => {
    const id = `${tag}w${++seq}`;
    await track(`orders/${id}`, { status: "paid", channel: "advance", shiftId: SHIFT, consumptionDate: date, items: [{ lineNo: 1, productId: PID, name: "Produto janela", categoryId: CAT, quantity: 1, subtotalCents: 100 }], totalCents: 100 });
  };
  const open = async () => {
    const { result, tally } = await measureReads(db(), () => report({ from: BASE, to: BASE }, () => new Date(), {}, {}));
    const reads = result.projection.reads!.byLabel["pedidos em aberto (posição de hoje)"] ?? 0;
    const older = (result.pendencies as { code: string; count: number }[]).find((x) => x.code === "pending_older")?.count ?? 0;
    return { result, tally, reads, older };
  };

  it("30 pedidos abertos de 100 dias atrás NÃO viram 30 leituras: só entram na contagem (pendência pending_older); os da janela são lidos", async () => {
    const before = await open();
    for (let i = 0; i < 30; i += 1) await openOrder(d(-100));
    const inside = [d(-3), d(2)];
    for (const date of inside) await openOrder(date);
    const after = await open();
    expect(after.older - before.older).toBe(30);
    expect(after.reads - before.reads).toBeLessThanOrEqual(2); // só os 2 da janela (a consulta vazia já custava 1)
    expect(after.tally.byLabel["colecao:orders"]! - before.tally.byLabel["colecao:orders"]!).toBeLessThanOrEqual(2);
    expect(after.tally.byLabel["agregacao"]!).toBeGreaterThanOrEqual(before.tally.byLabel["agregacao"]!);
    const pending = after.result.pending as unknown as { totals: { orders: number } };
    expect(pending.totals.orders).toBeGreaterThanOrEqual(2);
    expect((after.result.pendencies as { code: string; blocksResult: boolean }[]).find((x) => x.code === "pending_older")).toMatchObject({ blocksResult: false });
  });
});

/* ------------------------------------------------------------------------------------- custo de consulta medido */

describe("custo de consulta (estimativa por interceptação no cliente Admin, não é a cobrança oficial)", () => {
  const DAYS = 8;
  const from = () => d(-30);
  const to = () => d(-30 + DAYS - 1);
  const LOG = process.env.F21_READ_COST_LOG;
  const note = (line: string) => {
    if (!LOG) return;
    mkdirSync(".agent-logs", { recursive: true });
    appendFileSync(LOG, `${line}\n`);
  };
  const row = (label: string, run: { tally: { total: number; calls: number; byLabel: Record<string, number> }; stats: Stats }) =>
    note(`${label.padEnd(44)} leituras(intercept.)=${String(run.tally.total).padStart(4)}  chamadas=${String(run.tally.calls).padStart(3)}  estimativa do servidor=${String(run.stats.reads?.estimatedReads ?? "-").padStart(4)}  dias: cache=${run.stats.cachedDays} novos=${run.stats.builtDays} obsoletos=${run.stats.staleDays}  fontes=${["grupo:movements", "grupo:cancellations", "grupo:entries", "colecao:stockReceipts"].map((k) => run.tally.byLabel[k] ?? 0).join("/")}`);
  const measured = async (opts: { filters?: Record<string, string> } = {}) => {
    const { result, tally } = await measureReads(db(), () => report({ from: from(), to: to() }, () => new Date(), {}, opts.filters ?? {}));
    return { tally, stats: result.projection, result };
  };
  const SOURCE_LABELS = ["grupo:movements", "grupo:cancellations", "grupo:entries", "colecao:stockReceipts"];

  it("semeia 8 dias fechados (10 baixas, 2 perdas, 1 entrada, 3 lançamentos e 1 cancelamento por dia)", async () => {
    await wipeAll();
    note(`# F21 — custo de consulta medido no emulador (${new Date().toISOString()}; ${DAYS} dias fechados, cada um com 17 documentos de fonte + 10 vendas de origem)`);
    for (let i = 0; i < DAYS; i += 1) {
      const day = d(-30 + i);
      for (let k = 0; k < 10; k += 1) await sale(day, 100 + k, 40, 1, k % 2 === 0 ? PID : PID2);
      await loss(day, 1, 10);
      await loss(day, 1, 10, PID2);
      await track(`stockReceipts/${tag}r${++seq}`, { productId: PID, kind: "purchase", quantity: 5, totalCostMicros: 500_000_000, status: "active", createdAt: at(day) });
      await entry(day, "topup", 1000);
      await entry(day, "advance_purchase", -400);
      await entry(day, "order_refund", 100);
      await cancellation(day, 100);
    }
  });

  let cold: Awaited<ReturnType<typeof measured>>;
  it("1ª construção (a frio): lê as fontes de cada dia UMA vez e grava o cache", async () => {
    cold = await measured();
    row("1) primeira construção (8 dias, sem filtro)", cold);
    expect(cold.stats).toMatchObject({ builtDays: DAYS, cachedDays: 0, staleDays: 0 });
    expect(cold.tally.byLabel["grupo:movements"]).toBe(DAYS * 12); // 10 vendas + 2 perdas por dia, cada documento UMA vez
    expect(cold.stats.reads!.estimatedWrites).toBe(DAYS * 2); // 1 parte + 1 resumo por dia
  });

  it("abertura repetida do MESMO período: nenhuma consulta às fontes (só contagens, resumo e partes do cache e posições de hoje)", async () => {
    const again = await measured();
    row("2) reabrir o mesmo período", again);
    expect(again.stats).toMatchObject({ cachedDays: DAYS, builtDays: 0, staleDays: 0 });
    for (const label of SOURCE_LABELS) expect(again.tally.byLabel[label] ?? 0, label).toBe(0); // não relê o histórico
    // nem os pedidos/vendas de origem: o único `getAll` possível é o custo médio ATUAL dos produtos dos pedidos em aberto (posição de hoje)
    expect(again.tally.byLabel["getAll"] ?? 0).toBe(again.stats.reads!.byLabel["custo médio atual"] ?? 0);
    expect(again.stats.reads!.byLabel["fontes: pedidos/vendas de origem"]).toBeUndefined();
    expect(again.tally.total - (again.tally.byLabel["colecao:orders"] ?? 0)).toBeLessThan(cold.tally.total / 3);
    // orçamento por dia: resumo + parte + 5 contagens (≥ 1 cada) = 7; o resto é constante (cadastros, posições de hoje, F20)
    expect(again.tally.byLabel["agregacao"]!).toBeLessThanOrEqual(DAYS * 5 + 6 + 2); // 5 contagens por dia + 6 contagens de pedidos em aberto antigos + saldo das carteiras
    expect(again.tally.byLabel["doc:reportDays"]!).toBe(DAYS);
    const otherReads = again.tally.total - (again.tally.byLabel["colecao:orders"] ?? 0); // pedidos em aberto de outros arquivos de teste não são do período
    expect(otherReads).toBeLessThanOrEqual(DAYS * 7 + 40);
    // a estimativa do servidor acompanha a interceptação (mesma ordem de grandeza)
    expect(Math.abs(again.stats.reads!.estimatedReads - again.tally.total)).toBeLessThanOrEqual(15);
    expect(again.stats.reads!.byLabel["cache: resumo do dia"]).toBe(DAYS);
    note(`   orçamento reaberto: ${again.tally.total} leituras = ${DAYS} dias × 7 (resumo, parte, 5 contagens) + ${again.tally.total - DAYS * 7} de posições de hoje/cadastros`);
  });

  it("mudar de filtro não relê as fontes (o cache é do dia inteiro; o recorte é em memória)", async () => {
    const filtered = await measured({ filters: { productId: PID, shiftId: SHIFT } });
    row("3) mudar de filtro (produto + turno)", filtered);
    expect(filtered.stats).toMatchObject({ cachedDays: DAYS, builtDays: 0 });
    for (const label of SOURCE_LABELS) expect(filtered.tally.byLabel[label] ?? 0, label).toBe(0);
    const channel = await measured({ filters: { channel: "direct" } });
    row("3b) mudar de filtro (canal)", channel);
    for (const label of SOURCE_LABELS) expect(channel.tally.byLabel[label] ?? 0, label).toBe(0);
  });

  it("uma alteração tardia em UM dia reconstrói só esse dia (as fontes dos outros 7 não são relidas)", async () => {
    await sale(d(-30 + 3), 777, 100, 1); // documento tardio no 4º dia
    const run = await measured();
    row("4) após alteração em 1 dia (reconstrói 1)", run);
    expect(run.stats).toMatchObject({ staleDays: 1, builtDays: 1, cachedDays: DAYS - 1 });
    // fontes lidas = só o dia alterado, 2 vezes não: 1 leitura de cada fonte para esse dia (11 movimentos + 1 de origem...)
    expect(run.tally.byLabel["grupo:movements"]).toBe(10 + 1 + 2); // 10 vendas + 1 tardia + 2 perdas do dia reconstruído
    expect(run.tally.byLabel["grupo:cancellations"]).toBe(1);
    expect(run.tally.byLabel["colecao:stockReceipts"]).toBe(1);
    expect(run.tally.total - (run.tally.byLabel["colecao:orders"] ?? 0)).toBeLessThan(cold.tally.total / 2);
  });

  it("reconstrução administrativa de 1 dia: lê só as fontes desse dia; verify de todo o período lê as fontes de cada dia (custo explícito)", async () => {
    const { result: rebuild, tally: t1 } = await measureReads(db(), () => verify(d(-30), d(-30), "rebuild"));
    note(`5) rebuild de 1 dia (admin)                      leituras(intercept.)=${String(t1.total).padStart(4)}  estimativa do servidor=${rebuild.estimatedReads}  status=${rebuild.days[0]!.status}`);
    expect(rebuild.days[0]!.status).toBe("unchanged");
    expect(t1.byLabel["grupo:movements"]).toBe(12);
    const { result: all, tally: t2 } = await measureReads(db(), () => verify(from(), to(), "verify"));
    note(`6) verify de ${DAYS} dias (admin, relê as fontes)        leituras(intercept.)=${String(t2.total).padStart(4)}  estimativa do servidor=${all.estimatedReads}  todos=${all.days.every((x) => x.status === "equal")}`);
    expect(all.days.every((x) => x.status === "equal")).toBe(true);
    expect(t2.byLabel["grupo:movements"]).toBeGreaterThanOrEqual(DAYS * 12);
  });
});
