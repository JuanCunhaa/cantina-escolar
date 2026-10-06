// Recarga manual e estorno (F17) contra Auth/Firestore Emulator: crédito bruto integral com taxa como despesa (A04), permissão,
// confirmação, operador e trilha; estorno como NOVO movimento com permissão separada (A07); secretaria sem custo/lucro/usuários
// (A30); referência duplicada, replay, clique duplo, resposta perdida, revogação, falha intermediária e no último passo; disputas
// reais entre recargas, estornos e consumo do saldo no balcão, com reconciliação carteira × livro. O saldo vem SÓ das recargas.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDemoProfile } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
type Result = { status: number; body: Json };

let topupsRoute: { GET: Handler; POST: Handler };
let topupRoute: Handler;
let reverseRoute: Handler;
let studentsRoute: Handler;
let receiptsRoute: Handler;
let salesRoute: Handler;
let entriesRoute: Handler;
let reconcileRoute: Handler;
let inventoryRoute: Handler;
let usersRoute: Handler;
let deterministicId: typeof import("@/lib/firebase/command").deterministicId;
let registerManualTopup: typeof import("@/modules/payments/topup-commands").registerManualTopup;
let reverseManualTopup: typeof import("@/modules/payments/topup-commands").reverseManualTopup;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let checkLedger: typeof import("@/modules/wallet/model").checkLedger;
let parseWalletState: typeof import("@/modules/wallet/model").parseWalletState;
let referenceKeyId: typeof import("@/modules/payments/topup-keys").referenceKeyId;
let school: typeof import("@/lib/dates/school-time");

let admin: TestUser;
let secretaria: TestUser;
let secretariaRev: TestUser;
let cantina: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let studentUser: TestUser;

const tag = randomUUID().slice(0, 6);
const ST = `tsf_${tag}_t`;
const CLS = `tcl_${tag}`;
const CAT = `tct_${tag}`;
let BASE = "";
let seq = 0;
const prices = new Map<string, number>();
const noCtx = { params: Promise.resolve({ id: "" }) };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  topupsRoute = (await import("@/app/api/topups/route")) as unknown as { GET: Handler; POST: Handler };
  topupRoute = (await import("@/app/api/topups/[id]/route")).GET as unknown as Handler;
  reverseRoute = (await import("@/app/api/topups/[id]/reverse/route")).POST as unknown as Handler;
  studentsRoute = (await import("@/app/api/topups/students/route")).GET as unknown as Handler;
  receiptsRoute = (await import("@/app/api/inventory/receipts/route")).POST as unknown as Handler;
  salesRoute = (await import("@/app/api/pos/sales/route")).POST as unknown as Handler;
  entriesRoute = (await import("@/app/api/wallets/entries/route")).GET as unknown as Handler;
  reconcileRoute = (await import("@/app/api/wallets/reconcile/route")).GET as unknown as Handler;
  inventoryRoute = (await import("@/app/api/inventory/route")).GET as unknown as Handler;
  usersRoute = (await import("@/app/api/admin/users/route")).POST as unknown as Handler;
  ({ deterministicId } = await import("@/lib/firebase/command"));
  ({ registerManualTopup, reverseManualTopup } = await import("@/modules/payments/topup-commands"));
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ checkLedger, parseWalletState } = await import("@/modules/wallet/model"));
  ({ referenceKeyId } = await import("@/modules/payments/topup-keys"));
  school = await import("@/lib/dates/school-time");
  BASE = school.localDateOf(new Date());
  [admin, secretaria, secretariaRev, cantina, guardianA, guardianB, studentUser] = await Promise.all([
    createTestUser("tadm", "admin", { displayName: "Admin Teste" }),
    createTestUser("tsec", "secretaria", { displayName: "Secretaria Teste" }),
    createTestUser("tsecrev", "secretaria", { displayName: "Secretaria Estorno", permissions: ["topup.reverse"] }),
    createTestUser("tcant", "cantina"),
    createTestUser("tresp-a", "guardian"),
    createTestUser("tresp-b", "guardian"),
    createTestUser("taluno", "student"),
  ]);
  await globalDoc(`shifts/${ST}`, { name: `Tarde ${tag}`, nameSlug: "tarde", status: "active" });
  await globalDoc(`classes/${CLS}`, { name: `Turma ${tag}`, nameSlug: "turma", status: "active" });
  await globalDoc(`categories/${CAT}`, { name: `Categoria ${tag}`, status: "active" });
  await globalDoc(`calendarDays/${BASE}`, { kind: "extra" }); // hoje funciona (balcão), mesmo em fim de semana
});

const globalDocs: string[] = [];
const globalDoc = async (path: string, data: Record<string, string | number | boolean | null | string[]>) => {
  globalDocs.push(path);
  await writeDemoDoc(targetFromEnv(), path, data);
};
afterAll(async () => {
  for (const path of globalDocs.splice(0)) await adminDb().doc(path).delete();
});

/* ------------------------------------------------------------------------------------------------- apoio */

const db = () => adminDb();
const doc = async (path: string) => (await db().doc(path).get()).data();

