// Taxas, liquidação e relatório financeiro (F20) contra Auth/Firestore Emulator. Prova: cadastro e versionamento imutável das regras
// (vigência nunca retroativa; mudar a regra não reescreve lançamento), estimativa congelada com a versão aplicada, estimativa × real
// sem soma dupla (A29), A04 (taxa só no recebimento; a compra com saldo não a carrega), conferência idempotente e sem efeito na
// carteira, regra FICTÍCIA recusada/ignorada em produção, autorização (secretaria/cantina não veem regras nem relatórios) e relatório
// × exportação mensal conferindo com os detalhes (A28). Regras e valores são FICTÍCIOS; o provedor online é o roteirizado.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { fakeMercadoPago } from "../helpers/fake-mercadopago";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
type Result = { status: number; body: Json };

let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let school: typeof import("@/lib/dates/school-time");
let topupCommands: typeof import("@/modules/payments/topup-commands");
let posCommands: typeof import("@/modules/pos/commands");
let reportMod: typeof import("@/modules/reports/finance-report");
let intents: typeof import("@/modules/payments/online/intent-commands");
let confirmation: typeof import("@/modules/payments/online/confirmation");
let checkLedger: typeof import("@/modules/wallet/model").checkLedger;
let parseWalletState: typeof import("@/modules/wallet/model").parseWalletState;
const routes: Record<string, Handler> = {};

let admin: TestUser;
let secretaria: TestUser;
let cantina: TestUser;
let guardian: TestUser;
let studentUser: TestUser;

const tag = randomUUID().slice(0, 6);
const code = `t${tag}`; // código do terminal fictício (2–24 minúsculas/dígitos)
const TERMINAL = `term_${code}`;
const PROVIDER = "prov_mercadopago";
const ST = `fsf_${tag}_t`;
const CLS = `fcl_${tag}`;
const CAT = `fct_${tag}`;
let BASE = "";
let D = ""; // dia ISOLADO deste arquivo (hoje + 40): nenhum outro arquivo registra nele, então os totais do relatório são exatos
let seq = 0;
const noCtx = { params: Promise.resolve({ id: "" }) };

const ADMIN_ROUTES: [string, string, string][] = [
  ["GET", "admin/finance/fees/route", "/api/admin/finance/fees"],
  ["POST", "admin/finance/sources/route", "/api/admin/finance/sources"],
  ["POST", "admin/finance/sources/active/route", "/api/admin/finance/sources/active"],
  ["POST", "admin/finance/rules/route", "/api/admin/finance/rules"],
  ["POST", "admin/finance/rules/withdraw/route", "/api/admin/finance/rules/withdraw"],
  ["GET", "admin/finance/receipts/route", "/api/admin/finance/receipts"],
  ["POST", "admin/finance/reconcile/route", "/api/admin/finance/reconcile"],
  ["GET", "admin/finance/report/route", "/api/admin/finance/report?from=2026-10-01&to=2026-10-02"],
  ["GET", "admin/finance/export/route", "/api/admin/finance/export?month=2026-10"],
  ["GET", "admin/finance/cash/route", "/api/admin/finance/cash"],
];
const LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  "admin/finance/fees/route": () => import("@/app/api/admin/finance/fees/route"),
  "admin/finance/sources/route": () => import("@/app/api/admin/finance/sources/route"),
  "admin/finance/sources/active/route": () => import("@/app/api/admin/finance/sources/active/route"),
  "admin/finance/rules/route": () => import("@/app/api/admin/finance/rules/route"),
  "admin/finance/rules/withdraw/route": () => import("@/app/api/admin/finance/rules/withdraw/route"),
  "admin/finance/receipts/route": () => import("@/app/api/admin/finance/receipts/route"),
  "admin/finance/reconcile/route": () => import("@/app/api/admin/finance/reconcile/route"),
  "admin/finance/report/route": () => import("@/app/api/admin/finance/report/route"),
  "admin/finance/export/route": () => import("@/app/api/admin/finance/export/route"),
  "admin/finance/cash/route": () => import("@/app/api/admin/finance/cash/route"),
};

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  delete process.env.PAYMENTS_PIX_PROVIDER;
  delete process.env.PAYMENTS_CARD_PROVIDER;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  school = await import("@/lib/dates/school-time");
  topupCommands = await import("@/modules/payments/topup-commands");
  posCommands = await import("@/modules/pos/commands");
  reportMod = await import("@/modules/reports/finance-report");
  intents = await import("@/modules/payments/online/intent-commands");
  confirmation = await import("@/modules/payments/online/confirmation");
  ({ checkLedger, parseWalletState } = await import("@/modules/wallet/model"));
  for (const [method, file] of ADMIN_ROUTES) routes[`${method} ${file}`] = (await LOADERS[file]!())[method] as unknown as Handler;
  routes["GET finance/terminals"] = (await import("@/app/api/finance/terminals/route")).GET as unknown as Handler;
  routes["POST inventory"] = (await import("@/app/api/inventory/receipts/route")).POST as unknown as Handler;
  routes["POST pos sales"] = (await import("@/app/api/pos/sales/route")).POST as unknown as Handler;
  BASE = school.localDateOf(new Date());
  D = school.addDays(BASE, 40);
  [admin, secretaria, cantina, guardian, studentUser] = await Promise.all([
    createTestUser("fadm", "admin", { displayName: "Admin Financeiro" }),
    createTestUser("fsec", "secretaria", { displayName: "=2+2 Secretaria" }), // nome que seria fórmula numa planilha
    createTestUser("fcan", "cantina", { displayName: "Cantina Teste" }),
    createTestUser("fresp", "guardian"),
    createTestUser("falu", "student"),
  ]);
  await globalDoc(`shifts/${ST}`, { name: `Tarde ${tag}`, nameSlug: "tarde", status: "active" });
  await globalDoc(`classes/${CLS}`, { name: `Turma ${tag}`, nameSlug: "turma", status: "active" });
  await globalDoc(`categories/${CAT}`, { name: `Categoria ${tag}`, status: "active" });
  await globalDoc(`calendarDays/${BASE}`, { kind: "extra" });
  await globalDoc(`calendarDays/${D}`, { kind: "extra" });
});

const globalDocs: string[] = [];
const globalDoc = async (path: string, data: Record<string, string | number | boolean | null | string[]>) => {
  globalDocs.push(path);
  await writeDemoDoc(targetFromEnv(), path, data);
};
const cleanup: string[] = [`paymentSources/${TERMINAL}`, `paymentSources/${PROVIDER}`, `feeSeries/${TERMINAL}__card_credit`, `feeSeries/${TERMINAL}__card_debit`, `feeSeries/${PROVIDER}__pix`];
afterAll(async () => {
  for (const path of [...globalDocs.splice(0), ...cleanup.splice(0)]) await db().doc(path).delete();
});

