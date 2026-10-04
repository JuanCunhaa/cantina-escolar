// Histórico de pedidos, detalhe/recibo e extrato (F12) contra Auth/Firestore Emulator, pelas rotas reais.
// Pedidos de outros canais/situações (entregue, cancelado, balcão) ainda NÃO são produzidos pelo sistema (F13–F15): aqui
// entram como FIXTURE com o formato do documento, só para provar filtro, aba e paginação. O fluxo real de compra
// (checkout → Meus pedidos) é provado no e2e. Movimentos do extrato idem (fixture com o formato do livro).
import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";

type Handler = (request: Request, context?: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string };
type OrderRow = { orderId: string; studentId: string; consumptionDate: string; status: string; group: string; paymentState: string; items: { name: string; unitPriceCents: number }[]; shiftName: string | null };
type Page = { orders: OrderRow[]; nextCursor: string | null; students: { id: string; name: string }[]; shifts: { id: string; name: string }[] | null };

let listRoute: Handler;
let detailRoute: Handler;
let statementRoute: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;

let admin: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let guardianBoth: TestUser;
let outsider: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let studentLogin: TestUser;

const tag = randomUUID().slice(0, 6);
const SM = `shf_${tag}_m`;
const ST = `shf_${tag}_t`;
const created: string[] = [];
let seq = 0;

const authed = (url: string, user: TestUser | null) =>
  new Request(`http://localhost${url}`, { method: "GET", headers: user ? { authorization: `Bearer ${user.idToken}` } : {} });
const list = async (user: TestUser | null, query = ""): Promise<{ status: number; body: Json & Partial<Page> }> => {
  const response = await listRoute(authed(`/api/orders?${query}`, user));
  return { status: response.status, body: (await response.json()) as Json & Partial<Page> };
};
const detail = async (user: TestUser | null, id: string) => {
  const response = await detailRoute(authed(`/api/orders/${id}`, user), { params: Promise.resolve({ id }) });
  return { status: response.status, text: await response.text() };
};
const statement = async (user: TestUser | null, query: string) => {
  const response = await statementRoute(authed(`/api/wallets/entries?${query}`, user));
  return { status: response.status, body: (await response.json()) as Json & { entries?: { id: string; seq: number; type: string; orderId: string | null }[]; nextCursor?: string | null } };
};

async function newStudent(over: { guardians?: TestUser[]; revoked?: TestUser[]; login?: boolean } = {}) {
  const id = `stu_${tag}_${++seq}`;
  const name = `Aluno ${tag} ${seq}`;
  await seedStudentAccess({ studentId: id, name, guardianUids: (over.guardians ?? [guardianA]).map((g) => g.uid), revokedGuardianUids: (over.revoked ?? []).map((g) => g.uid), studentUid: over.login ? studentLogin.uid : undefined });
  created.push(`students/${id}`);
  if (over.login) await writeDemoDoc(targetFromEnv(), `uniquenessKeys/studentLogin_${studentLogin.uid}`, { studentId: id });
  return { id, name };
}

type OrderFixture = { id?: string; date: string; status?: string; channel?: string; shiftId?: string; items?: { name: string; price: number; qty?: number }[]; version?: number };
async function order(studentId: string, studentName: string, o: OrderFixture) {
  const orderId = o.id ?? `ord_${tag}_${++seq}`;
  const items = (o.items ?? [{ name: "Suco", price: 450 }]).map((i, n) => ({
    lineNo: n + 1,
    productId: `prd_${n}`,
    name: i.name,
    categoryId: "cat_secreta",
    unit: "un",
    quantity: i.qty ?? 1,
    unitPriceCents: i.price,
    priceVersion: 1,
    discountCents: 0,
    subtotalCents: i.price * (i.qty ?? 1),
    source: "default",
    reservationId: `res_interna_${orderId}_${n}`,
  }));
  await adminDb().doc(`orders/${orderId}`).set({
    orderId,
    batchId: `batch_interno_${orderId}`,
    channel: o.channel ?? "advance",
    status: o.status ?? "paid",
    studentId,
    studentName,
    studentVersion: 3,
    consumptionDate: o.date,
    shiftId: o.shiftId ?? SM,
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    totalCents: items.reduce((n, i) => n + i.subtotalCents, 0),
    walletEntryId: `pay_${orderId}`,
    walletSeq: 1,
    policy: { cancelCutoffAt: Timestamp.fromDate(new Date("2026-10-30T10:00:00Z")), settingsVersion: 7 },
    createdByUid: guardianA.uid,
    createdByRole: "guardian",
    override: { type: "admin_exception", reason: "motivo interno da exceção" },
    version: o.version ?? 1,
    createdAt: Timestamp.fromDate(new Date("2026-10-01T12:00:00Z")),
    updatedAt: Timestamp.now(),
  });
  created.push(`orders/${orderId}`);
  return orderId;
}

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  listRoute = (await import("@/app/api/orders/route")).GET as Handler;
  detailRoute = (await import("@/app/api/orders/[id]/route")).GET as Handler;
  statementRoute = (await import("@/app/api/wallets/entries/route")).GET as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  [admin, guardianA, guardianB, guardianBoth, outsider, cantina, secretaria, studentLogin] = await Promise.all([
    createTestUser("hadm", "admin"),
    createTestUser("hresp-a", "guardian"),
    createTestUser("hresp-b", "guardian"),
    createTestUser("hresp-ab", "guardian"),
    createTestUser("hfora", "guardian"),
    createTestUser("hcant", "cantina"),
    createTestUser("hsec", "secretaria"),
    createTestUser("halu", "student"),
  ]);
  await writeDemoDoc(targetFromEnv(), `shifts/${SM}`, { name: `Manhã ${tag}`, status: "active" });
  await writeDemoDoc(targetFromEnv(), `shifts/${ST}`, { name: `Tarde ${tag}`, status: "active" });
  created.push(`shifts/${SM}`, `shifts/${ST}`);
});
afterAll(async () => {
  for (const path of created.splice(0)) await adminDb().doc(path).delete();
});