function authed(method: string, url: string, user: TestUser | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.idToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(handler: Handler, user: TestUser | null, method: string, url: string, body?: unknown, id = ""): Promise<Result> {
  const response = await handler(authed(method, url, user, body), id ? ctx(id) : noCtx);
  return { status: response.status, body: (await response.json()) as Json };
}

let refSeq = 0;
const uniqueRef = () => `E2E${tag}${Date.now()}${++refSeq}`;
const topupBody = (studentId: string, over: Record<string, unknown> = {}) => ({ key: randomUUID(), studentId, amountCents: 5000, method: "pix", receivedConfirmed: true, reference: uniqueRef(), ...over });
const register = (user: TestUser | null, body: unknown) => call(topupsRoute.POST, user, "POST", "/api/topups", body);
const reverse = (user: TestUser | null, topupId: string, body: Record<string, unknown>) => call(reverseRoute, user, "POST", `/api/topups/${topupId}/reverse`, body, topupId);
const reversalBody = (over: Record<string, unknown> = {}) => ({ key: randomUUID(), amountCents: 1000, reasonCode: "registration_error", reason: "Valor digitado errado", expectedReversedCents: 0, ...over });

async function newStudent(over: { status?: "active" | "inactive"; name?: string } = {}) {
  const id = `tst_${tag}_${++seq}`;
  const name = over.name ?? `Aluno Recarga ${seq}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: [guardianA.uid], allowCounterPurchase: true, studentStatus: over.status ?? "active" });
  await writeDemoDoc(targetFromEnv(), `students/${id}`, { name, enrollment: `R${tag}${seq}`, status: over.status ?? "active", userUid: null, shiftId: ST, classId: CLS, version: 1 });
  await writeDemoDoc(targetFromEnv(), `studentPolicies/${id}`, { allowSitePurchase: true, allowCounterPurchase: true, configVersion: 1 });
  return id;
}

async function newProduct(price: number, stock = 200) {
  const id = `tpr_${tag}_${++seq}`;
  await globalDoc(`products/${id}`, { name: `Produto ${seq}`, description: "", categoryId: CAT, priceCents: price, priceVersion: 1, channels: ["advance", "counter"], shiftIds: [ST], availabilityMode: "physical", status: "active", version: 1 });
  await globalDoc(`defaultMenuRules/${id}`, { shiftIds: [ST], version: 1 });
  prices.set(id, price);
  const r = await call(receiptsRoute, admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: stock, unitCost: "1,00" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return id;
}
const sell = (studentId: string, productId: string, quantity = 1) =>
  call(salesRoute, cantina, "POST", "/api/pos/sales", { key: randomUUID(), studentId, expectedShiftId: ST, lines: [{ productId, quantity, expectedPriceCents: prices.get(productId)! }] });

async function walletOf(studentId: string) {
  const w = parseWalletState(await doc(`wallets/${studentId}`));
  const entries = (await db().collection(`wallets/${studentId}/entries`).orderBy("seq").get()).docs.map((x) => ({ id: x.id, ...(x.data() as { seq: number; type: string; amountCents: number; balanceAfterCents: number }) }));
  return { ...w, entries };
}
async function expectReconciled(studentId: string) {
  const w = await walletOf(studentId);
  expect(checkLedger(w, w.entries)).toEqual([]);
  expect(w.balanceCents).toBeGreaterThanOrEqual(0);
  const r = await call(reconcileRoute, admin, "GET", `/api/wallets/reconcile?studentId=${studentId}`);
  expect(r.body).toMatchObject({ ok: true, problems: [] });
  return w;
}
const noInternalLeak = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/cost|Cost|micros|profit|lucro|actorUid|"uid"|email|keyId|normalized/i);

/* ------------------------------------------------------------------------------------------ A04: taxa */

describe("A04 — R$ 50 com taxa de R$ 1,50: credita R$ 50, líquido R$ 48,50, taxa não reaparece na compra", () => {
  it("credita o valor BRUTO integral, registra taxa/líquido só no recebimento e a compra com saldo debita apenas o preço", async () => {
    const student = await newStudent();
    const r = await register(secretaria, topupBody(student, { amountCents: 5000, method: "pix", feeCents: 150, payerName: "Responsável Fictício", note: "Conferido no extrato do banco" }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      replayed: false,
      status: "confirmed",
      amountCents: 5000,
      creditedCents: 5000,
      method: "pix",
      fee: { status: "informed", cents: 150, source: "operator" },
      netCents: 4850,
      settlement: { status: "settled", settledOn: BASE },
      receivedOn: BASE,
      operatorName: "Secretaria Teste",
      balanceAfterCents: 5000,
      reversibleCents: 5000,
      payerName: "Responsável Fictício",
    });
    noInternalLeak(r.body);
    const topupId = String(r.body.topupId);
    const stored = (await doc(`topups/${topupId}`))!;
    expect(stored).toMatchObject({ kind: "manual", studentId: student, amountCents: 5000, creditedCents: 5000, netCents: 4850, fee: { cents: 150 }, verification: { receivedConfirmed: true }, operator: { uid: secretaria.uid, role: "secretaria", name: "Secretaria Teste" }, walletSeq: 1 });
    expect(stored.createdAt).toBeTruthy();
    const w1 = await walletOf(student);
    expect(w1).toMatchObject({ balanceCents: 5000, version: 1 });
    expect(w1.entries).toEqual([expect.objectContaining({ id: `${topupId}_credit`, type: "topup", amountCents: 5000, balanceAfterCents: 5000, seq: 1 })]);

    // Compra no balcão com o saldo: débito = preço (R$ 5,00), sem taxa nenhuma.
    const product = await newProduct(500);
    const sale = await sell(student, product, 1);
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const w2 = await expectReconciled(student);
    expect(w2.balanceCents).toBe(4500);
    expect(w2.entries.map((e) => [e.type, e.amountCents])).toEqual([["topup", 5000], ["counter_purchase", -500]]);
  });

  it("auditoria na mesma transação: ação, operador, antes/depois, taxa e referência normalizada", async () => {
    const student = await newStudent();
    const body = topupBody(student, { method: "card_credit", feeCents: 199, reference: "nsu 0001-aut 77", expectedSettlementOn: school.addDays(BASE, 30) });
    const r = await register(secretaria, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await doc(`auditLog/${secretaria.uid}__topup.manual__${body.key}`)).toMatchObject({
      action: "topup.manual.register",
      actorUid: secretaria.uid,
      actorRole: "secretaria",
      target: { type: "topup", id: r.body.topupId },
      before: { balanceCents: 0 },
      after: { balanceCents: 5000, amountCents: 5000, creditedCents: 5000, netCents: 4801, method: "card_credit", reference: "NSU0001AUT77", settlement: "pending" },
    });
  });
});

/* ----------------------------------------------------------------------- liquidação × aprovação (cartão) */

describe("meios: dinheiro, Pix conferido e cartão aprovado — aprovação não é liquidação", () => {
  it("cartão fica com liquidação PENDENTE (data prevista opcional); Pix liquidado na data; dinheiro no caixa sem taxa", async () => {
    const student = await newStudent();
    const card = await register(secretaria, topupBody(student, { method: "card_debit", amountCents: 2000, expectedSettlementOn: school.addDays(BASE, 1) }));
    expect(card.body).toMatchObject({ method: "card_debit", fee: { status: "pending", cents: null }, netCents: null, settlement: { status: "pending", expectedOn: school.addDays(BASE, 1), settledOn: null } });
    const cash = await register(secretaria, topupBody(student, { method: "cash", amountCents: 1000, reference: undefined }));
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect(cash.body).toMatchObject({ method: "cash", fee: { status: "none", cents: 0 }, netCents: 1000, settlement: { status: "cash_on_hand" }, reference: null });
    expect((await walletOf(student)).balanceCents).toBe(3000);
  });

  it("entradas inválidas = 400 sem gravar: sem confirmação, Pix/cartão sem referência, taxa > valor, taxa em dinheiro, valor fora do intervalo, campo extra, liquidação em Pix", async () => {
    const student = await newStudent();
    const bad = [
      topupBody(student, { receivedConfirmed: false }),
      topupBody(student, { reference: undefined }),
      topupBody(student, { method: "card_credit", reference: "  " }),
      topupBody(student, { feeCents: 5001 }),
      topupBody(student, { method: "cash", feeCents: 10 }),
      topupBody(student, { amountCents: 99 }),
      topupBody(student, { amountCents: 200_001 }),
      topupBody(student, { amountCents: 10.5 }),
      topupBody(student, { creditedCents: 6000 }),
      topupBody(student, { expectedSettlementOn: BASE }),
      topupBody(student, { note: "=HYPERLINK(1)" }),
    ];
    for (const body of bad) expect((await register(secretaria, body)).status, JSON.stringify(body)).toBe(400);
    const past = await register(secretaria, topupBody(student, { method: "card_credit", expectedSettlementOn: school.addDays(BASE, -1) }));
    expect(past).toMatchObject({ status: 409, body: { error: "invalid_settlement_date" } });
    expect(await doc(`wallets/${student}`)).toBeUndefined();
  });

  it("aluno inativo = 409 student_inactive; inexistente = 404; nada gravado", async () => {
    const inactive = await newStudent({ status: "inactive" });
    const body = topupBody(inactive);
    expect(await register(secretaria, body)).toMatchObject({ status: 409, body: { error: "student_inactive" } });
    expect(await register(secretaria, topupBody(`tst_${tag}_nao_existe`))).toMatchObject({ status: 404, body: { error: "student_not_found" } });
    expect(await doc(`wallets/${inactive}`)).toBeUndefined();
    expect(await doc(`uniquenessKeys/${referenceKeyId("pix", String(body.reference).toUpperCase())}`)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- A07: permissão e trilha */

describe("A07 — recarga manual exige permissão atual; estorno exige a permissão SEPARADA", () => {
  it("responsável, aluno, cantina, sem perfil e anônimo não registram nem consultam recargas", async () => {
    const student = await newStudent();
    for (const user of [guardianA, studentUser, cantina]) {
      expect((await register(user, topupBody(student))).status).toBe(403);
      expect((await call(topupsRoute.GET, user, "GET", "/api/topups")).status).toBe(403);
      expect((await call(studentsRoute, user, "GET", "/api/topups/students")).status).toBe(403);
    }
    expect((await register(null, topupBody(student))).status).toBe(401);
    const noProfile = await createTestUser("tsemperfil");
    expect((await register(noProfile, topupBody(student))).status).toBe(403);
    expect(await doc(`wallets/${student}`)).toBeUndefined();
  });

  it("secretaria SEM a permissão extra não estorna (403); com `topup.reverse` e a administração estornam; cantina/responsável nunca", async () => {
    const student = await newStudent();
    const t = await register(secretaria, topupBody(student));
    const topupId = String(t.body.topupId);
    expect((await reverse(secretaria, topupId, reversalBody())).status).toBe(403);
    expect((await reverse(cantina, topupId, reversalBody())).status).toBe(403);
    expect((await reverse(guardianA, topupId, reversalBody())).status).toBe(403);
    expect((await walletOf(student)).balanceCents).toBe(5000);
    const byRev = await reverse(secretariaRev, topupId, reversalBody({ amountCents: 1000 }));
    expect(byRev.status, JSON.stringify(byRev.body)).toBe(200);
    const byAdmin = await reverse(admin, topupId, reversalBody({ amountCents: 500, expectedReversedCents: 1000, reasonCode: "payment_returned", reason: "Devolvido em dinheiro ao responsável" }));
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    expect(byAdmin.body).toMatchObject({ amountCents: 500, wallet: { balanceCents: 3500, version: 3 }, topup: { status: "partially_reversed", reversedCents: 1500, reversibleCents: 3500, referenceReleased: false } });
  });

  it("perfil rebaixado/desativado ou permissão extra retirada entre o 1º envio e a repetição = 403 (relido na transação)", async () => {
    const student = await newStudent();
    const operator = await createTestUser("tsec-rev", "secretaria", { displayName: "Sec Revogável", permissions: ["topup.reverse"] });
    const body = topupBody(student);
    expect((await register(operator, body)).status).toBe(200);
    const rb = reversalBody({ amountCents: 100 });
    const topupId = deterministicId("tpm", operator.uid, body.key);
    expect((await reverse(operator, topupId, rb)).status).toBe(200);
    await setDemoProfile(targetFromEnv(), operator.uid, operator.email, { role: "secretaria", displayName: "Sec Revogável", permissions: [] });
    expect((await reverse(operator, topupId, rb)).status).toBe(403); // replay do estorno sem a permissão extra
    expect((await reverse(operator, topupId, reversalBody({ amountCents: 100, expectedReversedCents: 100 }))).status).toBe(403);
    expect((await register(operator, body)).status).toBe(200); // ainda registra (secretaria)
    // Ator AUTENTICADO antes da mudança (corrida entre autenticação e transação): a releitura do perfil na transação nega.
    const stale = { uid: operator.uid, role: "secretaria" as const, permissions: ["topup.reverse" as const] };
    await expect(reverseManualTopup(db(), stale, { ...reversalBody({ amountCents: 100, expectedReversedCents: 100 }), topupId })).rejects.toThrow(/permissão atual/);
    await setDemoProfile(targetFromEnv(), operator.uid, operator.email, { role: "cantina", displayName: "Sec Revogável" });
    expect((await register(operator, body)).status).toBe(403);
    await expect(registerManualTopup(db(), { ...stale, permissions: [] }, topupBody(student))).rejects.toThrow(/permissão atual/);
    await setDemoProfile(targetFromEnv(), operator.uid, operator.email, { role: "secretaria", status: "disabled", displayName: "Sec Revogável" });
    expect((await register(operator, topupBody(student))).status).toBe(403);
    const w = await expectReconciled(student);
    expect(w.entries.map((e) => e.type)).toEqual(["topup", "topup_reversal"]);
  });

  it("estorno é NOVO movimento: o lançamento original e o histórico ficam intactos; registro e auditoria com motivo e vínculo", async () => {
    const student = await newStudent();
    const t = await register(secretaria, topupBody(student, { amountCents: 3000 }));
    const topupId = String(t.body.topupId);
    const originalEntry = await doc(`wallets/${student}/entries/${topupId}_credit`);
    const body = reversalBody({ amountCents: 1200, reason: "Aluno trocado no lançamento" });
    const r = await reverse(secretariaRev, topupId, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reversalId = String(r.body.reversalId);
    expect(await doc(`wallets/${student}/entries/${topupId}_credit`)).toEqual(originalEntry);
    expect(await doc(`wallets/${student}/entries/${reversalId}_reversal`)).toMatchObject({ type: "topup_reversal", amountCents: -1200, balanceAfterCents: 1800, seq: 2, topupId, reversalId, referenceType: "topup", referenceId: topupId });
    expect(await doc(`topups/${topupId}/reversals/${reversalId}`)).toMatchObject({ topupId, studentId: student, seq: 1, amountCents: 1200, reasonCode: "registration_error", reason: "Aluno trocado no lançamento", reversedAfterCents: 1200, operator: { uid: secretariaRev.uid, name: "Secretaria Estorno" } });
    expect(await doc(`topups/${topupId}`)).toMatchObject({ amountCents: 3000, creditedCents: 3000, reversedCents: 1200, reversalCount: 1, status: "partially_reversed", lastReversalId: reversalId });
    expect(await doc(`auditLog/${secretariaRev.uid}__topup.reverse__${body.key}`)).toMatchObject({ action: "topup.manual.reverse", reason: "Aluno trocado no lançamento", target: { type: "topup", id: topupId }, before: { balanceCents: 3000, reversedCents: 0 }, after: { balanceCents: 1800, reversedCents: 1200, amountCents: 1200 } });
    const receipt = await call(topupRoute, secretaria, "GET", `/api/topups/${topupId}`, undefined, topupId);
    expect(receipt.body).toMatchObject({ topupId, reversedCents: 1200, reversibleCents: 1800, reversals: [{ reversalId, amountCents: 1200, reason: "Aluno trocado no lançamento", operatorName: "Secretaria Estorno" }] });
    noInternalLeak(receipt.body);
  });

  it("estorno: motivo obrigatório (≥ 10), valor acima do restante, recarga inexistente, tela desatualizada e estorno total repetido", async () => {
    const student = await newStudent();
    const t = await register(secretaria, topupBody(student, { amountCents: 2000 }));
    const topupId = String(t.body.topupId);
    expect((await reverse(admin, topupId, reversalBody({ reason: "curto" }))).status).toBe(400);
    expect(await reverse(admin, topupId, reversalBody({ amountCents: 2001 }))).toMatchObject({ status: 409, body: { error: "exceeds_reversible", details: { reversibleCents: 2000 } } });
    expect((await reverse(admin, `tpm_inexistente${tag}`, reversalBody())).body.error).toBe("topup_not_found");
    expect((await reverse(admin, topupId, reversalBody({ amountCents: 2000 }))).status).toBe(200);
    expect(await reverse(admin, topupId, reversalBody({ amountCents: 1 }))).toMatchObject({ status: 409, body: { error: "stale_topup", details: { reversedCents: 2000 } } });
    expect(await reverse(admin, topupId, reversalBody({ amountCents: 1, expectedReversedCents: 2000 }))).toMatchObject({ status: 409, body: { error: "already_reversed" } });
    const w = await expectReconciled(student);
    expect(w.balanceCents).toBe(0);
    expect(await doc(`topups/${topupId}`)).toMatchObject({ status: "reversed", reversedCents: 2000 });
  });

  it("crédito já gasto: estorno acima do saldo atual é recusado sem saldo negativo; estornar até o saldo é possível e o restante segue visível", async () => {
    const student = await newStudent();
    const t = await register(secretaria, topupBody(student, { amountCents: 2000 }));
    const topupId = String(t.body.topupId);
    const product = await newProduct(1500);
    expect((await sell(student, product)).status).toBe(200); // gasta R$ 15 dos R$ 20
    const refused = await reverse(admin, topupId, reversalBody({ amountCents: 2000 }));
    expect(refused).toMatchObject({ status: 409, body: { error: "insufficient_balance", details: { balanceCents: 500, reversibleCents: 2000, maxNowCents: 500 } } });
    expect((await walletOf(student)).balanceCents).toBe(500);
    const partial = await reverse(admin, topupId, reversalBody({ amountCents: 500 }));
    expect(partial.body).toMatchObject({ wallet: { balanceCents: 0 }, topup: { status: "partially_reversed", reversibleCents: 1500 } });
    const w = await expectReconciled(student);
    expect(w.entries.map((e) => [e.type, e.amountCents])).toEqual([["topup", 2000], ["counter_purchase", -1500], ["topup_reversal", -500]]);
  });
});

/* -------------------------------------------------------------------- referência e idempotência */

describe("referência externa única e idempotência", () => {
  it("mesma referência (normalizada) com outra chave = 409 duplicate_reference, inclusive em OUTRO aluno; outra família de meio é independente", async () => {
    const a = await newStudent();
    const b = await newStudent();
    const ref = `e2e-${tag}-ref-01`;
    const first = await register(secretaria, topupBody(a, { reference: ref }));
    expect(first.status).toBe(200);
    for (const [student, variant] of [[a, ref.toUpperCase()], [b, ` ${ref.replace(/-/g, " ")} `]] as const) {
      const dup = await register(admin, topupBody(student, { reference: variant }));
      expect(dup).toMatchObject({ status: 409, body: { error: "duplicate_reference", details: { topupId: first.body.topupId } } });
    }
    const card = await register(secretaria, topupBody(b, { method: "card_debit", reference: ref }));
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    // Débito e crédito compartilham o NSU da maquininha.
    expect((await register(secretaria, topupBody(a, { method: "card_credit", reference: ref }))).body.error).toBe("duplicate_reference");
    expect((await walletOf(a)).balanceCents).toBe(5000);
    expect((await walletOf(b)).balanceCents).toBe(5000);
  });

  it("estorno TOTAL por lançamento incorreto libera a referência (novo registro encadeado); devolução ao pagador mantém bloqueada", async () => {
    const wrong = await newStudent();
    const right = await newStudent();
    const ref = uniqueRef();
    const t = await register(secretaria, topupBody(wrong, { reference: ref, amountCents: 3000 }));
    const topupId = String(t.body.topupId);
    // Estorno parcial não libera.
    expect((await reverse(admin, topupId, reversalBody({ amountCents: 1000 }))).body.topup).toMatchObject({ referenceReleased: false });
    expect((await register(secretaria, topupBody(right, { reference: ref }))).body.error).toBe("duplicate_reference");
    const full = await reverse(admin, topupId, reversalBody({ amountCents: 2000, expectedReversedCents: 1000, reason: "Lançado no aluno errado" }));
    expect(full.body.topup).toMatchObject({ status: "reversed", referenceReleased: true });
    const again = await register(secretaria, topupBody(right, { reference: ref, amountCents: 3000 }));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await doc(`uniquenessKeys/${referenceKeyId("pix", ref.toUpperCase())}`)).toMatchObject({ status: "active", topupId: again.body.topupId, previousTopupId: topupId, studentId: right });
    expect((await register(secretaria, topupBody(wrong, { reference: ref }))).body.error).toBe("duplicate_reference");

    const other = await newStudent();
    const ref2 = uniqueRef();
    const t2 = await register(secretaria, topupBody(other, { reference: ref2, amountCents: 1000 }));
    const back = await reverse(admin, String(t2.body.topupId), reversalBody({ amountCents: 1000, reasonCode: "payment_returned", reason: "Valor devolvido ao pagador" }));
    expect(back.body.topup).toMatchObject({ status: "reversed", referenceReleased: false });
    expect((await register(secretaria, topupBody(other, { reference: ref2 }))).body.error).toBe("duplicate_reference");
    await expectReconciled(wrong);
    await expectReconciled(right);
  });

  it("replay (mesma chave e payload) devolve o MESMO comprovante sem novo crédito; mesma chave com payload diferente = 409", async () => {
    const student = await newStudent();
    const body = topupBody(student);
    const first = await register(secretaria, body);
    const again = await register(secretaria, body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(await register(secretaria, { ...body, amountCents: 6000 })).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
    const rb = reversalBody({ amountCents: 700 });
    const r1 = await reverse(admin, String(first.body.topupId), rb);
    const r2 = await reverse(admin, String(first.body.topupId), rb);
    expect(r2.body).toEqual({ ...r1.body, replayed: true });
    expect(await reverse(admin, String(first.body.topupId), { ...rb, amountCents: 800 })).toMatchObject({ status: 409, body: { error: "idempotency_conflict" } });
    const w = await expectReconciled(student);
    expect(w).toMatchObject({ balanceCents: 4300, version: 2 });
  });

  it("clique duplo (6 envios simultâneos da mesma chave): um crédito; resposta perdida + reenvio da mesma chave = replay", async () => {
    const student = await newStudent();
    const body = topupBody(student);
    const results = await Promise.all(Array.from({ length: 6 }, () => register(secretaria, body)));
    expect(results.every((r) => r.status === 200 && r.body.topupId === results[0]!.body.topupId)).toBe(true);
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect((await walletOf(student)).entries).toHaveLength(1);

    const lost = topupBody(student, { amountCents: 1500 });
    await register(secretaria, lost); // a resposta "se perde": a tela não a vê
    const retry = await register(secretaria, lost);
    expect(retry.body).toMatchObject({ replayed: true, amountCents: 1500 });
    const rb = reversalBody({ amountCents: 300 });
    const reversals = await Promise.all(Array.from({ length: 6 }, () => reverse(admin, String(results[0]!.body.topupId), rb)));
    expect(reversals.every((r) => r.status === 200)).toBe(true);
    expect(reversals.filter((r) => r.body.replayed === false)).toHaveLength(1);
    const w = await expectReconciled(student);
    expect(w).toMatchObject({ balanceCents: 6200, version: 3 });
  });

  it("falha intermediária (lançamento já existente) e no último passo (auditoria): nada persiste e o retry com a mesma chave credita uma vez", async () => {
    const student = await newStudent();
    const body = topupBody(student);
    const topupId = deterministicId("tpm", secretaria.uid, body.key);
    await db().doc(`wallets/${student}/entries/${topupId}_credit`).set({ bloqueio: "teste" });
    const failed = await register(secretaria, body);
    expect(failed.status).toBe(500);
    expect(await doc(`topups/${topupId}`)).toBeUndefined();
    expect(await doc(`wallets/${student}`)).toBeUndefined();
    expect(await doc(`uniquenessKeys/${referenceKeyId("pix", String(body.reference).toUpperCase())}`)).toBeUndefined();
    expect(await doc(`idempotencyRecords/${secretaria.uid}__topup.manual__${body.key}`)).toBeUndefined();
    await db().doc(`wallets/${student}/entries/${topupId}_credit`).delete();

    await db().doc(`auditLog/${secretaria.uid}__topup.manual__${body.key}`).set({ action: "bloqueio-de-teste" });
    expect((await register(secretaria, body)).status).toBe(500);
    expect(await doc(`topups/${topupId}`)).toBeUndefined();
    expect(await doc(`wallets/${student}`)).toBeUndefined();
    await db().doc(`auditLog/${secretaria.uid}__topup.manual__${body.key}`).delete();

    const ok = await register(secretaria, body);
    expect(ok.body).toMatchObject({ replayed: false, topupId });
    // Estorno que falha no último passo também não deixa rastro parcial.
    const rb = reversalBody({ amountCents: 1000 });
    await db().doc(`auditLog/${admin.uid}__topup.reverse__${rb.key}`).set({ action: "bloqueio-de-teste" });
    expect((await reverse(admin, topupId, rb)).status).toBe(500);
    expect(await doc(`topups/${topupId}`)).toMatchObject({ reversedCents: 0, reversalCount: 0, status: "confirmed" });
    await db().doc(`auditLog/${admin.uid}__topup.reverse__${rb.key}`).delete();
    expect((await reverse(admin, topupId, rb)).status).toBe(200);
    const w = await expectReconciled(student);
    expect(w).toMatchObject({ balanceCents: 4000, version: 2 });
  });
});

/* ------------------------------------------------------------------------------ disputas reais */

describe("concorrência: recargas, estornos e consumo do saldo, com reconciliação carteira × livro", () => {
  it("8 recargas simultâneas na mesma carteira: todas creditadas, seq contíguo, soma exata", async () => {
    const student = await newStudent();
    const amounts = [100, 250, 500, 1000, 1234, 2000, 3333, 5000];
    const results = await Promise.all(amounts.map((amountCents, i) => register(i % 2 ? secretaria : admin, topupBody(student, { amountCents }))));
    expect(results.map((r) => r.status)).toEqual(amounts.map(() => 200));
    const w = await expectReconciled(student);
    expect(w).toMatchObject({ balanceCents: amounts.reduce((a, b) => a + b, 0), version: 8 });
  });

  it("mesma referência em duas chaves/operadores ao mesmo tempo: exatamente um crédito", async () => {
    const a = await newStudent();
    const b = await newStudent();
    const ref = uniqueRef();
    const results = await Promise.all([register(secretaria, topupBody(a, { reference: ref })), register(admin, topupBody(b, { reference: ref })), register(secretariaRev, topupBody(a, { reference: ref.toLowerCase() }))]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.body.error === "duplicate_reference")).toHaveLength(2);
    expect((await walletOf(a)).balanceCents + (await walletOf(b)).balanceCents).toBe(5000);
  });

  it("4 estornos simultâneos com chaves diferentes sobre o mesmo estornado visto: só um passa (sem estorno duplicado)", async () => {
    const student = await newStudent();
    const t = await register(secretaria, topupBody(student));
    const topupId = String(t.body.topupId);
    const results = await Promise.all(Array.from({ length: 4 }, () => reverse(admin, topupId, reversalBody({ amountCents: 3000 }))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.body.error === "stale_topup")).toHaveLength(3);
    const w = await expectReconciled(student);
    expect(w.balanceCents).toBe(2000);
    expect(await doc(`topups/${topupId}`)).toMatchObject({ reversedCents: 3000, reversalCount: 1 });
  });

  it("estorno × consumo no balcão disputando o mesmo saldo: nunca ambos, nunca negativo", async () => {
    const student = await newStudent();
    const t = await register(secretaria, topupBody(student, { amountCents: 5000 }));
    const product = await newProduct(3000);
    const [rev, sale] = await Promise.all([reverse(admin, String(t.body.topupId), reversalBody({ amountCents: 5000 })), sell(student, product)]);
    const ok = [rev, sale].filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(rev.status === 200 ? sale.body.error : rev.body.error).toBe("insufficient_balance");
    const w = await expectReconciled(student);
    expect(w.balanceCents).toBe(rev.status === 200 ? 0 : 2000);
  });

  it("mistura simultânea (3 recargas, 3 vendas, 2 estornos): cada resposta 200 aparece uma vez no livro e o saldo fecha", async () => {
    const student = await newStudent();
    const seed = await register(secretaria, topupBody(student, { amountCents: 4000 }));
    const topupId = String(seed.body.topupId);
    const product = await newProduct(700);
    const ops = await Promise.all([
      register(secretaria, topupBody(student, { amountCents: 1000 })),
      register(admin, topupBody(student, { amountCents: 2000 })),
      register(secretariaRev, topupBody(student, { amountCents: 300, method: "cash", reference: undefined })),
      sell(student, product),
      sell(student, product),
      sell(student, product, 2),
      reverse(admin, topupId, reversalBody({ amountCents: 500 })),
      reverse(secretariaRev, topupId, reversalBody({ amountCents: 600 })),
    ]);
    const w = await expectReconciled(student);
    const okCount = ops.filter((r) => r.status === 200).length;
    expect(w.entries).toHaveLength(1 + okCount);
    expect(ops.slice(0, 3).every((r) => r.status === 200)).toBe(true);
    expect(ops.slice(3, 6).every((r) => r.status === 200)).toBe(true); // saldo sempre cobre as vendas (4000 + recargas)
    expect(ops.slice(6).filter((r) => r.status === 200)).toHaveLength(1); // o 2º estorno vê o estornado mudar
    const expected = 4000 + 1000 + 2000 + 300 - 700 * 4 - Number((ops.slice(6).find((r) => r.status === 200)!.body as { amountCents: number }).amountCents);
    expect(w.balanceCents).toBe(expected);
  });
});

/* ------------------------------------------------------------- A30, leituras e visão da família */

describe("A30 e leituras: secretaria sem custos/lucro/usuários; conferência e extrato da família", () => {
  it("secretaria não acessa estoque/custos, reconciliação/auditoria nem gestão de usuários", async () => {
    expect((await call(inventoryRoute, secretaria, "GET", "/api/inventory")).status).toBe(403);
    expect((await call(reconcileRoute, secretaria, "GET", `/api/wallets/reconcile?studentId=x`)).status).toBe(403);
    expect((await call(usersRoute, secretaria, "POST", "/api/admin/users", { key: randomUUID(), uid: guardianB.uid, role: "admin" })).status).toBe(403);
    expect((await call(usersRoute, secretariaRev, "POST", "/api/admin/users", { key: randomUUID(), uid: guardianB.uid, role: "admin" })).status).toBe(403);
  });

  it("busca nominal (alunos ativos com turma/turno), aluno com saldo/versão e últimas recargas; lista do dia com totais e 'só as minhas'", async () => {
    const student = await newStudent({ name: `Homônimo ${tag}` });
    await newStudent({ name: `Homônimo ${tag}` });
    const t = await register(secretaria, topupBody(student, { amountCents: 2500, feeCents: 50 }));
    await register(admin, topupBody(student, { amountCents: 1000, method: "card_credit" }));
    const roster = await call(studentsRoute, secretaria, "GET", "/api/topups/students");
    const rows = (roster.body.students as { id: string; name: string; className: string; shiftName: string }[]).filter((s) => s.name === `Homônimo ${tag}`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ className: `Turma ${tag}`, shiftName: `Tarde ${tag}` });
    noInternalLeak(roster.body);
    const one = await call(studentsRoute, secretaria, "GET", `/api/topups/students?id=${student}`);
    expect(one.body).toMatchObject({ student: { id: student, className: `Turma ${tag}`, status: "active" }, wallet: { balanceCents: 3500, version: 2 } });
    expect((one.body.recent as unknown[]).length).toBe(2);
    noInternalLeak(one.body);

    const day = await call(topupsRoute.GET, secretaria, "GET", `/api/topups?date=${BASE}&mine=1`);
    expect(day.status).toBe(200);
    const mine = day.body.topups as { topupId: string; operatorName: string }[];
    expect(mine.some((x) => x.topupId === t.body.topupId)).toBe(true);
    expect(mine.every((x) => x.operatorName === "Secretaria Teste")).toBe(true);
    const all = await call(topupsRoute.GET, secretaria, "GET", `/api/topups?date=${BASE}`);
    expect((all.body.totals as { count: number }).count).toBeGreaterThan(mine.length);
    const byStudent = await call(topupsRoute.GET, secretaria, "GET", `/api/topups?studentId=${student}`);
    expect((byStudent.body.topups as { amountCents: number }[]).map((x) => x.amountCents)).toEqual([1000, 2500]);
    expect(byStudent.body.totals).toMatchObject({ count: 2, creditedCents: 3500, feeInformedCents: 50, feePendingCount: 1, byMethod: { pix: 2500, card_credit: 1000 } });
    expect((await call(topupsRoute.GET, secretaria, "GET", "/api/topups?date=ontem")).status).toBe(400);
  });

  it("família vê recarga e estorno no extrato com texto próprio, sem referência, operador ou motivo interno; outra família não vê", async () => {
    const student = await newStudent();
    const t = await register(secretaria, topupBody(student, { reference: `REFSECRETA${tag}`, note: "nota interna" }));
    await reverse(admin, String(t.body.topupId), reversalBody({ amountCents: 1000, reason: "motivo interno do estorno" }));
    const statement = await call(entriesRoute, guardianA, "GET", `/api/wallets/entries?studentId=${student}`);
    expect(statement.status).toBe(200);
    const entries = statement.body.entries as { type: string; amountCents: number; reason: string }[];
    expect(entries.map((e) => [e.type, e.amountCents])).toEqual([["topup_reversal", -1000], ["topup", 5000]]);
    expect(entries[1]!.reason).toBe("Recarga na secretaria · Pix");
    expect(entries[0]!.reason).toMatch(/^Estorno de recarga de \d{2}\/\d{2}\/\d{4}$/);
    expect(JSON.stringify(statement.body)).not.toMatch(/REFSECRETA|nota interna|motivo interno|Secretaria Teste/);
    expect((await call(entriesRoute, guardianA, "GET", `/api/wallets/entries?studentId=${student}&type=topup_reversal`)).body.entries).toHaveLength(1);
    expect((await call(entriesRoute, guardianB, "GET", `/api/wallets/entries?studentId=${student}`)).status).toBe(403);
    expect((await call(topupRoute, guardianA, "GET", `/api/topups/${String(t.body.topupId)}`, undefined, String(t.body.topupId))).status).toBe(403);
  });
});
