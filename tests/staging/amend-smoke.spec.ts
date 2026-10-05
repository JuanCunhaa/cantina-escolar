// Smoke DIRIGIDO de reagendamento/antecipação e troca de produtos (F16) na homologação (emulador ou aplicação publicada), SEM
// crédito artificial e SEM pedido gravado à mão: os alunos fictícios têm carteira R$ 0,00 e nenhum pedido, então NÃO existe pedido
// para reagendar ou trocar. Prova o que é possível sem compra: autorização por papel nas rotas novas (o responsável não tem a
// exceção de horário nem o comando), validação do corpo (o cliente não informa valor/diferença fora do contrato), 404 de pedido
// inexistente para a equipe, resolução `reschedule` com destino, extrato filtrado pelo tipo novo (índice/consulta) e Rules
// (reagendamentos, trocas e o lançamento da diferença fechados ao cliente).
// NÃO prova: liberação/reserva no destino, cota, limites, diferença cobrada/devolvida, replay e corridas com dados no Firestore
// real — isso só existe no emulador (tests/integration/amend-api.test.ts, e2e/amend.spec.ts).
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createTestUser, type TestUser } from "../helpers/auth-emulator";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
let fam: Family;
let cantina: TestUser;

type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: user ? bearer(user.idToken) : {}, data });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
const tomorrow = () => new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
const reschedule = () => ({ key: newKey("hml-am"), reason: "Aluno comprou para a data errada", toDate: tomorrow(), toShiftId: "shf_x" });
const exchange = () => ({ key: newKey("hml-am"), reason: "Aluno pediu outro produto", expectedDifferenceCents: 0, remove: [{ lineNo: 1, quantity: 1 }], add: [{ productId: "prd_x", quantity: 1, expectedPriceCents: 500 }] });

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-am-${tag}`);
  cantina = await createTestUser(`hml-am-cant-${tag}`, "cantina");
});

test("autorização: anônimo 401; responsável 403 em reagendar (mesmo com exceção de horário), trocar, prévia e opções", async ({ request }) => {
  const base = "/api/operations/orders/ord_inexistente";
  expect((await call(request, null, "POST", `${base}/reschedule`, reschedule())).status).toBe(401);
  expect((await call(request, fam.guardian, "POST", `${base}/reschedule`, { ...reschedule(), overrideCutoff: true })).status).toBe(403);
  expect((await call(request, fam.guardian, "POST", `${base}/exchange`, exchange())).status).toBe(403);
  expect((await call(request, fam.guardian, "POST", `${base}/exchange/quote`, { remove: exchange().remove, add: exchange().add })).status).toBe(403);
  expect((await call(request, fam.guardian, "GET", `${base}/amend-options`)).status).toBe(403);
});

test("equipe: pedido inexistente dá 404 em reagendar, trocar, prévia e opções (sem efeito)", async ({ request }) => {
  const base = "/api/operations/orders/ord_inexistente";
  for (const user of [cantina, fam.admin]) {
    for (const [method, url, data] of [
      ["POST", `${base}/reschedule`, reschedule()],
      ["POST", `${base}/exchange`, exchange()],
      ["POST", `${base}/exchange/quote`, { remove: exchange().remove, add: exchange().add }],
      ["GET", `${base}/amend-options`, undefined],
    ] as const) {
      const r = await call(request, user, method, url, data);
      expect([r.status, r.body.error], `${url}`).toEqual([404, "order_not_found"]);
    }
  }
});

test("validação: motivo, destino e diferença confirmada obrigatórios; campos de valor/aluno recusados; quantidade fora do limite dá 400", async ({ request }) => {
  const base = "/api/operations/orders/ord_x";
  for (const bad of [{ ...reschedule(), reason: "ok" }, { ...reschedule(), toDate: "amanhã" }, { ...reschedule(), amountCents: 1 }, { ...reschedule(), studentId: fam.studentId }, { ...reschedule(), key: "x" }]) {
    expect((await call(request, cantina, "POST", `${base}/reschedule`, bad)).status, JSON.stringify(bad)).toBe(400);
  }
  const withoutDiff: Record<string, unknown> = { ...exchange() };
  delete withoutDiff.expectedDifferenceCents;
  for (const bad of [withoutDiff, { ...exchange(), differenceCents: 1 }, { ...exchange(), priceCents: 1 }, { ...exchange(), add: [{ productId: "prd_x", quantity: 21, expectedPriceCents: 500 }] }, { ...exchange(), remove: [] }]) {
    expect((await call(request, cantina, "POST", `${base}/exchange`, bad)).status, JSON.stringify(bad)).toBe(400);
  }
});

test("resolução de não retirado: reagendar exige destino (400 sem ele) e dá 404 em pedido inexistente; só a administração", async ({ request }) => {
  const url = "/api/operations/orders/ord_inexistente/resolve";
  const body = { key: newKey("hml-am"), resolution: "reschedule", reason: "Família pediu outra data" };
  expect((await call(request, cantina, "POST", url, { ...body, toDate: tomorrow(), toShiftId: "shf_x" })).status).toBe(403);
  expect((await call(request, fam.admin, "POST", url, body)).status).toBe(400);
  const r = await call(request, fam.admin, "POST", url, { ...body, key: newKey("hml-am"), toDate: tomorrow(), toShiftId: "shf_x" });
  expect([r.status, r.body.error]).toEqual([404, "order_not_found"]);
});

test("extrato filtrado pela diferença de troca responde 200 vazio (sem lançamento inventado)", async ({ request }) => {
  const r = await call(request, fam.guardian, "GET", `/api/wallets/entries?studentId=${fam.studentId}&type=order_exchange`);
  expect(r.status).toBe(200);
  expect(r.body.entries).toEqual([]);
});

test("Rules publicadas: reagendamentos, trocas, pedido e lançamento da diferença seguem fechados ao cliente", async () => {
  for (const [label, token] of [["responsável", fam.guardian.idToken], ["cantina", cantina.idToken], ["administração", fam.admin.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", "orders/ord_inexistente/reschedules/rsc_x")).status, `${label}: reagendamento`).toBe(403);
    expect((await fsRequest(token, "GET", "orders/ord_inexistente/exchanges/xch_x")).status, `${label}: troca`).toBe(403);
    expect((await fsRequest(token, "PATCH", "orders/ord_inexistente", { consumptionDate: { stringValue: "2026-12-01" } })).status, `${label}: data do pedido`).toBe(403);
    expect((await fsRequest(token, "PATCH", `wallets/${fam.studentId}/entries/xch_x_diff`, { type: { stringValue: "order_exchange" }, amountCents: { integerValue: "500" } })).status, `${label}: diferença direta`).toBe(403);
  }
});