const ids = (page: { orders?: OrderRow[] }) => (page.orders ?? []).map((o) => o.orderId);

describe("Meus pedidos — filtros (A26)", () => {
  it("aba, situação detalhada, canal, turno e período, por aluno ou todos os vinculados; balcão e entregue/cancelado aparecem nos grupos", async () => {
    const a = await newStudent({ guardians: [guardianBoth] });
    const b = await newStudent({ guardians: [guardianBoth] });
    const outro = await newStudent({ guardians: [guardianB] });
    const paid = await order(a.id, a.name, { date: "2026-11-10" });
    const prep = await order(a.id, a.name, { date: "2026-11-11", status: "preparing", shiftId: ST });
    const done = await order(a.id, a.name, { date: "2026-11-12", status: "delivered" });
    const counter = await order(a.id, a.name, { date: "2026-11-13", status: "delivered", channel: "counter" });
    const canc = await order(b.id, b.name, { date: "2026-11-14", status: "cancelled" });
    const novo = await order(b.id, b.name, { date: "2026-11-15", status: "status_do_futuro" });
    const alheio = await order(outro.id, outro.name, { date: "2026-11-10" });

    const all = await list(guardianBoth);
    expect(all.status).toBe(200);
    expect(ids(all.body).sort()).toEqual([paid, prep, done, counter, canc, novo].sort());
    expect(ids(all.body)).not.toContain(alheio);
    expect(all.body.students!.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

    expect(ids((await list(guardianBoth, `studentId=${b.id}`)).body)).toEqual([novo, canc]);
    expect(ids((await list(guardianBoth, "group=pending")).body).sort()).toEqual([paid, prep].sort()); // situação fora da lista fechada só aparece em "Todos" (veja history-model.ts)
    expect((all.body.orders!.find((o) => o.orderId === novo) as unknown as { statusLabel: string }).statusLabel).toBe("Em andamento"); // e nunca quebra a tela
    expect(ids((await list(guardianBoth, "group=completed")).body).sort()).toEqual([done, counter].sort());
    expect(ids((await list(guardianBoth, "group=cancelled")).body)).toEqual([canc]);
    expect(ids((await list(guardianBoth, "status=preparing")).body)).toEqual([prep]);
    expect(ids((await list(guardianBoth, "group=completed&status=preparing")).body)).toEqual([]); // situação fora da aba
    expect(ids((await list(guardianBoth, "channel=counter")).body)).toEqual([counter]);
    expect(ids((await list(guardianBoth, `shiftId=${ST}`)).body)).toEqual([prep]);
    expect(ids((await list(guardianBoth, "from=2026-11-11&to=2026-11-13")).body)).toEqual([counter, done, prep]);
    expect(ids((await list(guardianBoth, `studentId=${a.id}&group=completed&channel=advance`)).body)).toEqual([done]);
    // validação: filtros inválidos são recusados, não ignorados
    expect((await list(guardianBoth, "channel=pdv")).status).toBe(400);
    expect((await list(guardianBoth, "from=2026-11-14&to=2026-11-10")).status).toBe(400);
    expect((await list(guardianBoth, "cursor=lixo")).status).toBe(422);
  });

  it("distingue pago aguardando entrega de pagamento pendente na visão (rótulo e campo de pagamento)", async () => {
    const s = await newStudent();
    const pago = await order(s.id, s.name, { date: "2026-12-01" });
    const pend = await order(s.id, s.name, { date: "2026-12-02", status: "payment_pending" });
    const rows = new Map((await list(guardianA, `studentId=${s.id}`)).body.orders!.map((o) => [o.orderId, o]));
    expect(rows.get(pago)).toMatchObject({ status: "paid", paymentState: "paid", group: "pending" });
    expect(rows.get(pend)).toMatchObject({ status: "payment_pending", paymentState: "pending", group: "pending" });
    expect((rows.get(pago) as unknown as { statusLabel: string }).statusLabel).toBe("Pago · aguardando entrega");
    expect((rows.get(pend) as unknown as { statusLabel: string }).statusLabel).toBe("Pagamento pendente");
  });
});

describe("Meus pedidos — paginação por cursor sem duplicar nem omitir (A26)", () => {
  it("percorre 2 alunos com datas repetidas em páginas de 4: união igual ao total, sem repetição, ordem estável; lista vazia e página exata", async () => {
    const a = await newStudent({ guardians: [guardianBoth] });
    const b = await newStudent({ guardians: [guardianBoth] });
    const expected: string[] = [];
    for (let i = 0; i < 13; i++) expected.push(await order(i % 2 ? a.id : b.id, "x", { date: `2027-01-${String(1 + (i % 5)).padStart(2, "0")}` })); // várias por data
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { body: Json & Partial<Page> } = await list(guardianBoth, `limit=4${cursor ? `&cursor=${cursor}` : ""}&from=2027-01-01&to=2027-01-31`);
      seen.push(...ids(page.body));
      expect(page.body.orders!.length).toBeLessThanOrEqual(4);
      cursor = page.body.nextCursor ?? null;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4); // 4+4+4+1
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...expected].sort());
    const keyOf = (id: string) => id; // ordem: data desc, ID desc
    const dates = (await list(guardianBoth, "limit=50&from=2027-01-01&to=2027-01-31")).body.orders!.map((o) => `${o.consumptionDate}|${keyOf(o.orderId)}`);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(seen).toEqual((await list(guardianBoth, "limit=50&from=2027-01-01&to=2027-01-31")).body.orders!.map((o) => o.orderId));
    // total múltiplo do tamanho da página: a última página cheia não anuncia próxima
    const exact = await list(guardianBoth, "limit=13&from=2027-01-01&to=2027-01-31");
    expect(exact.body.nextCursor).toBeNull();
    // sem resultados
    const none = await list(guardianBoth, "from=2030-01-01&to=2030-01-02");
    expect(none.body).toMatchObject({ orders: [], nextCursor: null });
  });

  it("pedido novo entre duas páginas não repete nem remove itens já vistos (cursor por posição, não por deslocamento)", async () => {
    const s = await newStudent();
    const base: string[] = [];
    for (let i = 1; i <= 6; i++) base.push(await order(s.id, s.name, { date: `2027-02-${String(i).padStart(2, "0")}` }));
    const first = await list(guardianA, `studentId=${s.id}&limit=3`);
    const novo = await order(s.id, s.name, { date: "2027-02-20" }); // mais novo que tudo
    const second = await list(guardianA, `studentId=${s.id}&limit=3&cursor=${first.body.nextCursor}`);
    expect([...ids(first.body), ...ids(second.body)].sort()).toEqual([...base].sort());
    expect(ids(second.body)).not.toContain(novo);
  });
});