/* ------------------------------------------------------------------------------------------------- apoio */

const db = () => adminDb();
const doc = async (path: string) => (await db().doc(path).get()).data();
const actorOf = (u: TestUser, role: "admin" | "secretaria" | "cantina" | "guardian") => ({ uid: u.uid, role });
const at = (date: string, time = "12:00") => () => school.localInstant(date, time);

function authed(method: string, url: string, user: TestUser | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.idToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(key: string, user: TestUser | null, method: string, url: string, body?: unknown): Promise<Result> {
  const response = await routes[key]!(authed(method, url, user, body), noCtx);
  const text = await response.text();
  return { status: response.status, body: (text.startsWith("{") ? JSON.parse(text) : { text }) as Json };
}
const adminPost = (file: string, body: unknown, user: TestUser | null = admin) => call(`POST ${file}`, user, "POST", `/api/${file.replace("/route", "")}`, body);

/** Rodar uma operação "em produção": o app já foi inicializado, então só o que lê APP_ENV na hora muda de comportamento. */
async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    return await fn();
  } finally {
    process.env.APP_ENV = before;
  }
}

let refSeq = 0;
const uniqueRef = () => `F20${tag}${Date.now()}${++refSeq}`;
async function newStudent() {
  const id = `fst_${tag}_${++seq}`;
  const name = `Aluno Taxas ${seq}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardian.uid], allowCounterPurchase: true });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, enrollment: `F${tag}${seq}`, status: "active", userUid: null, shiftId: ST, classId: CLS, version: 1 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: true, allowCounterPurchase: true, configVersion: 1 });
  return id;
}
const topup = (studentId: string, over: Record<string, unknown> = {}, when?: () => Date, by: TestUser = secretaria) =>
  topupCommands.registerManualTopup(db(), actorOf(by, "secretaria"), { key: randomUUID(), studentId, amountCents: 5000, method: "pix", receivedConfirmed: true, reference: uniqueRef(), ...over }, when);

const prices = new Map<string, number>();
async function newProduct(price: number, stock = 300) {
  const id = `fpr_${tag}_${++seq}`;
  await globalDoc(`products/${id}`, { name: `Produto ${seq}`, description: "", categoryId: CAT, priceCents: price, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [ST], availabilityMode: "physical", status: "active", version: 1 });
  await globalDoc(`defaultMenuRules/${id}`, { shiftIds: [ST], version: 1 });
  prices.set(id, price);
  const r = await call("POST inventory", admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: stock, unitCost: "1,00" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return id;
}
const directSale = (productId: string, quantity: number, over: Record<string, unknown> = {}, when?: () => Date) =>
  posCommands.recordDirectSale(db(), actorOf(cantina, "cantina"), { key: randomUUID(), shiftId: ST, lines: [{ productId, quantity, expectedPriceCents: prices.get(productId)! }], paymentMethod: "card_credit", receivedConfirmed: true, ...over }, when);

const ruleBody = (over: Record<string, unknown> = {}) => ({ key: randomUUID(), sourceId: TERMINAL, method: "card_credit", effectiveFrom: BASE, enabled: true, percentBp: 300, fixedCents: 0, settlementDays: 30, fictitious: true, reason: "Regra FICTÍCIA de homologação", ...over });
const seriesDoc = async (sourceId: string, method: string) => (await doc(`feeSeries/${sourceId}__${method}`)) as { versions: Record<string, unknown>[]; versionCount: number } | undefined;
const noRuleLeak = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/percentBp|feeEstimate|fixedCents|settlementDays|ruleVersion|seriesId|\bcost|profit|lucro/i);

async function ledgerOk(studentId: string) {
  const snap = await db().doc(`wallets/${studentId}`).get();
  const entries = (await db().collection(`wallets/${studentId}/entries`).orderBy("seq").get()).docs.map((x) => ({ id: x.id, ...(x.data() as { seq: number; type: string; amountCents: number; balanceAfterCents: number }) }));
  expect(checkLedger({ ...parseWalletState(snap.data()), entries } as never, entries)).toEqual([]);
}
const walletOf = async (studentId: string) => (await doc(`wallets/${studentId}`)) as { balanceCents: number; version: number };

/* ------------------------------------------------------------------------------------- autorização */

describe("autorização: só a administração vê regras, conferência, relatório e exportação", () => {
  it.each(ADMIN_ROUTES)("%s %s: anônimo 401; secretaria, cantina, responsável e aluno 403", async (method, file, url) => {
    const key = `${method} ${file}`;
    const body = method === "POST" ? {} : undefined;
    expect((await call(key, null, method, url, body)).status).toBe(401);
    for (const user of [secretaria, cantina, guardian, studentUser]) expect((await call(key, user, method, url, body)).status, `${file} ${user.email}`).toBe(403);
  });

  it("a secretaria e a cantina listam só NOME e meios das maquininhas (nunca percentuais, prazos ou regras); família não lista", async () => {
    const created = await adminPost("admin/finance/sources/route", { key: randomUUID(), kind: "terminal", code, name: "Maquininha fictícia balcão", methods: ["card_debit", "card_credit"], fictitious: true });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const sec = await call("GET finance/terminals", secretaria, "GET", "/api/finance/terminals");
    expect(sec.status).toBe(200);
    expect(sec.body.terminals).toEqual(expect.arrayContaining([{ sourceId: TERMINAL, name: "[FICTÍCIA] Maquininha fictícia balcão", methods: ["card_debit", "card_credit"] }]));
    noRuleLeak(sec.body);
    expect((await call("GET finance/terminals", cantina, "GET", "/api/finance/terminals")).status).toBe(200);
    expect((await call("GET finance/terminals", guardian, "GET", "/api/finance/terminals")).status).toBe(403);
    expect((await call("GET finance/terminals", null, "GET", "/api/finance/terminals")).status).toBe(401);
  });

  it("rebaixar o perfil da administração derruba o comando inclusive na repetição (perfil relido na transação)", async () => {
    const temp = await createTestUser("ftemp", "admin", { displayName: "Admin Temporário" });
    const body = { key: randomUUID(), kind: "terminal", code: `x${tag}`, name: "Maquininha temporária", methods: ["card_credit"], fictitious: true };
    expect((await adminPost("admin/finance/sources/route", body, temp)).status).toBe(200);
    await writeDemoDoc(targetFromEnv(), `users/${temp.uid}`, { email: temp.email, displayName: "Admin Temporário", role: "secretaria", status: "active", permissions: [], accessVersion: 9 });
    expect((await adminPost("admin/finance/sources/route", body, temp)).status).toBe(403);
    cleanup.push(`paymentSources/term_x${tag}`);
  });
});

/* ------------------------------------------------------------------- cadastro e versionamento */

describe("cadastro e versões imutáveis das regras (A29)", () => {
  it("cadastro duplicado, fonte inexistente e meio fora da fonte são recusados; repetição devolve a mesma resposta", async () => {
    const dup = await adminPost("admin/finance/sources/route", { key: randomUUID(), kind: "terminal", code, name: "Outra com o mesmo código", methods: ["card_credit"], fictitious: true });
    expect(dup).toMatchObject({ status: 409, body: { error: "source_exists" } });
    expect((await adminPost("admin/finance/rules/route", ruleBody({ sourceId: "term_naoexiste" }))).body.error).toBe("source_not_found");
    expect((await adminPost("admin/finance/rules/route", ruleBody({ method: "pix" }))).body.error).toBe("method_not_in_source");
    expect((await adminPost("admin/finance/rules/route", ruleBody({ fictitious: false }))).body.error).toBe("fictitious_mismatch");
    expect((await adminPost("admin/finance/rules/route", ruleBody({ percentBp: 3001 }))).status).toBe(400);
  });

  it("v1 vigente hoje; v2 futura; passado e vigência não posterior recusados; as versões antigas NÃO mudam", async () => {
    const v1 = ruleBody({ percentBp: 300, settlementDays: 30 });
    const r1 = await adminPost("admin/finance/rules/route", v1);
    expect(r1, JSON.stringify(r1.body)).toMatchObject({ status: 200, body: { version: 1, effectiveFrom: BASE, replayed: false } });
    expect((await adminPost("admin/finance/rules/route", v1)).body).toMatchObject({ replayed: true, version: 1 }); // mesma chave: mesma resposta, nada novo
    expect((await adminPost("admin/finance/rules/route", { ...v1, percentBp: 400 })).body.error).toBe("idempotency_conflict");
    expect((await seriesDoc(TERMINAL, "card_credit"))!.versionCount).toBe(1);

    const stored1 = (await seriesDoc(TERMINAL, "card_credit"))!.versions[0]!;
    expect(stored1).toMatchObject({ n: 1, effectiveFrom: BASE, percentBp: 300, fixedCents: 0, settlementDays: 30, fictitious: true, enabled: true, createdByUid: admin.uid, withdrawn: null });

    expect((await adminPost("admin/finance/rules/route", ruleBody({ effectiveFrom: school.addDays(BASE, -1) }))).body.error).toBe("effective_in_past");
    expect((await adminPost("admin/finance/rules/route", ruleBody({ effectiveFrom: BASE, percentBp: 999 }))).body.error).toBe("effective_not_after_last");

    const future = school.addDays(BASE, 10);
    const r2 = await adminPost("admin/finance/rules/route", ruleBody({ effectiveFrom: future, percentBp: 500, settlementDays: 2 }));
    expect(r2.body).toMatchObject({ version: 2, effectiveFrom: future });
    const series = await seriesDoc(TERMINAL, "card_credit");
    expect(series!.versionCount).toBe(2);
    expect(series!.versions[0]).toEqual(stored1); // a versão 1 continua EXATAMENTE igual
    expect((await adminPost("admin/finance/rules/route", ruleBody({ effectiveFrom: school.addDays(future, 1), enabled: false }))).body).toMatchObject({ version: 3 });
  });

  it("a administração enxerga a vigência (em vigor / futura / retirada); versão em vigor não é retirada, a futura é, com motivo", async () => {
    const cfg = await call("GET admin/finance/fees/route", admin, "GET", "/api/admin/finance/fees");
    const series = (cfg.body.series as { seriesId: string; versions: { n: number; state: string }[]; current: { n: number } | null }[]).find((s) => s.seriesId === `${TERMINAL}__card_credit`)!;
    expect(series.current?.n).toBe(1);
    expect(series.versions.map((v) => [v.n, v.state])).toEqual([[1, "in_effect"], [2, "future"], [3, "future"]]);

    const inEffect = await adminPost("admin/finance/rules/withdraw/route", { key: randomUUID(), sourceId: TERMINAL, method: "card_credit", version: 1, reason: "Tentativa de retirar a vigente" });
    expect(inEffect.body.error).toBe("version_in_effect");
    const w3 = { key: randomUUID(), sourceId: TERMINAL, method: "card_credit", version: 3, reason: "Publicada por engano antes de ter vigência" };
    expect((await adminPost("admin/finance/rules/withdraw/route", w3)).body).toMatchObject({ withdrawn: true, version: 3 });
    expect((await adminPost("admin/finance/rules/withdraw/route", { ...w3, key: randomUUID() })).body.error).toBe("already_withdrawn");
    const after = (await seriesDoc(TERMINAL, "card_credit"))!;
    expect(after.versions[2]).toMatchObject({ n: 3, percentBp: 300, withdrawn: { byUid: admin.uid, reason: "Publicada por engano antes de ter vigência" } });
    expect(after.versions[0]).toMatchObject({ n: 1, withdrawn: null });
  });

  it("regra FICTÍCIA é recusada em produção (cadastro e versão); cadastro arquivado não aceita regra nova", async () => {
    const asProd = await inProduction(() => adminPost("admin/finance/rules/route", ruleBody({ sourceId: "default", method: "pix", percentBp: 100 })));
    expect(asProd).toMatchObject({ status: 409, body: { error: "fictitious_in_production" } });
    const prodSource = await inProduction(() => adminPost("admin/finance/sources/route", { key: randomUUID(), kind: "terminal", code: `p${tag}`, name: "Fictícia em produção", methods: ["card_credit"], fictitious: true }));
    expect(prodSource.body.error).toBe("fictitious_in_production");
    expect(await doc(`paymentSources/term_p${tag}`)).toBeUndefined();

    const tmp = `a${tag}`;
    expect((await adminPost("admin/finance/sources/route", { key: randomUUID(), kind: "terminal", code: tmp, name: "Maquininha a arquivar", methods: ["pix"], fictitious: true })).status).toBe(200);
    cleanup.push(`paymentSources/term_${tmp}`);
    expect((await adminPost("admin/finance/sources/active/route", { key: randomUUID(), sourceId: `term_${tmp}`, active: false, reason: "Maquininha devolvida ao banco" })).body).toMatchObject({ active: false });
    expect((await adminPost("admin/finance/rules/route", ruleBody({ sourceId: `term_${tmp}`, method: "pix" }))).body.error).toBe("source_inactive");
    expect((await adminPost("admin/finance/sources/active/route", { key: randomUUID(), sourceId: "default", active: false, reason: "Tentativa de arquivar o padrão" })).body.error).toBe("source_reserved");
    const list = await call("GET finance/terminals", secretaria, "GET", "/api/finance/terminals");
    expect((list.body.terminals as { sourceId: string }[]).some((t) => t.sourceId === `term_${tmp}`)).toBe(false);
  });
});

/* ---------------------------------------------------------- estimativa congelada × valor real (A04/A29) */

describe("estimativa pela regra em vigor, congelada no lançamento; taxa efetiva é UMA só", () => {
  it("R$ 50,00 no cartão a 3,00%: estima R$ 1,50 com a versão 1; crédito segue R$ 50,00; nada de regra vaza para a secretaria", async () => {
    const student = await newStudent();
    const r = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 5000 });
    expect(r).toMatchObject({ creditedCents: 5000, fee: { status: "pending", cents: null }, netCents: null, settlement: { status: "pending", expectedOn: school.addDays(BASE, 30), expectedSource: "rule" } });
    noRuleLeak(r);
    const stored = (await doc(`topups/${r.topupId}`))!;
    expect(stored.feeEstimate).toMatchObject({ cents: 150, seriesId: `${TERMINAL}__card_credit`, ruleVersion: 1, percentBp: 300, fixedCents: 0, settlementDays: 30, fictitious: true, computedOn: BASE, effectiveFrom: BASE });
    expect(stored).toMatchObject({ sourceId: TERMINAL, financeVersion: 0, creditedCents: 5000 });
    expect(await walletOf(student)).toMatchObject({ balanceCents: 5000, version: 1 });
  });

  it("a taxa informada no recebimento vale como REAL e a estimativa fica só para comparação (nunca soma)", async () => {
    const student = await newStudent();
    const r = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 5000, feeCents: 160 });
    expect(r).toMatchObject({ fee: { status: "informed", cents: 160 }, netCents: 4840 });
    const stored = (await doc(`topups/${r.topupId}`))!;
    expect(stored.feeEstimate).toMatchObject({ cents: 150 });
    const detail = await call("GET admin/finance/receipts/route", admin, "GET", `/api/admin/finance/receipts?ref=topup:${r.topupId}`);
    expect(detail.body.receipt).toMatchObject({ effective: { basis: "informed", cents: 160, estimatedCents: 150, differenceCents: 10 } });
  });

  it("mudar a regra NÃO reescreve o lançamento antigo: o recebimento da vigência nova usa a versão 2 e o antigo segue na 1", async () => {
    const student = await newStudent();
    const before = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 10_000 }, at(BASE));
    const stored0 = (await doc(`topups/${before.topupId}`))!;
    const afterChange = school.addDays(BASE, 10);
    const later = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 10_000 }, at(afterChange));
    expect((await doc(`topups/${later.topupId}`))!.feeEstimate).toMatchObject({ cents: 500, ruleVersion: 2, percentBp: 500, settlementDays: 2, effectiveFrom: afterChange });
    expect(later.settlement.expectedOn).toBe(school.addDays(afterChange, 2));
    const stored1 = (await doc(`topups/${before.topupId}`))!;
    expect(stored1.feeEstimate).toEqual(stored0.feeEstimate); // o antigo segue exatamente com a v1 (R$ 3,00)
    expect((stored1.feeEstimate as { cents: number }).cents).toBe(300);
    // a série encerrada (v3 retirada) não encerra nada: a v2 segue valendo
    const much = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 1000 }, at(school.addDays(BASE, 30)));
    expect((await doc(`topups/${much.topupId}`))!.feeEstimate).toMatchObject({ ruleVersion: 2 });
  });

  it("sem regra: a taxa fica pendente (nada inventado), sem previsão de liquidação; dinheiro nunca tem estimativa", async () => {
    const student = await newStudent();
    const pix = await topup(student, { method: "pix", amountCents: 3000 });
    expect(pix).toMatchObject({ fee: { status: "pending", cents: null }, settlement: { status: "settled" } });
    expect((await doc(`topups/${pix.topupId}`))!.feeEstimate).toBeNull();
    const cash = await topup(student, { method: "cash", amountCents: 1500, reference: undefined });
    expect(cash).toMatchObject({ fee: { status: "none", cents: 0 }, settlement: { status: "cash_on_hand" } });
    expect((await doc(`topups/${cash.topupId}`))!.feeEstimate).toBeNull();
    const card = await topup(student, { method: "card_debit", amountCents: 1000 }); // fonte padrão sem regra
    expect(card.settlement).toMatchObject({ status: "pending", expectedOn: null, expectedSource: null });
  });

  it("maquininha inexistente, arquivada, de outro meio ou usada com dinheiro: recusa, nada gravado", async () => {
    const student = await newStudent();
    const before = (await db().collection("topups").where("studentId", "==", student).get()).size;
    await expect(topup(student, { method: "card_credit", sourceId: "term_naoexiste" })).rejects.toMatchObject({ code: "invalid_source" });
    await expect(topup(student, { method: "pix", sourceId: TERMINAL })).rejects.toMatchObject({ code: "invalid_source" }); // terminal só aceita cartão
    await expect(topup(student, { method: "cash", sourceId: TERMINAL, reference: undefined })).rejects.toThrow();
    expect((await db().collection("topups").where("studentId", "==", student).get()).size).toBe(before);
    expect(await walletOf(student)).toBeUndefined();
  });

  it("A04: a compra com saldo debita só o preço — sem taxa no pedido nem no livro — e o relatório do dia não muda", async () => {
    const student = await newStudent();
    await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 5000, feeCents: 150 }, at(BASE));
    const report = async () => (await call("GET admin/finance/report/route", admin, "GET", `/api/admin/finance/report?from=${BASE}&to=${BASE}`)).body.totals;
    const product = await newProduct(500);
    const totalsBefore = await report();
    const sale = await call("POST pos sales", cantina, "POST", "/api/pos/sales", { key: randomUUID(), studentId: student, expectedShiftId: ST, lines: [{ productId: product, quantity: 2, expectedPriceCents: 500 }] });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    expect(await report()).toEqual(totalsBefore); // consumo com saldo não é recebimento: nem bruto, nem taxa, nem líquido mudaram
    expect(await walletOf(student)).toMatchObject({ balanceCents: 4000 });
    const entries = (await db().collection(`wallets/${student}/entries`).orderBy("seq").get()).docs.map((d) => [d.get("type"), d.get("amountCents")]);
    expect(entries).toEqual([["topup", 5000], ["counter_purchase", -1000]]);
    const order = (await db().collection("orders").where("studentId", "==", student).get()).docs[0]!.data();
    expect(JSON.stringify(order)).not.toMatch(/"feew*"|"settlement"|"sourceId"/); // nenhum campo de taxa/liquidação no pedido da compra com saldo
    await ledgerOk(student);
  });

  it("venda direta no cartão: estimativa e previsão da regra; o recebimento fica fora da carteira e do livro", async () => {
    const product = await newProduct(700);
    const sale = await directSale(product, 2, { sourceId: TERMINAL }, at(BASE));
    expect(sale).toMatchObject({ totalCents: 1400, fee: { status: "pending", cents: null }, netCents: null });
    const stored = (await doc(`directSales/${sale.saleId}`))!;
    expect(stored.payment).toMatchObject({ sourceId: TERMINAL, financeVersion: 0, feeEstimate: { cents: 42, ruleVersion: 1, fictitious: true }, settlement: { status: "pending", expectedOn: school.addDays(BASE, 30), expectedSource: "rule" } });
    const cash = await directSale(product, 1, { paymentMethod: "cash" }, at(BASE));
    expect((await doc(`directSales/${cash.saleId}`))!.payment).toMatchObject({ feeEstimate: null, settlement: { status: "cash_on_hand" } });
    await expect(directSale(product, 1, { paymentMethod: "cash", sourceId: TERMINAL })).rejects.toThrow();
  });

  it("em PRODUÇÃO a regra fictícia é ignorada: sem estimativa e sem previsão de liquidação", async () => {
    const student = await newStudent();
    const r = await inProduction(() => topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 5000 }));
    expect(r).toMatchObject({ fee: { status: "pending" }, settlement: { status: "pending", expectedOn: null } });
    expect((await doc(`topups/${r.topupId}`))!.feeEstimate).toBeNull();
    expect(r.creditedCents).toBe(5000);
  });
});

/* -------------------------------------------------------------------------- recarga online (F19) */

describe("recarga online confirmada: estimativa pela regra do provedor, crédito sempre bruto", () => {
  it("o crédito segue integral; taxa REAL e liquidação ficam pendentes; a estimativa fica congelada; reconciliar não altera `version`", async () => {
    expect((await adminPost("admin/finance/sources/route", { key: randomUUID(), kind: "provider", code: "mercadopago", name: "Mercado Pago fictício", methods: ["pix", "card_credit"], fictitious: true })).status).toBeLessThan(500);
    cleanup.push(`feeSeries/${PROVIDER}__pix`);
    const rule = await adminPost("admin/finance/rules/route", ruleBody({ sourceId: PROVIDER, method: "pix", percentBp: 99, settlementDays: 1 }));
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);

    const student = await newStudent();
    const p = fakeMercadoPago();
    const created = await intents.createTopupIntent(db(), actorOf(guardian, "guardian"), { key: randomUUID(), studentId: student, amountCents: 5000, channel: "pix" }, { providers: p.providers });
    p.pay(created.intentId);
    const result = await confirmation.refreshIntent(db(), { providers: p.providers, production: false }, created.intentId, "admin");
    expect(result.outcome).toBe("credited");
    const stored = (await doc(`topupIntents/${created.intentId}`))!;
    expect(stored).toMatchObject({ status: "confirmed", fee: { status: "pending", cents: null, source: "provider" }, feeSourceId: PROVIDER, settlement: { status: "pending", expectedOn: school.addDays(BASE, 1), expectedSource: "rule" } });
    expect(stored.feeEstimate).toMatchObject({ cents: 50, ruleVersion: 1, percentBp: 99 }); // 49,5 centavos → 50 (meio para cima)
    expect(await walletOf(student)).toMatchObject({ balanceCents: 5000, version: 1 });

    const ref = `online_topup:${created.intentId}`;
    const rec = await adminPost("admin/finance/reconcile/route", { key: randomUUID(), ref, expectedVersion: 0, actualFeeCents: 48, settledOn: BASE });
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    const after = (await doc(`topupIntents/${created.intentId}`))!;
    expect(after).toMatchObject({ fee: { status: "confirmed", cents: 48, source: "operator" }, settlement: { status: "settled", settledOn: BASE }, financeVersion: 1, version: stored.version, status: "confirmed" });
    expect(after.feeEstimate).toEqual(stored.feeEstimate);
    expect(await walletOf(student)).toMatchObject({ balanceCents: 5000, version: 1 }); // a conferência nunca toca a carteira
    await ledgerOk(student);
  });
});

/* --------------------------------------------------------------------------------- conferência */

describe("conferência da taxa real e da liquidação (administração)", () => {
  async function cardTopup(amount = 5000, over: Record<string, unknown> = {}) {
    const student = await newStudent();
    const r = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: amount, ...over }, at(BASE));
    return { student, topupId: r.topupId, ref: `topup:${r.topupId}` };
  }
  const reconcile = (body: Record<string, unknown>, user: TestUser | null = admin) => adminPost("admin/finance/reconcile/route", { key: randomUUID(), expectedVersion: 0, ...body }, user);

  it("lista o que falta conferir (taxa sem valor real ou liquidação pendente) com a estimativa e o vencimento", async () => {
    const t = await cardTopup();
    await db().doc(`topups/${t.topupId}`).update({ "settlement.expectedOn": school.addDays(BASE, -3) }); // fixture: previsão já vencida
    const list = await call("GET admin/finance/receipts/route", admin, "GET", "/api/admin/finance/receipts");
    const item = (list.body.items as { ref: string; overdue: boolean; effective: { basis: string; cents: number } }[]).find((i) => i.ref === t.ref)!;
    expect(item).toMatchObject({ overdue: true, effective: { basis: "estimated", cents: 150 } });
    expect((list.body.items as { method: string }[]).every((i) => i.method !== "cash")).toBe(true);
  });

  it("confere a taxa real e a liquidação: taxa efetiva vira a REAL (R$ 1,48), a estimada fica só para comparação; carteira e livro intactos", async () => {
    const t = await cardTopup();
    const walletBefore = await walletOf(t.student);
    const r = await reconcile({ ref: t.ref, actualFeeCents: 148, settledOn: BASE });
    expect(r, JSON.stringify(r.body)).toMatchObject({ status: 200, body: { financeVersion: 1, fee: { status: "confirmed", cents: 148, source: "operator" }, settlement: { status: "settled", settledOn: BASE }, effective: { basis: "confirmed", cents: 148, estimatedCents: 150, differenceCents: -2 } } });
    const stored = (await doc(`topups/${t.topupId}`))!;
    expect(stored).toMatchObject({ fee: { status: "confirmed", cents: 148 }, netCents: 4852, financeVersion: 1, creditedCents: 5000, amountCents: 5000 });
    expect(stored.feeEstimate).toMatchObject({ cents: 150 });
    expect(await walletOf(t.student)).toEqual(walletBefore);
    await ledgerOk(t.student);
    const events = (await db().collection(`topups/${t.topupId}/reconciliations`).get()).docs.map((d) => d.data());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, correction: false, before: { fee: { status: "pending" } }, after: { fee: { status: "confirmed", cents: 148 } }, operator: { uid: admin.uid } });
    const audit = (await db().collection("auditLog").where("target.id", "==", t.topupId).where("action", "==", "finance.reconcile").get()).docs;
    expect(audit).toHaveLength(1);
  });

  it("aceita o líquido recebido no lugar da taxa (bruto − líquido); os dois juntos ou nada são recusados", async () => {
    const t = await cardTopup();
    expect((await reconcile({ ref: t.ref, actualFeeCents: 100, netReceivedCents: 4900 })).status).toBe(400);
    expect((await reconcile({ ref: t.ref })).status).toBe(400);
    const r = await reconcile({ ref: t.ref, netReceivedCents: 4852 });
    expect(r.body).toMatchObject({ fee: { status: "confirmed", cents: 148 } });
    expect((await reconcile({ ref: t.ref, expectedVersion: 1, netReceivedCents: 5001, reason: "Líquido acima do bruto" })).body.error).toBe("invalid_fee");
  });

  it("repetição com a mesma chave devolve o mesmo resultado; versão antiga = 409; corrigir exige motivo e preserva o valor anterior", async () => {
    const t = await cardTopup();
    const first = { key: randomUUID(), ref: t.ref, expectedVersion: 0, actualFeeCents: 148 };
    const r1 = await adminPost("admin/finance/reconcile/route", first);
    expect((await adminPost("admin/finance/reconcile/route", first)).body).toMatchObject({ replayed: true, financeVersion: 1, eventId: r1.body.eventId });
    expect((await db().collection(`topups/${t.topupId}/reconciliations`).get()).size).toBe(1);

    expect((await reconcile({ ref: t.ref, expectedVersion: 0, actualFeeCents: 140 })).body.error).toBe("stale_receipt");
    expect((await reconcile({ ref: t.ref, expectedVersion: 1, actualFeeCents: 148 })).body.error).toBe("nothing_to_change");
    expect((await reconcile({ ref: t.ref, expectedVersion: 1, actualFeeCents: 140 })).body.error).toBe("correction_requires_reason");
    const corrected = await reconcile({ ref: t.ref, expectedVersion: 1, actualFeeCents: 140, reason: "Valor lido errado do extrato" });
    expect(corrected.body).toMatchObject({ financeVersion: 2, fee: { cents: 140 } });
    const events = (await db().collection(`topups/${t.topupId}/reconciliations`).orderBy("seq").get()).docs.map((d) => d.data());
    expect(events.map((e) => [e.seq, e.correction, (e.after as { fee: { cents: number } }).fee.cents])).toEqual([[1, false, 148], [2, true, 140]]);
    expect(events[1]).toMatchObject({ before: { fee: { cents: 148 } }, reason: "Valor lido errado do extrato" });
  });

  it("duas conferências simultâneas do mesmo recebimento: uma vence, a outra recebe 409 `stale_receipt`", async () => {
    const t = await cardTopup();
    const results = await Promise.all([reconcile({ ref: t.ref, actualFeeCents: 148 }), reconcile({ ref: t.ref, actualFeeCents: 149 })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe("stale_receipt");
    expect((await doc(`topups/${t.topupId}`))!.financeVersion).toBe(1);
    expect((await db().collection(`topups/${t.topupId}/reconciliations`).get()).size).toBe(1);
  });

  it("datas da liquidação: antes do recebimento ou no futuro são recusadas; dinheiro não tem conferência; taxa maior que o valor é recusada", async () => {
    const t = await cardTopup();
    expect((await reconcile({ ref: t.ref, settledOn: school.addDays(BASE, -1) })).body.error).toBe("invalid_settlement_date");
    expect((await reconcile({ ref: t.ref, settledOn: school.addDays(BASE, 1) })).body.error).toBe("invalid_settlement_date");
    expect((await reconcile({ ref: t.ref, actualFeeCents: 5001 })).body.error).toBe("invalid_fee");
    const student = await newStudent();
    const cash = await topup(student, { method: "cash", reference: undefined });
    expect((await reconcile({ ref: `topup:${cash.topupId}`, actualFeeCents: 0 })).body.error).toBe("not_applicable");
    expect((await reconcile({ ref: "topup:inexistente_xyz", actualFeeCents: 1 })).status).toBe(404);
    expect((await reconcile({ ref: "payment:abc", actualFeeCents: 1 })).status).toBe(400);
    expect(await doc(`topups/${t.topupId}`)).toMatchObject({ financeVersion: 0, fee: { status: "pending" } });
  });

  it("venda direta: a conferência grava em `payment.fee`/`payment.settlement`, sem tocar o resto da venda", async () => {
    const product = await newProduct(700);
    const sale = await directSale(product, 1, { sourceId: TERMINAL }, at(BASE));
    const ref = `direct_sale:${sale.saleId}`;
    const before = (await doc(`directSales/${sale.saleId}`))!;
    const r = await reconcile({ ref, actualFeeCents: 20, settledOn: BASE });
    expect(r.body).toMatchObject({ fee: { status: "confirmed", cents: 20 } });
    const after = (await doc(`directSales/${sale.saleId}`))!;
    expect(after.payment).toMatchObject({ fee: { status: "confirmed", cents: 20 }, netCents: 680, financeVersion: 1, settlement: { status: "settled", settledOn: BASE } });
    expect({ ...after, payment: undefined }).toEqual({ ...before, payment: undefined });
  });
});

/* ------------------------------------------------------------------------ relatório e exportação */

describe("relatório financeiro e exportação mensal (A28/A29): cada recebimento conta UMA vez e o resumo bate com o detalhe", () => {
  const fx: { student?: string; ids: Record<string, string> } = { ids: {} };

  it("monta o dia isolado: cartão estimado, cartão conferido, Pix informado, dinheiro, Pix sem taxa, venda direta e recarga online", async () => {
    const student = (fx.student = await newStudent());
    // a regra da v2 (500bp, D+2) vale em D (hoje + 40); usa a fonte do terminal
    const a = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 5000 }, at(D));
    const b = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 10_000 }, at(D));
    const c = await topup(student, { method: "pix", amountCents: 2000, feeCents: 20 }, at(D));
    const d = await topup(student, { method: "cash", amountCents: 1500, reference: undefined }, at(D));
    const e = await topup(student, { method: "pix", amountCents: 3000 }, at(D));
    fx.ids = { a: a.topupId, b: b.topupId, c: c.topupId, d: d.topupId, e: e.topupId };
    expect((await doc(`topups/${a.topupId}`))!.feeEstimate).toMatchObject({ cents: 250, ruleVersion: 2 }); // 5% de R$ 50,00
    expect((await doc(`topups/${b.topupId}`))!.feeEstimate).toMatchObject({ cents: 500 });
    const rec = await adminPost("admin/finance/reconcile/route", { key: randomUUID(), ref: `topup:${b.topupId}`, expectedVersion: 0, actualFeeCents: 290 });
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);

    const product = await newProduct(700);
    const sale = await directSale(product, 2, { sourceId: TERMINAL }, at(D));
    fx.ids.f = sale.saleId;
    expect((await doc(`directSales/${sale.saleId}`))!.payment).toMatchObject({ feeEstimate: { cents: 70 } }); // 5% de R$ 14,00

    const p = fakeMercadoPago();
    const created = await intents.createTopupIntent(db(), actorOf(guardian, "guardian"), { key: randomUUID(), studentId: student, amountCents: 5000, channel: "pix" }, { providers: p.providers, clock: at(D) });
    p.pay(created.intentId);
    expect((await confirmation.refreshIntent(db(), { providers: p.providers, production: false, clock: at(D) }, created.intentId, "admin")).outcome).toBe("credited");
    fx.ids.g = created.intentId;
    expect((await doc(`topupIntents/${created.intentId}`))!.feeEstimate).toMatchObject({ cents: 50 });

    // estorno parcial de R$ 10,00 do Pix informado (c): aparece como estornado; a taxa NÃO é devolvida
    await topupCommands.reverseManualTopup(db(), actorOf(admin, "admin"), { key: randomUUID(), topupId: c.topupId, amountCents: 1000, reasonCode: "payment_returned", reason: "Valor devolvido ao pagador", expectedReversedCents: 0 }, at(D));
  });

  it("totais do dia: bruto, estornado, taxa por BASE (conferida / informada / estimada / sem valor), líquido previsto × real e liquidação", async () => {
    const r = await call("GET admin/finance/report/route", admin, "GET", `/api/admin/finance/report?from=${D}&to=${D}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ from: D, to: D, dateBasis: "receivedOn", truncated: false, production: false });
    const t = r.body.totals as Record<string, number>;
    // bruto: 5000+10000+2000+1500+3000+1400+5000
    expect(t).toMatchObject({
      count: 7,
      grossCents: 27_900,
      reversedCents: 1000,
      feeConfirmedCents: 290, // b
      feeInformedCents: 20, // c
      feeEstimatedCents: 250 + 70 + 50, // a (R$ 2,50) + venda direta (R$ 0,70) + online (R$ 0,50)
      feeUnknownCount: 1, // e (Pix sem regra e sem taxa informada)
      feeUnknownGrossCents: 3000,
      feeEffectiveCents: 290 + 20 + 370,
      netExpectedCents: 27_900 - 3000 - 680,
      netRealCents: 9710 + 1500, // só conferida + dinheiro
      settledCount: 2, // c e e: Pix manual conferido na conta
      settledGrossCents: 2000 + 3000,
      pendingCount: 4, // a, b (taxa conferida, liquidação não), venda direta e online
      pendingGrossCents: 5000 + 10_000 + 1400 + 5000,
      overdueCount: 0,
      fictitiousCount: 4, // a, b, f, g têm estimativa de regra fictícia
    });
    // a soma das linhas é o total (nenhum recebimento em duas linhas)
    const rows = r.body.rows as (Record<string, number | string>)[];
    for (const key of ["count", "grossCents", "feeEffectiveCents", "netExpectedCents"]) expect(rows.reduce((n, row) => n + (row[key] as number), 0)).toBe(t[key]);
    // a taxa de um recebimento só entra em UMA base: confirmada + informada + estimada = efetiva
    expect(t.feeConfirmedCents! + t.feeInformedCents! + t.feeEstimatedCents!).toBe(t.feeEffectiveCents);
  });

  it("A31: reversão externa e estorno aparecem como estornado nas contas (a taxa não volta) e não escondem o recebimento", async () => {
    const r = await call("GET admin/finance/report/route", admin, "GET", `/api/admin/finance/report?from=${D}&to=${D}`);
    const pixRows = (r.body.rows as { method: string; kind: string; reversedCents: number; grossCents: number; feeInformedCents: number }[]).filter((row) => row.method === "pix" && row.kind === "topup");
    expect(pixRows.reduce((n, row) => n + row.reversedCents, 0)).toBe(1000);
    expect(pixRows.reduce((n, row) => n + row.grossCents, 0)).toBe(5000);
    expect(pixRows.reduce((n, row) => n + row.feeInformedCents, 0)).toBe(20);
  });

  it("período inválido: invertido, longo demais e datas ruins; só a administração", async () => {
    const get = (qs: string) => call("GET admin/finance/report/route", admin, "GET", `/api/admin/finance/report?${qs}`);
    expect((await get(`from=${D}&to=${school.addDays(D, -1)}`)).body.error).toBe("invalid_range");
    expect((await get(`from=${D}&to=${school.addDays(D, 93)}`)).body.error).toBe("range_too_long");
    expect((await get("from=2026-02-30&to=2026-03-01")).status).toBe(400);
    expect((await get(`from=${D}`)).status).toBe(400);
  });

  it("exportação mensal: o CSV de detalhe tem uma linha por recebimento, o resumo tem o MESMO total e a fórmula do nome é neutralizada", async () => {
    const month = D.slice(0, 7);
    const detail = await reportMod.exportFinance(db(), actorOf(admin, "admin"), { month, view: "detail" });
    const summary = await reportMod.exportFinance(db(), actorOf(admin, "admin"), { month, view: "summary" });
    expect(detail.csv.startsWith("﻿")).toBe(true);
    expect(detail.filename).toBe(`financeiro-detalhe-${month}.csv`);
    expect(detail.dateBasis).toMatch(/recebimento/);
    const rowsOf = (csv: string) => csv.replace(/^﻿/, "").trim().split("\r\n").map((l) => l.split(";"));
    const d = rowsOf(detail.csv);
    const s = rowsOf(summary.csv);
    const header = d[0]!;
    expect(header).toContain("Bruto (R$)");
    const parse = (v: string) => Number(v.replace(",", "."));
    const col = (rows: string[][], name: string) => rows[0]!.indexOf(name);
    const detailRows = d.slice(1);
    const sumDetail = (name: string) => Math.round(detailRows.reduce((n, r) => n + (r[col(d, name)] ? parse(r[col(d, name)]!) : 0), 0) * 100);
    const totalRow = s.at(-1)!;
    expect(totalRow[0]).toBe("TOTAL");
    expect(Number(totalRow[col(s, "Recebimentos")])).toBe(detailRows.length);
    expect(Math.round(parse(totalRow[col(s, "Bruto (R$)")]!) * 100)).toBe(sumDetail("Bruto (R$)"));
    expect(Math.round(parse(totalRow[col(s, "Estornado (R$)")]!) * 100)).toBe(sumDetail("Estornado (R$)"));
    expect(Math.round(parse(totalRow[col(s, "Taxa efetiva (R$)")]!) * 100)).toBe(sumDetail("Taxa efetiva (R$)"));
    // o detalhe do dia isolado contém os 7 recebimentos esperados, com a data no formato brasileiro e a regra aplicada
    const dayRows = detailRows.filter((r) => r[0] === `${D.slice(8, 10)}/${D.slice(5, 7)}/${D.slice(0, 4)}`);
    expect(dayRows).toHaveLength(7);
    expect(dayRows.map((r) => r[col(d, "Referência interna")])).toEqual(expect.arrayContaining([`topup:${fx.ids.a}`, `direct_sale:${fx.ids.f}`, `online_topup:${fx.ids.g}`]));
    const a = dayRows.find((r) => r[1] === `topup:${fx.ids.a}`)!;
    expect(a[col(d, "Regra aplicada")]).toBe(`${TERMINAL}__card_credit v2`);
    expect(a[col(d, "Regra fictícia")]).toBe("Sim");
    expect(a[col(d, "Base da taxa")]).toBe("estimada");
    expect(a[col(d, "Taxa efetiva (R$)")]).toBe("2,50");
    expect(a[col(d, "Líquido previsto (R$)")]).toBe("47,50");
    // fórmula em nome de operador: neutralizada com apóstrofo (texto livre), nunca interpretada
    expect(a[col(d, "Operador")]).toBe("'=2+2 Secretaria");
    expect(detail.csv).not.toMatch(/;=2+2/);
    expect(summary.fictitiousCount).toBeGreaterThan(0);
    // o resumo mensal confere com o relatório do período inteiro
    const report = await reportMod.financeReport(db(), actorOf(admin, "admin"), { from: `${month}-01`, to: reportMod.monthRange(month).to });
    expect(Math.round(parse(totalRow[col(s, "Bruto (R$)")]!) * 100)).toBe(report.totals.grossCents);
  });

  it("mês inválido é recusado; fora da administração nada é exportado", async () => {
    await expect(reportMod.exportFinance(db(), actorOf(admin, "admin"), { month: "2026-13", view: "detail" })).rejects.toThrow();
    await expect(reportMod.exportFinance(db(), actorOf(secretaria, "secretaria"), { month: D.slice(0, 7), view: "detail" })).rejects.toThrow();
  });
});


