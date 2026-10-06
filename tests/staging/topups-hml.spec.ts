// Verificação DIRIGIDA da F17 na homologação (emulador no ensaio; Firebase `cantina-escolar-hml` + Vercel na publicada), com
// RECEBIMENTOS SIMULADOS registrados pelo fluxo normal da secretaria (nenhum dinheiro transferido, nenhum provedor real, nenhum
// saldo/pedido gravado pelo Admin SDK — o Admin só LÊ a auditoria). Contas, alunos e produtos fictícios próprios; referência e
// motivo marcados como TESTE HML. Com saldo de verdade no livro, percorre: recarga (Pix com taxa, dinheiro), referência
// duplicada e replay, transferência entre irmãos, checkout antecipado, reagendamento e troca pela equipe, cancelamento com
// reembolso e estorno parcial da recarga, conferindo a cada passo carteira × livro e os registros persistidos.
// O que isto prova: integração com os serviços reais (Auth, Firestore, Rules, índices, Vercel) usando recebimentos SIMULADOS.
// NÃO prova pagamento real (sem Pix/cartão/provedor), concorrência em escala nem latência — isso segue pendente.
// Os movimentos ficam na homologação (auditáveis); só as contas efêmeras são removidas no teardown e os produtos desativados.
import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { admin as harnessAdmin } from "../../scripts/staging/admin.ts";
import { DEMO_SHIFTS } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { createTempProduct, fixtureIds, retireTempProduct } from "../helpers/catalog-fixtures.ts";
import { adminPost, createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
const MARK = "TESTE HML (recebimento simulado, sem dinheiro)";
const P1 = 350;
const P2 = 500;
let fam: Family;
let siblingId = "";
let secretaria: TestUser;
let secretariaRev: TestUser;
let cantina: TestUser;
let morning = "";
let prodA = "";
let prodB = "";
let openDates: string[] = [];
let pixTopupId = "";
let orderId = "";

type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: user ? bearer(user.idToken) : {}, data });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
const wallet = async (request: APIRequestContext, studentId: string) => (await call(request, fam.guardian, "GET", `/api/wallets?studentId=${studentId}`)).body as { balanceCents: number; version: number; entries: { type: string; amountCents: number }[] };
async function reconciled(request: APIRequestContext, studentId: string, balanceCents: number) {
  const r = await call(request, fam.admin, "GET", `/api/wallets/reconcile?studentId=${studentId}`);
  expect(r.body, `reconciliação ${studentId}`).toMatchObject({ ok: true, problems: [], balanceCents });
  return r.body as { entryCount: number; version: number };
}
const audit = async (id: string) => (await harnessAdmin().db.doc(`auditLog/${id}`).get()).data();

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-tp-${tag.toLowerCase()}`);
  [secretaria, secretariaRev, cantina] = await Promise.all([
    createTestUser(`hml-tp-sec-${tag.toLowerCase()}`, "secretaria", { displayName: "Secretaria HML (teste)" }),
    createTestUser(`hml-tp-secrev-${tag.toLowerCase()}`, "secretaria", { displayName: "Secretaria Estorno HML (teste)", permissions: ["topup.reverse"] }),
    createTestUser(`hml-tp-cant-${tag.toLowerCase()}`, "cantina"),
  ]);
  const ids = await fixtureIds();
  morning = ids.shift(DEMO_SHIFTS[0].name);
  const sibling = await adminPost(request, fam.admin, "/api/students", { action: "create", enrollment: `EXI${tag}`, name: `Irmão ${tag} (exemplo)`, classId: ids.classId(), shiftId: morning });
  siblingId = String(sibling.studentId);
  await adminPost(request, fam.admin, "/api/links", { action: "add", studentId: siblingId, guardianEmail: fam.guardian.email, reason: "Teste automatizado (fictício)" });
  prodA = await createTempProduct(request, fam.admin.idToken, `Recarga HML A ${tag}`, { priceCents: P1, shiftIds: [morning] });
  prodB = await createTempProduct(request, fam.admin.idToken, `Recarga HML B ${tag}`, { priceCents: P2, shiftIds: [morning] });
  for (const id of [prodA, prodB]) {
    const menu = await call(request, fam.admin, "POST", "/api/menu", { key: randomUUID(), action: "setDefault", productId: id, shiftIds: [morning], expectedVersion: 0 });
    expect(menu.status, JSON.stringify(menu.body)).toBe(200);
    const stock = await call(request, fam.admin, "POST", "/api/inventory/receipts", { key: randomUUID(), action: "create", productId: id, kind: "purchase", quantity: 20, unitCost: "1,00" });
    expect(stock.status, JSON.stringify(stock.body)).toBe(200);
  }
  const week = (await call(request, fam.guardian, "GET", `/api/menu?studentId=${fam.studentId}`)).body as { today: string; days: { date: string; allowed: boolean }[] };
  openDates = week.days.filter((d) => d.allowed && d.date !== week.today).map((d) => d.date);
  expect(openDates.length, "datas abertas para compra").toBeGreaterThanOrEqual(2);
});

test.afterAll(async ({ request }) => {
  for (const id of [prodA, prodB]) if (id) await retireTempProduct(request, fam.admin.idToken, id).catch(() => undefined);
});

test("recarga Pix R$ 50 com taxa R$ 1,50 (simulada): crédito R$ 50, líquido R$ 48,50, auditoria; replay e referência duplicada não creditam de novo", async ({ request }) => {
  const body = { key: newKey("hml-tp"), studentId: fam.studentId, amountCents: 5000, method: "pix", receivedConfirmed: true, reference: `HML-TESTE-${tag}-PIX`, feeCents: 150, payerName: "Responsável fictício (HML)", note: MARK };
  const r = await call(request, secretaria, "POST", "/api/topups", body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body).toMatchObject({ replayed: false, amountCents: 5000, creditedCents: 5000, netCents: 4850, fee: { status: "informed", cents: 150 }, settlement: { status: "settled" }, balanceAfterCents: 5000, operatorName: "Secretaria HML (teste)" });
  pixTopupId = String(r.body.topupId);
  const replay = await call(request, secretaria, "POST", "/api/topups", body);
  expect(replay.body).toMatchObject({ replayed: true, topupId: pixTopupId });
  const dup = await call(request, fam.admin, "POST", "/api/topups", { ...body, key: newKey("hml-tp"), reference: `hml teste ${tag} pix` });
  expect([dup.status, dup.body.error]).toEqual([409, "duplicate_reference"]);
  expect(await wallet(request, fam.studentId)).toMatchObject({ balanceCents: 5000, version: 1 });
  await reconciled(request, fam.studentId, 5000);
  expect(await audit(`${secretaria.uid}__topup.manual__${body.key}`)).toMatchObject({ action: "topup.manual.register", target: { type: "topup", id: pixTopupId }, after: { creditedCents: 5000, netCents: 4850 } });

  // Cartão aprovado ≠ liquidado; dinheiro sem taxa — no irmão.
  const card = await call(request, secretaria, "POST", "/api/topups", { key: newKey("hml-tp"), studentId: siblingId, amountCents: 1000, method: "card_debit", receivedConfirmed: true, reference: `HML-TESTE-${tag}-NSU`, note: MARK });
  expect(card.body).toMatchObject({ settlement: { status: "pending", settledOn: null }, fee: { status: "pending" }, netCents: null });
  const cash = await call(request, secretaria, "POST", "/api/topups", { key: newKey("hml-tp"), studentId: siblingId, amountCents: 500, method: "cash", receivedConfirmed: true, note: MARK });
  expect(cash.body).toMatchObject({ settlement: { status: "cash_on_hand" }, fee: { status: "none", cents: 0 }, netCents: 500 });
  await reconciled(request, siblingId, 1500);
});

test("autorização na nuvem: responsável/cantina não registram; secretaria sem a permissão separada não estorna; Rules fecham recargas ao cliente", async ({ request }) => {
  const body = { key: newKey("hml-tp"), studentId: fam.studentId, amountCents: 100, method: "cash", receivedConfirmed: true, note: MARK };
  expect((await call(request, fam.guardian, "POST", "/api/topups", body)).status).toBe(403);
  expect((await call(request, cantina, "POST", "/api/topups", body)).status).toBe(403);
  expect((await call(request, null, "POST", "/api/topups", body)).status).toBe(401);
  const rev = { key: newKey("hml-tp"), amountCents: 100, reasonCode: "registration_error", reason: `${MARK}: tentativa sem permissão`, expectedReversedCents: 0 };
  expect((await call(request, secretaria, "POST", `/api/topups/${pixTopupId}/reverse`, rev)).status).toBe(403);
  expect((await call(request, cantina, "POST", `/api/topups/${pixTopupId}/reverse`, rev)).status).toBe(403);
  expect((await call(request, secretaria, "GET", "/api/inventory")).status).toBe(403); // A30: secretaria sem estoque/custos
  for (const user of [fam.guardian, secretaria, fam.admin]) {
    expect((await fsRequest(user.idToken, "GET", `topups/${pixTopupId}`)).status, user.email).toBe(403);
  }
  expect((await fsRequest(fam.guardian.idToken, "GET", `wallets/${fam.studentId}/entries/${pixTopupId}_credit`)).status).toBe(200);
  expect((await wallet(request, fam.studentId)).balanceCents).toBe(5000);
});

test("transferência com saldo real: R$ 10 do aluno para o irmão, conservação e reconciliação das duas carteiras", async ({ request }) => {
  const r = await call(request, fam.guardian, "POST", "/api/wallets/transfer", { key: newKey("hml-tp"), fromStudentId: fam.studentId, toStudentId: siblingId, amountCents: 1000, reason: `${MARK}: transferência` });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await reconciled(request, fam.studentId, 4000);
  await reconciled(request, siblingId, 2500);
});

test("checkout antecipado com saldo: 2 un. na 1ª data aberta, débito único, reserva no estoque", async ({ request }) => {
  const r = await call(request, fam.guardian, "POST", "/api/orders/checkout", { key: newKey("hml-tp"), studentId: fam.studentId, expectedShiftId: morning, days: [{ date: openDates[0], lines: [{ productId: prodA, quantity: 2, expectedPriceCents: P1 }] }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const orders = r.body.orders as { orderId: string; totalCents: number }[];
  expect(orders).toHaveLength(1);
  orderId = orders[0]!.orderId;
  expect(r.body.wallet).toMatchObject({ balanceCents: 4000 - 2 * P1 });
  await reconciled(request, fam.studentId, 4000 - 2 * P1);
  const stock = await call(request, fam.admin, "GET", `/api/inventory/product?productId=${prodA}`);
  expect(stock.body).toMatchObject({ reservedUnits: 2 });
});

test("reagendamento e troca pela equipe: data movida sem lançamento; troca de 1 un. cobra a diferença R$ 1,50 na carteira original", async ({ request }) => {
  const base = `/api/operations/orders/${orderId}`;
  const moved = await call(request, cantina, "POST", `${base}/reschedule`, { key: newKey("hml-tp"), reason: `${MARK}: reagendar`, toDate: openDates[1], toShiftId: morning });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  const afterMove = 4000 - 2 * P1;
  await reconciled(request, fam.studentId, afterMove);
  const quote = await call(request, cantina, "POST", `${base}/exchange/quote`, { remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: prodB, quantity: 1, expectedPriceCents: P2 }] });
  expect(quote.status, JSON.stringify(quote.body)).toBe(200);
  expect(quote.body.differenceCents).toBe(P2 - P1);
  const ex = await call(request, cantina, "POST", `${base}/exchange`, { key: newKey("hml-tp"), reason: `${MARK}: troca`, expectedDifferenceCents: P2 - P1, remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: prodB, quantity: 1, expectedPriceCents: P2 }] });
  expect(ex.status, JSON.stringify(ex.body)).toBe(200);
  await reconciled(request, fam.studentId, afterMove - (P2 - P1));
  const detail = await call(request, fam.guardian, "GET", `/api/orders/${orderId}`);
  expect(detail.status).toBe(200);
  expect(JSON.stringify(detail.body)).toContain(openDates[1]!);
});

test("cancelamento total pela família: reembolso do valor pago (R$ 8,50) na carteira original e reservas liberadas", async ({ request }) => {
  const before = (await wallet(request, fam.studentId)).balanceCents;
  const r = await call(request, fam.guardian, "POST", `/api/orders/${orderId}/cancel`, { key: newKey("hml-tp"), reason: `${MARK}: cancelamento` });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.refundCents).toBe(P1 + P2);
  await reconciled(request, fam.studentId, before + P1 + P2);
  for (const id of [prodA, prodB]) expect((await call(request, fam.admin, "GET", `/api/inventory/product?productId=${id}`)).body).toMatchObject({ reservedUnits: 0 });
});

test("estorno parcial da recarga com permissão separada: novo movimento, histórico preservado, sem estorno duplicado; extrato da família", async ({ request }) => {
  const balance = (await wallet(request, fam.studentId)).balanceCents;
  expect(balance).toBe(4000); // 5000 − 1000 (transferência) − 700 − 150 + 850
  const body = { key: newKey("hml-tp"), amountCents: 1500, reasonCode: "registration_error", reason: `${MARK}: estorno parcial`, expectedReversedCents: 0 };
  const r = await call(request, secretariaRev, "POST", `/api/topups/${pixTopupId}/reverse`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body).toMatchObject({ amountCents: 1500, wallet: { balanceCents: 2500 }, topup: { status: "partially_reversed", reversedCents: 1500, reversibleCents: 3500, referenceReleased: false } });
  const stale = await call(request, fam.admin, "POST", `/api/topups/${pixTopupId}/reverse`, { ...body, key: newKey("hml-tp") });
  expect([stale.status, stale.body.error]).toEqual([409, "stale_topup"]);
  const over = await call(request, fam.admin, "POST", `/api/topups/${pixTopupId}/reverse`, { ...body, key: newKey("hml-tp"), amountCents: 3000, expectedReversedCents: 1500 });
  expect([over.status, over.body.error]).toEqual([409, "insufficient_balance"]);
  await reconciled(request, fam.studentId, 2500);
  const receipt = await call(request, secretaria, "GET", `/api/topups/${pixTopupId}`);
  expect(receipt.body).toMatchObject({ amountCents: 5000, creditedCents: 5000, reversedCents: 1500, reversals: [{ amountCents: 1500, operatorName: "Secretaria Estorno HML (teste)" }] });
  expect(await audit(`${secretariaRev.uid}__topup.reverse__${body.key}`)).toMatchObject({ action: "topup.manual.reverse", after: { reversedCents: 1500 } });
  const statement = await call(request, fam.guardian, "GET", `/api/wallets/entries?studentId=${fam.studentId}`);
  const types = (statement.body.entries as { type: string }[]).map((e) => e.type);
  expect(types).toEqual(["topup_reversal", "order_refund", "order_exchange", "advance_purchase", "transfer_out", "topup"]);
  // A família não vê referência, observação/motivo da equipe nem operador (o motivo da transferência é dela própria).
  expect(JSON.stringify(statement.body)).not.toMatch(/HML-TESTE|estorno parcial|Secretaria Estorno|Responsável fictício/);
  const day = await call(request, secretaria, "GET", `/api/topups?studentId=${fam.studentId}`);
  expect((day.body.topups as { topupId: string }[]).map((t) => t.topupId)).toEqual([pixTopupId]); // índice studentId+createdAt
});

test("tela publicada: a secretaria vê a recarga na conferência do dia e o comprovante (sem botão de estorno)", async ({ page }) => {
  await page.goto("/operacao/recebimentos");
  await page.getByLabel("Email").fill(secretaria.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("topup-student-search")).toBeVisible({ timeout: 60000 });
  await page.getByTestId("topup-only-mine").check();
  await expect(page.getByTestId("topup-day-row").filter({ hasText: fam.studentName })).toContainText("48,50", { timeout: 30000 });
  await page.goto(`/operacao/recebimentos/${pixTopupId}`);
  await expect(page.getByTestId("receipt-credited")).toHaveText("R$ 50,00", { timeout: 30000 });
  await expect(page.getByTestId("receipt-net")).toHaveText("R$ 48,50");
  await expect(page.getByTestId("receipt-status")).toContainText("Estornada em parte");
  await expect(page.getByTestId("receipt-reverse-open")).toHaveCount(0);
});