describe("Meus pedidos — snapshots, detalhe e recibo (A26)", () => {
  it("mostra nome e preço gravados na compra; mudar/desativar o produto depois não altera lista, detalhe nem recibo; nada interno vaza", async () => {
    const s = await newStudent();
    const productId = `prd_${tag}_snap`;
    await writeDemoDoc(targetFromEnv(), `products/${productId}`, { name: "Coxinha", priceCents: 700, status: "active" });
    created.push(`products/${productId}`);
    const id = await order(s.id, s.name, { date: "2027-03-01", items: [{ name: "Coxinha", price: 700, qty: 2 }, { name: "Suco de uva", price: 450 }] });
    await writeDemoDoc(targetFromEnv(), `wallets/${s.id}/entries/pay_${id}`, { type: "advance_purchase", seq: 1, amountCents: -1850, balanceAfterCents: 150, reason: "Compra antecipada para 2027-03-01", orderId: id, createdAt: Timestamp.fromDate(new Date("2026-10-01T12:00:00Z")) as never });
    created.push(`wallets/${s.id}/entries/pay_${id}`);
    await writeDemoDoc(targetFromEnv(), `products/${productId}`, { name: "Coxinha PREMIUM", priceCents: 1500, status: "inactive" });

    const row = (await list(guardianA, `studentId=${s.id}`)).body.orders![0]!;
    expect(row.items.map((i) => [i.name, i.unitPriceCents])).toEqual([["Coxinha", 700], ["Suco de uva", 450]]);
    const response = await detail(guardianA, id);
    expect(response.status).toBe(200);
    const d = JSON.parse(response.text) as { items: { name: string; unitPriceCents: number; subtotalCents: number }[]; totalCents: number; shiftName: string; purchasedBy: string; cancelDeadlineAt: string | null; receipt: { amountCents: number; balanceAfterCents: number; seq: number; walletEntryId: string }; paymentState: string };
    expect(d.items.map((i) => [i.name, i.unitPriceCents, i.subtotalCents])).toEqual([["Coxinha", 700, 1400], ["Suco de uva", 450, 450]]);
    expect(d.totalCents).toBe(1850);
    expect(d).toMatchObject({ shiftName: `Manhã ${tag}`, purchasedBy: "guardian", paymentState: "paid", receipt: { amountCents: -1850, balanceAfterCents: 150, seq: 1, walletEntryId: `pay_${id}` } });
    expect(d.cancelDeadlineAt).toBe("2026-10-30T10:00:00.000Z");
    // proteção dos dados internos: nada disso sai nem na lista nem no detalhe
    for (const text of [response.text, JSON.stringify((await list(guardianA, `studentId=${s.id}`)).body)]) {
      for (const secret of ["res_interna", "batch_interno", "motivo interno", "admin_exception", "cat_secreta", guardianA.uid, "createdByUid", "reservationId", "override", "settingsVersion", "studentVersion", "Coxinha PREMIUM"]) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });
});

describe("Meus pedidos — autorização e isolamento (A26/A33/A34)", () => {
  it("outra família, equipe sem escopo e anônimo não leem lista, detalhe nem extrato; ID inexistente responde igual a pedido alheio", async () => {
    const s = await newStudent({ guardians: [guardianA] });
    const id = await order(s.id, s.name, { date: "2027-04-01" });
    expect((await list(outsider, `studentId=${s.id}`)).status).toBe(403);
    expect((await list(outsider)).body.orders).toEqual([]); // sem studentId: só o que é seu (nada)
    expect((await list(null, `studentId=${s.id}`)).status).toBe(401);
    for (const user of [cantina, secretaria]) {
      expect((await list(user, `studentId=${s.id}`)).status).toBe(403);
      expect((await list(user)).status).toBe(422); // sem aluno informado
      expect((await detail(user, id)).status).toBe(403);
    }
    const alheio = await detail(outsider, id);
    const inexistente = await detail(outsider, `ord_nao_existe_${tag}`);
    expect(alheio.status).toBe(403);
    expect([inexistente.status, inexistente.text]).toEqual([alheio.status, alheio.text]);
    expect((await detail(null, id)).status).toBe(401);
    expect((await statement(outsider, `studentId=${s.id}`)).status).toBe(403);
    expect((await statement(cantina, `studentId=${s.id}`)).status).toBe(403);
    expect((await statement(null, `studentId=${s.id}`)).status).toBe(401);
    // a administração pode consultar (wallet.read/orders.read), mas precisa informar o aluno
    expect((await list(admin, `studentId=${s.id}`)).status).toBe(200);
    expect((await detail(admin, id)).status).toBe(200);
    expect((await list(admin)).status).toBe(422);
  });

  it("vínculo revogado: negado na hora (lista, detalhe e extrato), mesmo com o ator conhecido; sai do escopo 'todos'", async () => {
    const s = await newStudent({ guardians: [guardianBoth] });
    const keep = await newStudent({ guardians: [guardianBoth] });
    const id = await order(s.id, s.name, { date: "2027-05-01" });
    const keepId = await order(keep.id, keep.name, { date: "2027-05-02" });
    expect((await detail(guardianBoth, id)).status).toBe(200);
    expect(ids((await list(guardianBoth)).body)).toEqual(expect.arrayContaining([id, keepId]));
    await writeDemoDoc(targetFromEnv(), `guardianStudentLinks/${guardianBoth.uid}_${s.id}`, { guardianUid: guardianBoth.uid, studentId: s.id, status: "revoked" });
    expect((await detail(guardianBoth, id)).status).toBe(403);
    expect((await list(guardianBoth, `studentId=${s.id}`)).status).toBe(403);
    expect((await statement(guardianBoth, `studentId=${s.id}`)).status).toBe(403);
    const after = ids((await list(guardianBoth)).body);
    expect(after).toContain(keepId);
    expect(after).not.toContain(id);
    // um aluno já revogado desde o início também é negado
    const r = await newStudent({ guardians: [guardianA], revoked: [guardianBoth] });
    const rid = await order(r.id, r.name, { date: "2027-05-03" });
    expect((await detail(guardianBoth, rid)).status).toBe(403);
  });

  it("aluno com login lê só os próprios pedidos; sem studentId o servidor resolve a própria conta; aluno de outro é negado", async () => {
    const mine = await newStudent({ login: true });
    const other = await newStudent({ guardians: [guardianB] });
    const mineOrder = await order(mine.id, mine.name, { date: "2027-06-01" });
    const otherOrder = await order(other.id, other.name, { date: "2027-06-01" });
    const own = await list(studentLogin);
    expect(ids(own.body)).toEqual([mineOrder]);
    expect((await list(studentLogin, `studentId=${other.id}`)).status).toBe(403);
    expect((await detail(studentLogin, mineOrder)).status).toBe(200);
    expect((await detail(studentLogin, otherOrder)).status).toBe(403);
    expect((await statement(studentLogin, `studentId=${mine.id}`)).status).toBe(200); // próprio extrato (wallet.read)
  });
});

describe("Extrato paginado (A26/A34)", () => {
  it("cursor por (instante, seq) percorre todos os movimentos sem repetir nem omitir, inclusive vários no mesmo instante; filtros de tipo e período", async () => {
    const s = await newStudent();
    const at = (iso: string) => Timestamp.fromDate(new Date(iso));
    // 3 movimentos no MESMO instante (lote de datas) + outros em dias diferentes
    const rows: { type: string; at: string; amount: number }[] = [
      { type: "topup", at: "2027-07-01T12:00:00Z", amount: 5000 },
      { type: "advance_purchase", at: "2027-07-02T12:00:00Z", amount: -450 },
      { type: "advance_purchase", at: "2027-07-02T12:00:00Z", amount: -450 },
      { type: "advance_purchase", at: "2027-07-02T12:00:00Z", amount: -450 },
      { type: "transfer_out", at: "2027-07-03T12:00:00Z", amount: -100 },
      { type: "order_refund", at: "2027-07-04T12:00:00Z", amount: 450 },
      { type: "advance_purchase", at: "2027-07-05T12:00:00Z", amount: -450 },
    ];
    let running = 0;
    const all: string[] = [];
    for (const [i, r] of rows.entries()) {
      running += r.amount;
      const id = `mov_${tag}_${s.id}_${i + 1}`;
      await adminDb().doc(`wallets/${s.id}/entries/${id}`).set({ type: r.type, seq: i + 1, amountCents: r.amount, balanceAfterCents: running, reason: "x", createdAt: at(r.at), ...(r.type === "advance_purchase" ? { orderId: `ord_${i}` } : {}) });
      all.push(id);
    }
    created.push(...all.map((id) => `wallets/${s.id}/entries/${id}`));
    const walk = async (query: string) => {
      const seen: { id: string; seq: number }[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const page: Awaited<ReturnType<typeof statement>> = await statement(guardianA, `studentId=${s.id}&limit=3${query}${cursor ? `&cursor=${cursor}` : ""}`);
        expect(page.status).toBe(200);
        seen.push(...page.body.entries!);
        cursor = page.body.nextCursor ?? null;
      } while (cursor && ++guard < 10);
      return seen;
    };
    const full = await walk("");
    expect(full.map((e) => e.id)).toEqual([...all].reverse()); // mais novo primeiro (seq desc dentro do mesmo instante)
    expect(new Set(full.map((e) => e.id)).size).toBe(rows.length);
    expect((await walk("&type=advance_purchase")).map((e) => e.seq)).toEqual([7, 4, 3, 2]);
    expect((await walk("&from=2027-07-02&to=2027-07-03")).map((e) => e.seq)).toEqual([5, 4, 3, 2]);
    expect((await walk("&type=topup&from=2027-07-02")).length).toBe(0);
    expect((await statement(guardianA, `studentId=${s.id}&limit=3&cursor=lixo`)).status).toBe(422);
    expect((await statement(guardianA, `studentId=${s.id}&type=outro`)).status).toBe(400);
    const withOrder = (await statement(guardianA, `studentId=${s.id}&type=advance_purchase&limit=1`)).body.entries![0]!;
    expect(withOrder.orderId).toBe("ord_6"); // liga o movimento ao pedido
  });
});