/* ------------------------------------------------------------------------------- falha intermediária */

describe("falha no meio da transação não deixa rastro; o retry com a MESMA chave conclui uma vez", () => {
  const block = (scope: string, key: string) => db().doc(`auditLog/${admin.uid}__${scope}__${key}`).set({ action: "bloqueio-de-teste" });
  const unblock = (scope: string, key: string) => db().doc(`auditLog/${admin.uid}__${scope}__${key}`).delete();

  it("regra, cadastro e conferência: auditoria bloqueada = 500 sem rastro; liberada, a mesma chave conclui uma vez", async () => {
    const versionsBefore = (await seriesDoc(TERMINAL, "card_credit"))!.versionCount;
    const rule = ruleBody({ effectiveFrom: school.addDays(BASE, 60), percentBp: 700 });
    await block("finance.rule.publish", rule.key as string);
    expect((await adminPost("admin/finance/rules/route", rule)).status).toBe(500);
    expect((await seriesDoc(TERMINAL, "card_credit"))!.versionCount).toBe(versionsBefore);
    await unblock("finance.rule.publish", rule.key as string);
    expect((await adminPost("admin/finance/rules/route", rule)).body).toMatchObject({ version: versionsBefore + 1, replayed: false });
    expect((await seriesDoc(TERMINAL, "card_credit"))!.versionCount).toBe(versionsBefore + 1);

    const source = { key: randomUUID(), kind: "terminal", code: `f${tag}`, name: "Maquininha de falha", methods: ["pix"], fictitious: true };
    cleanup.push(`paymentSources/term_f${tag}`);
    await block("finance.source.create", source.key);
    expect((await adminPost("admin/finance/sources/route", source)).status).toBe(500);
    expect(await doc(`paymentSources/term_f${tag}`)).toBeUndefined();
    await unblock("finance.source.create", source.key);
    expect((await adminPost("admin/finance/sources/route", source)).status).toBe(200);

    const student = await newStudent();
    const t = await topup(student, { method: "card_credit", sourceId: TERMINAL, amountCents: 5000 }, at(BASE));
    const body = { key: randomUUID(), ref: `topup:${t.topupId}`, expectedVersion: 0, actualFeeCents: 120, settledOn: BASE };
    await block("finance.reconcile", body.key);
    expect((await adminPost("admin/finance/reconcile/route", body)).status).toBe(500);
    expect(await doc(`topups/${t.topupId}`)).toMatchObject({ financeVersion: 0, fee: { status: "pending" }, settlement: { status: "pending" } });
    expect((await db().collection(`topups/${t.topupId}/reconciliations`).get()).size).toBe(0);
    await unblock("finance.reconcile", body.key);
    expect((await adminPost("admin/finance/reconcile/route", body)).body).toMatchObject({ financeVersion: 1, replayed: false });
    expect((await db().collection(`topups/${t.topupId}/reconciliations`).get()).size).toBe(1);
  });

  it("recebimento (recarga manual) que falha no último passo não credita nem grava estimativa; o retry credita uma vez", async () => {
    const student = await newStudent();
    const key = randomUUID();
    await db().doc(`auditLog/${secretaria.uid}__topup.manual__${key}`).set({ action: "bloqueio-de-teste" });
    await expect(topup(student, { key, method: "card_credit", sourceId: TERMINAL, amountCents: 5000 }, at(BASE))).rejects.toBeTruthy();
    expect(await walletOf(student)).toBeUndefined();
    expect((await db().collection("topups").where("studentId", "==", student).get()).size).toBe(0);
    await db().doc(`auditLog/${secretaria.uid}__topup.manual__${key}`).delete();
    const ok = await topup(student, { key, method: "card_credit", sourceId: TERMINAL, amountCents: 5000 }, at(BASE));
    expect((await doc(`topups/${ok.topupId}`))!.feeEstimate).toMatchObject({ ruleVersion: 1 });
    expect(await walletOf(student)).toMatchObject({ balanceCents: 5000, version: 1 });
  });
});
