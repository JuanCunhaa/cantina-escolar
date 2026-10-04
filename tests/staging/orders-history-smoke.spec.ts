// Smoke DIRIGIDO de "Meus pedidos", detalhe/recibo e extrato (F12) na homologação (emulador ou aplicação publicada), SEM crédito
// artificial e SEM pedido gravado à mão: os alunos fictícios têm carteira R$ 0,00 e nenhum pedido. Prova o que é possível sem
// compra: autorização e isolamento das rotas, respostas vazias, validação de filtros/cursor, as Rules publicadas e a tela.
// Como a consulta ao Firestore real EXIGE índice composto mesmo sem documentos, cada combinação de filtros abaixo também prova
// (ou refuta) que os índices de firebase/firestore.indexes.json estão publicados e prontos. NÃO prova paginação, snapshot nem
// filtros com dados no Firestore real: isso só existe no emulador (tests/integration/orders-history-api.test.ts, e2e/my-orders).
import { expect, test, type APIRequestContext } from "@playwright/test";
import { DEMO_SHIFTS } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, TEST_PASSWORD, type TestUser } from "../helpers/auth-emulator";
import { fixtureIds } from "../helpers/catalog-fixtures.ts";
import { createFamily, type Family } from "../helpers/menu-fixtures.ts";
import { bearer, fsRequest } from "./helpers";

test.describe.configure({ mode: "serial" });

const tag = Math.random().toString(36).slice(2, 7);
let famA: Family;
let famB: Family;
let cantina: TestUser;
let morning = "";

type Json = Record<string, unknown> & { error?: string };
const get = async (request: APIRequestContext, user: TestUser | null, url: string) => {
  const response = await request.get(url, { headers: user ? bearer(user.idToken) : {} });
  return { status: response.status(), body: (await response.json().catch(() => ({}))) as Json, text: await response.text().catch(() => "") };
};

test.beforeAll(async ({ request }) => {
  famA = await createFamily(request, `hml-oh-a-${tag}`);
  famB = await createFamily(request, `hml-oh-b-${tag}`);
  cantina = await createTestUser(`hml-oh-cant-${tag}`, "cantina");
  morning = (await fixtureIds()).shift(DEMO_SHIFTS[0].name);
});

test("histórico vazio do responsável: 200, sem cursor, aluno e turnos no escopo (nenhum pedido existe)", async ({ request }) => {
  for (const query of ["", `studentId=${famA.studentId}`, "group=pending", "group=completed", "group=cancelled"]) {
    const page = await get(request, famA.guardian, `/api/orders?${query}`);
    expect([page.status, page.body.orders, page.body.nextCursor], query).toEqual([200, [], null]);
  }
  const first = await get(request, famA.guardian, "/api/orders");
  expect((first.body.students as { id: string }[]).map((s) => s.id)).toEqual([famA.studentId]);
  expect(Array.isArray(first.body.shifts)).toBe(true);
});

test("índices publicados: todas as combinações de filtros respondem 200 (sem FAILED_PRECONDITION), incluindo status+canal+turno e período", async ({ request }) => {
  const s = `studentId=${famA.studentId}`;
  const combos = [
    "group=pending&channel=advance",
    `group=pending&shiftId=${morning}`,
    `channel=advance&shiftId=${morning}`,
    `group=pending&channel=advance&shiftId=${morning}`,
    `group=completed&channel=counter&shiftId=${morning}&from=2026-10-01&to=2026-12-31`,
    "status=paid&channel=advance",
    "status=paid",
    "group=all&from=2026-10-01&to=2026-12-31",
    "limit=50",
  ];
  for (const combo of combos) {
    for (const scope of [s, ""]) {
      const page = await get(request, famA.guardian, `/api/orders?${scope}&${combo}`);
      expect([page.status, page.body.orders], `${scope}&${combo}`).toEqual([200, []]);
    }
  }
  const statements = ["", "type=advance_purchase", "type=topup&from=2026-10-01&to=2026-12-31", "from=2026-10-01", "to=2026-12-31", "type=transfer_in&limit=50"];
  for (const q of statements) {
    const page = await get(request, famA.guardian, `/api/wallets/entries?${s}&${q}`);
    expect([page.status, page.body.entries, page.body.nextCursor], q).toEqual([200, [], null]);
  }
});

