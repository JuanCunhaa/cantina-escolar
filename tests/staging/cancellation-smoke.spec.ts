// Smoke DIRIGIDO de cancelamento/reembolso (F14) na homologação (emulador ou aplicação publicada), SEM crédito artificial e SEM
// pedido gravado à mão: os alunos fictícios têm carteira R$ 0,00 e nenhum pedido, então NÃO existe pedido para cancelar. Prova o
// que é possível sem compra: autorização por papel na rota nova, validação do corpo (o cliente não informa valor), 403/404 de
// pedido inexistente (família e equipe), resolução `cancel_refund` e `reschedule` (F16: destino obrigatório) em pedido inexistente, consulta da aba
// "Cancelados" e do extrato (índices prontos) e Rules (cancelamentos e reembolso fechados ao cliente).
// NÃO prova: reembolso, liberação de reserva/cota/uso, prazo, descarte, replay e corridas com dados no Firestore real — isso só
// existe no emulador (tests/integration/cancellation-api.test.ts, e2e/cancellation.spec.ts).
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { TestUser } from "../helpers/auth-emulator";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
let fam: Family;
let other: Family;

type Json = Record<string, unknown> & { error?: string; details?: Record<string, unknown> };
const call = async (request: APIRequestContext, user: TestUser | null, method: "GET" | "POST", url: string, data?: unknown) => {
  const response = await request.fetch(url, { method, headers: user ? bearer(user.idToken) : {}, data });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json };
};
const get = (request: APIRequestContext, user: TestUser | null, url: string) => call(request, user, "GET", url);
const cancel = (request: APIRequestContext, user: TestUser | null, orderId: string, data: unknown) => call(request, user, "POST", `/api/orders/${orderId}/cancel`, data);

test.beforeAll(async ({ request }) => {
  fam = await createFamily(request, `hml-cn-${tag}`);
  other = await createFamily(request, `hml-cn2-${tag}`);
});

test("autorização e pedido inexistente: anônimo 401; família 403 sem revelar existência; administração 404", async ({ request }) => {
  const body = () => ({ key: newKey("hml-cn"), reason: "Mudança de planos da família" });
  expect((await cancel(request, null, "ord_inexistente", body())).status).toBe(401);
  expect((await cancel(request, fam.guardian, "ord_inexistente", body())).status).toBe(403);
  expect((await cancel(request, other.guardian, "ord_inexistente", body())).status).toBe(403);
  const admin = await cancel(request, fam.admin, "ord_inexistente", body());
  expect([admin.status, admin.body.error]).toEqual([404, "order_not_found"]);
  expect((await get(request, fam.guardian, "/api/orders/ord_inexistente")).status).toBe(403);
});

test("validação: motivo obrigatório (mínimo 5), campos de valor/aluno recusados, linhas vazias, repetidas ou zeradas e chave inválida dão 400", async ({ request }) => {
  const ok = { key: newKey("hml-cn"), reason: "Mudança de planos da família" };
  for (const bad of [
    { key: ok.key },
    { ...ok, reason: "ok" },
    { ...ok, refundCents: 99999 },
    { ...ok, studentId: fam.studentId },
    { ...ok, lines: [] },
    { ...ok, lines: [{ lineNo: 1, quantity: 1 }, { lineNo: 1, quantity: 2 }] },
    { ...ok, lines: [{ lineNo: 1, quantity: 0 }] },
    { ...ok, key: "x" },
  ]) {
    expect((await cancel(request, fam.guardian, "ord_x", bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await cancel(request, fam.admin, "ord_x", bad)).status, JSON.stringify(bad)).toBe(400);
  }
});

test("resolução de não retirado em pedido inexistente: cancel_refund só da administração (404 do pedido); reagendar (F16) exige destino", async ({ request }) => {
  const base = { key: newKey("hml-cn"), reason: "Política da escola: reembolso" };
  expect((await call(request, fam.guardian, "POST", "/api/operations/orders/ord_x/resolve", { ...base, resolution: "cancel_refund" })).status).toBe(403);
  const refund = await call(request, fam.admin, "POST", "/api/operations/orders/ord_inexistente/resolve", { ...base, resolution: "cancel_refund" });
  expect([refund.status, refund.body.error]).toEqual([404, "order_not_found"]);
  // Reagendar existe desde a F16: sem destino o corpo é inválido; com destino, o pedido inexistente dá 404 (smoke próprio: staging/amend-smoke.spec.ts).
  const reschedule = await call(request, fam.admin, "POST", "/api/operations/orders/ord_inexistente/resolve", { ...base, key: newKey("hml-cn"), resolution: "reschedule" });
  expect(reschedule.status).toBe(400);
});

test("aba Cancelados e extrato vazios respondem 200 (índices prontos), sem reembolso inventado", async ({ request }) => {
  const list = await get(request, fam.guardian, `/api/orders?studentId=${fam.studentId}&group=cancelled`);
  expect([list.status, list.body.orders]).toEqual([200, []]);
  const wallet = await get(request, fam.guardian, `/api/wallets/entries?studentId=${fam.studentId}&type=order_refund`);
  expect(wallet.status).toBe(200);
  expect(wallet.body.entries).toEqual([]);
});

test("Rules publicadas: cancelamentos e reembolso seguem fechados ao cliente (família, administração, anônimo)", async () => {
  for (const [label, token] of [["responsável", fam.guardian.idToken], ["administração", fam.admin.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", "orders/ord_inexistente/cancellations/can_x")).status, `${label}: cancelamento`).toBe(403);
    expect((await fsRequest(token, "PATCH", "orders/ord_inexistente", { status: { stringValue: "cancelled" } })).status, `${label}: escrita no pedido`).toBe(403);
    expect((await fsRequest(token, "PATCH", `wallets/${fam.studentId}/entries/can_x_refund`, { type: { stringValue: "order_refund" }, amountCents: { integerValue: "500" } })).status, `${label}: reembolso direto`).toBe(403);
  }
});