test("validação: filtro/cursor inválidos recusados (400/422), nunca ignorados", async ({ request }) => {
  const s = `studentId=${famA.studentId}`;
  for (const bad of ["channel=pdv", "status=inventado", "from=2026-02-30", "from=2026-12-01&to=2026-10-01", "limit=0", "limit=51", "outro=1"]) {
    expect((await get(request, famA.guardian, `/api/orders?${s}&${bad}`)).status, bad).toBe(400);
  }
  expect((await get(request, famA.guardian, `/api/orders?${s}&cursor=lixo`)).status).toBe(422);
  expect((await get(request, famA.guardian, `/api/wallets/entries?${s}&type=outro`)).status).toBe(400);
  expect((await get(request, famA.guardian, `/api/wallets/entries?${s}&cursor=lixo`)).status).toBe(422);
});

test("autorização e isolamento: anônimo 401; outra família, cantina e administração sem escopo negadas; detalhe inexistente = alheio (A33)", async ({ request }) => {
  const s = `studentId=${famA.studentId}`;
  expect((await get(request, null, `/api/orders?${s}`)).status).toBe(401);
  expect((await get(request, null, "/api/orders/ord_x")).status).toBe(401);
  expect((await get(request, null, `/api/wallets/entries?${s}`)).status).toBe(401);
  expect((await get(request, famB.guardian, `/api/orders?${s}`)).status).toBe(403);
  expect((await get(request, famB.guardian, `/api/wallets/entries?${s}`)).status).toBe(403);
  expect((await get(request, cantina, `/api/orders?${s}`)).status).toBe(403);
  expect((await get(request, cantina, `/api/wallets/entries?${s}`)).status).toBe(403);
  expect((await get(request, cantina, "/api/orders")).status).toBe(422);
  expect((await get(request, famA.admin, "/api/orders")).status).toBe(422); // administração precisa informar o aluno
  expect((await get(request, famA.admin, `/api/orders?${s}`)).status).toBe(200);
  const own = await get(request, famB.guardian, "/api/orders");
  expect((own.body.students as { id: string }[]).map((x) => x.id)).toEqual([famB.studentId]); // sem studentId: só o que é seu
  const a = await get(request, famB.guardian, "/api/orders/ord_inexistente_a");
  const b = await get(request, famA.guardian, "/api/orders/ord_inexistente_b");
  expect([a.status, b.status]).toEqual([403, 403]);
});

test("Rules publicadas inalteradas: pedidos seguem fechados ao cliente; carteira e extrato só do responsável vinculado (A33/A34)", async () => {
  for (const [label, token] of [["responsável vinculado", famA.guardian.idToken], ["outra família", famB.guardian.idToken], ["cantina", cantina.idToken], ["anônimo", null]] as const) {
    expect((await fsRequest(token, "GET", "orders/ord_inexistente")).status, `${label}: pedido`).toBe(403);
  }
  expect([200, 404]).toContain((await fsRequest(famA.guardian.idToken, "GET", `wallets/${famA.studentId}`)).status); // vinculado lê (documento ainda pode não existir)
  expect((await fsRequest(famB.guardian.idToken, "GET", `wallets/${famA.studentId}`)).status).toBe(403);
});

test("tela publicada: Meus pedidos vazio (sem parecer erro) e extrato vazio; o aluno de outra conta não aparece", async ({ page }) => {
  await page.goto("/portal/pedidos");
  await page.getByLabel("Email").fill(famA.guardian.email);
  await page.getByLabel("Senha").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("orders-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("orders-error")).toHaveCount(0);
  await expect(page.getByTestId("orders-tab-pending")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("orders-tab-all").click();
  await expect(page.getByTestId("orders-empty")).toBeVisible();
  await page.goto("/portal/carteira/extrato");
  await expect(page.getByTestId("statement-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("statement-error")).toHaveCount(0);
  await expect(page.getByLabel("Aluno")).toContainText(famA.studentName);
  await expect(page.getByLabel("Aluno")).not.toContainText(famB.studentName);
});
