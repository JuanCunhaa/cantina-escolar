import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import { fundDemoWallet } from "../../scripts/lib/demo-seed";

type Handler = (request: Request, context?: never) => Promise<Response>;
type Json = Record<string, unknown>;

let transfer: Handler;
let walletRead: Handler;
let reconcile: Handler;
let studentsRoute: Handler;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let deterministicId: typeof import("@/lib/firebase/command").deterministicId;

let admin: TestUser;
let cantina: TestUser;
let secretaria: TestUser;
let guardian: TestUser; // vinculado a todos os alunos da família
let other: TestUser; // outra família
let studentLogin: TestUser;

const tag = randomUUID().slice(0, 6);
const target = () => targetFromEnv();
let counter = 0;
const sid = (name: string) => `stu_${tag}_${name}_${++counter}`;

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  transfer = (await import("@/app/api/wallets/transfer/route")).POST as Handler;
  walletRead = (await import("@/app/api/wallets/route")).GET as Handler;
  reconcile = (await import("@/app/api/wallets/reconcile/route")).GET as Handler;
  studentsRoute = (await import("@/app/api/students/route")).POST as Handler;
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ deterministicId } = await import("@/lib/firebase/command"));
  admin = await createTestUser("wadm", "admin");
  cantina = await createTestUser("wcant", "cantina");
  secretaria = await createTestUser("wsec", "secretaria");
  guardian = await createTestUser("wresp", "guardian");
  other = await createTestUser("wfora", "guardian");
  studentLogin = await createTestUser("walu", "student");
});

function req(method: string, url: string, token: string | null, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const send = (user: TestUser | null, from: string, to: string, amountCents: number, key: string = randomUUID(), extra: Json = {}) =>
  transfer(req("POST", "/api/wallets/transfer", user?.idToken ?? null, { key, fromStudentId: from, toStudentId: to, amountCents, ...extra }));
const read = (user: TestUser | null, studentId: string) => walletRead(req("GET", `/api/wallets?studentId=${studentId}`, user?.idToken ?? null));
const reconcileOf = async (studentId: string) => {
  const response = await reconcile(req("GET", `/api/wallets/reconcile?studentId=${studentId}`, admin.idToken));
  expect(response.status).toBe(200);
  return (await response.json()) as { ok: boolean; problems: string[]; balanceCents: number; version: number; entryCount: number; ledgerSumCents: number };
};

/** Família: n alunos ativos vinculados ao responsável, cada um com saldo inicial por fixture. */
async function family(balances: number[], who: TestUser[] = [guardian]): Promise<string[]> {
  const ids = balances.map((_, i) => sid(`f${i}`));
  for (const [i, id] of ids.entries()) {
    await seedStudentAccess({ studentId: id, name: `Aluno ${i}`, guardianUids: who.map((u) => u.uid) });
    if (balances[i]! > 0) await fundDemoWallet(target(), id, balances[i]!);
  }
  return ids;
}
const balanceOf = async (id: string) => ((await (await read(admin, id)).json()) as { balanceCents: number }).balanceCents;
const entriesOf = async (id: string) => (await adminDb().collection(`wallets/${id}/entries`).get()).size;
const transfersCount = async (ids: string[]) =>
  (await adminDb().collection("walletTransfers").where("fromStudentId", "in", ids).get()).size;

describe("A01 — carteiras individuais e independentes", () => {
  it("transferir entre dois alunos só altera as duas carteiras; a de um terceiro irmão e a de outra família não mudam", async () => {
    const [a, b, c] = await family([5000, 2000, 3000]);
    const [d] = await family([700], [other]);
    const response = await send(guardian, a!, b!, 1250);
    expect(response.status).toBe(200);
    expect(await balanceOf(a!)).toBe(3750);
    expect(await balanceOf(b!)).toBe(3250);
    expect(await balanceOf(c!)).toBe(3000);
    expect(await balanceOf(d!)).toBe(700);
    expect(await entriesOf(c!)).toBe(1); // só a fixture
    expect((await adminDb().doc(`wallets/${c!}`).get()).get("version")).toBe(1);
  });
});

describe("A03 — transferência A→B", () => {
  it("conserva o total, grava duas pernas com o mesmo transferId, projeção ligada ao livro e auditoria na mesma transação", async () => {
    const [a, b] = await family([5000, 2001]);
    const key = randomUUID();
    const response = await send(guardian, a!, b!, 1250, key);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { transferId: string; replayed: boolean; from: { balanceCents: number; version: number; seq: number }; to: { balanceCents: number; version: number } };
    expect(body.replayed).toBe(false);
    expect(body.from).toMatchObject({ balanceCents: 3750, version: 2, seq: 2 });
    expect(body.to).toMatchObject({ balanceCents: 3251, version: 2 });
    expect(body.from.balanceCents + body.to.balanceCents).toBe(7001);

    const db = adminDb();
    const out = (await db.doc(`wallets/${a!}/entries/${body.transferId}_out`).get()).data()!;
    const inn = (await db.doc(`wallets/${b!}/entries/${body.transferId}_in`).get()).data()!;
    expect(out).toMatchObject({ type: "transfer_out", amountCents: -1250, balanceAfterCents: 3750, seq: 2, transferId: body.transferId, counterpartStudentId: b });
    expect(inn).toMatchObject({ type: "transfer_in", amountCents: 1250, balanceAfterCents: 3251, seq: 2, transferId: body.transferId, counterpartStudentId: a });
    const record = (await db.doc(`walletTransfers/${body.transferId}`).get()).data()!;
    expect(record).toMatchObject({ fromStudentId: a, toStudentId: b, amountCents: 1250, actorUid: guardian.uid });
    const audit = (await db.doc(`auditLog/${guardian.uid}__wallet.transfer__${key}`).get()).data()!;
    expect(audit).toMatchObject({ action: "wallet.transfer", actorUid: guardian.uid });
    for (const id of [a!, b!]) expect(await reconcileOf(id)).toMatchObject({ ok: true, problems: [] });
  });

  it("repetir a mesma operação não transfere de novo: devolve o resultado original (replayed) sem novo movimento", async () => {
    const [a, b] = await family([5000, 0]);
    const key = randomUUID();
    const first = (await (await send(guardian, a!, b!, 1000, key)).json()) as Json;
    const again = await send(guardian, a!, b!, 1000, key);
    expect(again.status).toBe(200);
    const replay = (await again.json()) as Json;
    expect(replay).toMatchObject({ transferId: first.transferId, replayed: true, from: first.from, to: first.to });
    expect(await balanceOf(a!)).toBe(4000);
    expect(await balanceOf(b!)).toBe(1000);
    expect(await entriesOf(a!)).toBe(2);
    expect(await entriesOf(b!)).toBe(1);
  });

  it("mesma chave com payload diferente é conflito e não move nada", async () => {
    const [a, b] = await family([5000, 0]);
    const key = randomUUID();
    expect((await send(guardian, a!, b!, 1000, key)).status).toBe(200);
    for (const [from, to, amount] of [[a!, b!, 1001], [b!, a!, 1000]] as const) {
      const response = await send(guardian, from, to, amount, key);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "idempotency_conflict" });
    }
    expect(await balanceOf(a!)).toBe(4000);
  });

  it("verifica o vínculo às DUAS carteiras: sem vínculo a uma ponta, vínculo revogado, outra família, equipe e aluno são negados sem escrever", async () => {
    const [a, b] = await family([5000, 1000]);
    const [x] = await family([900], [other]); // aluno de outra família
    const revoked = sid("rev");
    await seedStudentAccess({ studentId: revoked, name: "Revogado", revokedGuardianUids: [guardian.uid] });
    await fundDemoWallet(target(), revoked, 800);

    const attempts: [string, Response][] = [
      ["origem de outra família", await send(guardian, x!, b!, 100)],
      ["destino de outra família", await send(guardian, a!, x!, 100)],
      ["vínculo revogado na origem", await send(guardian, revoked, b!, 100)],
      ["vínculo revogado no destino", await send(guardian, a!, revoked, 100)],
      ["responsável de fora", await send(other, a!, b!, 100)],
      ["administração", await send(admin, a!, b!, 100)],
      ["cantina", await send(cantina, a!, b!, 100)],
      ["secretaria", await send(secretaria, a!, b!, 100)],
      ["aluno com login", await send(studentLogin, a!, b!, 100)],
    ];
    for (const [label, response] of attempts) expect([label, response.status]).toEqual([label, 403]);
    expect((await send(null, a!, b!, 100)).status).toBe(401);
    expect(await balanceOf(a!)).toBe(5000);
    expect(await balanceOf(b!)).toBe(1000);
    expect(await balanceOf(x!)).toBe(900);
    expect(await balanceOf(revoked)).toBe(800);
  });

  it("repetir depois de perder o vínculo é reautorizado com o estado atual: negado, sem vazar o resultado guardado", async () => {
    const [a, b] = await family([5000, 0], [guardian]);
    const key = randomUUID();
    expect((await send(guardian, a!, b!, 500, key)).status).toBe(200);
    await writeDemoDoc(target(), `guardianStudentLinks/${guardian.uid}_${b!}`, { guardianUid: guardian.uid, studentId: b!, status: "revoked" });
    const replay = await send(guardian, a!, b!, 500, key);
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({ error: "forbidden" });
  });

  it("saldo insuficiente, mesma carteira, valores inválidos e aluno inativo são recusados sem nenhum efeito", async () => {
    const [a, b] = await family([1000, 0]);
    const inactive = sid("inativo");
    await seedStudentAccess({ studentId: inactive, name: "Inativo", guardianUids: [guardian.uid], studentStatus: "inactive" });
    await fundDemoWallet(target(), inactive, 500);

    const insufficient = await send(guardian, a!, b!, 1001);
    expect([insufficient.status, await insufficient.json()]).toEqual([409, { error: "insufficient_balance" }]);
    expect((await send(guardian, a!, a!, 100)).status).toBe(400);
    for (const amount of [0, -100, 1.5, 500_001]) expect((await send(guardian, a!, b!, amount)).status).toBe(400);
    expect((await transfer(req("POST", "/api/wallets/transfer", guardian.idToken, { key: "curta", fromStudentId: a, toStudentId: b, amountCents: 1 }))).status).toBe(400);
    const fromInactive = await send(guardian, inactive, b!, 100);
    const toInactive = await send(guardian, a!, inactive, 100);
    expect([fromInactive.status, toInactive.status]).toEqual([409, 409]);

    expect(await balanceOf(a!)).toBe(1000);
    expect(await balanceOf(b!)).toBe(0);
    expect(await entriesOf(a!)).toBe(1);
    expect(await entriesOf(b!)).toBe(0);
    expect(await transfersCount([a!, inactive])).toBe(0);
    // Transferir o saldo inteiro é permitido: o saldo nunca fica negativo.
    expect((await send(guardian, a!, b!, 1000)).status).toBe(200);
    expect(await balanceOf(a!)).toBe(0);
  });
});

describe("A17/A18 — atomicidade e disputa na carteira (Emulator Suite, concorrência real)", () => {
  it("falha no meio da gravação desfaz tudo: sem perna parcial, sem projeção alterada, sem registro de idempotência", async () => {
    const [a, b] = await family([5000, 0]);
    const key = randomUUID();
    const transferId = deterministicId("trf", guardian.uid, key);
    // A segunda perna já existe: o `create` da transação falha no commit, depois de a primeira perna ter sido preparada.
    await adminDb().doc(`wallets/${b!}/entries/${transferId}_in`).create({ marker: "pre-existente" });
    const response = await send(guardian, a!, b!, 1000, key);
    expect(response.status).toBe(500);
    expect(await balanceOf(a!)).toBe(5000);
    expect((await adminDb().doc(`wallets/${b!}`).get()).exists).toBe(false);
    expect((await adminDb().doc(`wallets/${a!}/entries/${transferId}_out`).get()).exists).toBe(false);
    expect((await adminDb().doc(`walletTransfers/${transferId}`).get()).exists).toBe(false);
    expect((await adminDb().doc(`idempotencyRecords/${guardian.uid}__wallet.transfer__${key}`).get()).exists).toBe(false);
    expect((await adminDb().doc(`auditLog/${guardian.uid}__wallet.transfer__${key}`).get()).exists).toBe(false);
  });

  it("saldo 1000, oito transferências de 300 simultâneas (chaves diferentes): exatamente 3 vencem, 5 recebem saldo insuficiente, saldo nunca negativo", async () => {
    const [a, b] = await family([1000, 0]);
    const responses = await Promise.all(Array.from({ length: 8 }, () => send(guardian, a!, b!, 300)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 409, 409, 409, 409, 409]);
    expect(await balanceOf(a!)).toBe(100);
    expect(await balanceOf(b!)).toBe(900);
    expect(await entriesOf(a!)).toBe(4); // fixture + 3 saídas
    expect(await entriesOf(b!)).toBe(3);
    for (const id of [a!, b!]) expect(await reconcileOf(id)).toMatchObject({ ok: true });
  });

  it("A→B e B→A ao mesmo tempo (várias de cada lado): total conservado, seq contíguo e livro reconciliado nas duas carteiras", async () => {
    const [a, b] = await family([4000, 4000]);
    const jobs = [
      ...Array.from({ length: 4 }, (_, i) => send(guardian, a!, b!, 100 + i)),
      ...Array.from({ length: 4 }, (_, i) => send(guardian, b!, a!, 200 + i)),
    ];
    const responses = await Promise.all(jobs);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect((await balanceOf(a!)) + (await balanceOf(b!))).toBe(8000);
    expect(await balanceOf(a!)).toBe(4000 - (100 + 101 + 102 + 103) + (200 + 201 + 202 + 203));
    for (const id of [a!, b!]) expect(await reconcileOf(id)).toMatchObject({ ok: true, entryCount: 9, version: 9 });
  });

  it("A35 — mesma operação enviada 6 vezes ao mesmo tempo (clique duplo/retentativa): um único movimento; as demais recebem o mesmo resultado", async () => {
    const [a, b] = await family([5000, 0]);
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 6 }, () => send(guardian, a!, b!, 700, key)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as { transferId: string; replayed: boolean }[];
    expect(new Set(bodies.map((x) => x.transferId)).size).toBe(1);
    expect(bodies.filter((x) => !x.replayed)).toHaveLength(1);
    expect(await balanceOf(a!)).toBe(4300);
    expect(await balanceOf(b!)).toBe(700);
    expect(await entriesOf(a!)).toBe(2);
    expect(await entriesOf(b!)).toBe(1);
    const audits = await adminDb().collection("auditLog").where("target.id", "==", bodies[0]!.transferId).get();
    expect(audits.size).toBe(1);
    expect(await transfersCount([a!])).toBe(1);
  });
});

describe("leitura autoritativa e reconciliação", () => {
  it("GET /api/wallets: responsável vinculado, aluno com login e administração leem; cantina, secretaria e outra família não", async () => {
    const [a, b] = await family([5000, 0]);
    await seedStudentAccess({ studentId: a!, name: "Com login", guardianUids: [guardian.uid], studentUid: studentLogin.uid });
    await send(guardian, a!, b!, 1250);
    const ok = await read(guardian, a!);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { balanceCents: number; version: number; entries: { seq: number; type: string }[] };
    expect(body).toMatchObject({ balanceCents: 3750, version: 2 });
    expect(body.entries.map((e) => [e.seq, e.type])).toEqual([[2, "transfer_out"], [1, "adjustment"]]);
    expect((await read(studentLogin, a!)).status).toBe(200);
    expect((await read(admin, a!)).status).toBe(200);
    for (const user of [cantina, secretaria, other]) expect((await read(user, a!)).status).toBe(403);
    expect((await read(studentLogin, b!)).status).toBe(403);
    expect((await read(null, a!)).status).toBe(401);
    expect((await walletRead(req("GET", "/api/wallets", guardian.idToken))).status).toBe(400);
    // Aluno sem movimento: saldo 0, versão 0.
    const [fresh] = await family([0]);
    expect(await (await read(guardian, fresh!)).json()).toMatchObject({ balanceCents: 0, version: 0, entries: [] });
  });

  it("reconciliação é só da administração e acusa carteira cuja projeção diverge do livro", async () => {
    const [a, b] = await family([5000, 0]);
    await send(guardian, a!, b!, 1000);
    expect((await reconcile(req("GET", `/api/wallets/reconcile?studentId=${a!}`, guardian.idToken))).status).toBe(403);
    expect((await reconcile(req("GET", `/api/wallets/reconcile?studentId=${a!}`, secretaria.idToken))).status).toBe(403);
    expect(await reconcileOf(a!)).toMatchObject({ ok: true, balanceCents: 4000, ledgerSumCents: 4000 });
    await adminDb().doc(`wallets/${a!}`).update({ balanceCents: 4001 }); // corrupção simulada da projeção
    const broken = await reconcileOf(a!);
    expect(broken.ok).toBe(false);
    expect(broken.problems.join(" ")).toContain("soma do livro");
  });
});

/** Aluno com cadastro completo (campos que o comando de cadastro exige), vinculado ao responsável, saldo por fixture. */
async function realStudent(cents: number, who: TestUser[] = [guardian]): Promise<string> {
  const id = sid("real");
  await seedStudentAccess({ studentId: id, name: `Real ${counter}`, guardianUids: who.map((u) => u.uid) });
  await writeDemoDoc(target(), `students/${id}`, { enrollment: `E-${id}`, classId: "cls_fixture", shiftId: "shf_fixture", nameNormalized: `real ${counter}`, version: 1 }, ["enrollment", "classId", "shiftId", "nameNormalized", "version"]);
  if (cents > 0) await fundDemoWallet(target(), id, cents);
  return id;
}
const setStatus = (studentId: string, status: "active" | "inactive", key: string = randomUUID()) =>
  studentsRoute(req("POST", "/api/students", admin.idToken, { key, action: "update", studentId, status, reason: status === "inactive" ? "Saída da escola" : "Reativado para resolver o saldo" }));
const statusOf = async (id: string) => (await adminDb().doc(`students/${id}`).get()).get("status") as string;

describe("fechamento F08 — arquivar aluno com saldo (servidor, dentro da transação)", () => {
  it("arquivar é recusado com saldo diferente de zero e permitido com saldo zero ou sem carteira; nada é alterado na recusa", async () => {
    const withBalance = await realStudent(500);
    const refused = await setStatus(withBalance, "inactive");
    expect([refused.status, await refused.json()]).toEqual([409, { error: "student_has_balance" }]);
    expect(await statusOf(withBalance)).toBe("active");
    expect((await adminDb().doc(`students/${withBalance}`).get()).get("version")).toBe(1);
    expect(await balanceOf(withBalance)).toBe(500);

    const noWallet = await realStudent(0); // carteira inexistente = saldo 0
    expect((await setStatus(noWallet, "inactive")).status).toBe(200);
    expect(await statusOf(noWallet)).toBe("inactive");

    // Depois de transferir todo o saldo, arquivar é permitido; o saldo recebido bloqueia o destino.
    const dest = await realStudent(0);
    expect((await send(guardian, withBalance, dest, 500)).status).toBe(200);
    expect((await setStatus(dest, "inactive")).status).toBe(409);
    expect((await setStatus(withBalance, "inactive")).status).toBe(200);
    expect(await statusOf(withBalance)).toBe("inactive");
  });

  it("aluno já arquivado com saldo: reativação administrativa auditada devolve o fluxo normal, sem ajuste, sem apagar histórico e sem mexer em vínculos", async () => {
    const stuck = await realStudent(800);
    const dest = await realStudent(0);
    await adminDb().doc(`students/${stuck}`).update({ status: "inactive" }); // estado legado: arquivado com saldo
    const blocked = await send(guardian, stuck, dest, 100);
    expect(blocked.status).toBe(409); // fluxo normal exige alunos ativos nas duas pontas
    const beforeEntries = (await adminDb().collection(`wallets/${stuck}/entries`).get()).docs.map((d) => [d.id, d.data()] as const);
    const linkBefore = (await adminDb().doc(`guardianStudentLinks/${guardian.uid}_${stuck}`).get()).data();

    const key = randomUUID();
    expect((await setStatus(stuck, "active", key)).status).toBe(200);
    const audit = (await adminDb().doc(`auditLog/${admin.uid}__student.update__${key}`).get()).data()!;
    expect(audit).toMatchObject({ action: "student.update", actorUid: admin.uid, before: { status: "inactive" }, after: { status: "active" } });
    expect((await send(guardian, stuck, dest, 800)).status).toBe(200);
    expect(await balanceOf(stuck)).toBe(0);
    expect((await setStatus(stuck, "inactive")).status).toBe(200);

    // Histórico preservado (entradas originais idênticas), vínculo intacto, nenhum movimento de ajuste novo.
    const afterEntries = new Map((await adminDb().collection(`wallets/${stuck}/entries`).get()).docs.map((d) => [d.id, d.data()]));
    for (const [id, data] of beforeEntries) expect(afterEntries.get(id)).toEqual(data);
    expect([...afterEntries.values()].filter((e) => e.type === "adjustment")).toHaveLength(1); // só a fixture inicial
    expect((await adminDb().doc(`guardianStudentLinks/${guardian.uid}_${stuck}`).get()).data()).toEqual(linkBefore);
    expect(await reconcileOf(stuck)).toMatchObject({ ok: true });
  });

  it("disputa arquivar × receber transferência (6 rodadas): nunca fica aluno arquivado com saldo; exatamente um dos dois vence", async () => {
    const source = await realStudent(100_000);
    let archiveFirst = 0;
    let transferFirst = 0;
    for (let round = 0; round < 6; round++) {
      const dest = await realStudent(0);
      const [archive, move] = await Promise.all([setStatus(dest, "inactive"), send(guardian, source, dest, 500)]);
      const status = await statusOf(dest);
      const balance = await balanceOf(dest);
      expect(status === "inactive" && balance !== 0).toBe(false); // invariante
      if (archive.status === 200) {
        expect([move.status, await move.json()]).toEqual([409, { error: "student_inactive" }]);
        expect([status, balance]).toEqual(["inactive", 0]);
        archiveFirst++;
      } else {
        expect([archive.status, await archive.json()]).toEqual([409, { error: "student_has_balance" }]);
        expect(move.status).toBe(200);
        expect([status, balance]).toEqual(["active", 500]);
        transferFirst++;
      }
    }
    expect(archiveFirst + transferFirst).toBe(6);
    console.info(`disputa arquivar × receber: arquivamento venceu ${archiveFirst}, transferência venceu ${transferFirst}`);
    expect(await reconcileOf(source)).toMatchObject({ ok: true });
  });

  it("disputa arquivar × transferir TODO o saldo para fora (6 rodadas): nunca arquiva com saldo; arquivar só vence se a transferência já zerou", async () => {
    const dest = await realStudent(0);
    for (let round = 0; round < 6; round++) {
      const from = await realStudent(300);
      const [archive, move] = await Promise.all([setStatus(from, "inactive"), send(guardian, from, dest, 300)]);
      const balance = await balanceOf(from);
      expect((await statusOf(from)) === "inactive" && balance !== 0).toBe(false);
      expect(move.status).toBe(200); // a saída nunca perde: o arquivamento com saldo é que é recusado
      if (archive.status === 200) expect(balance).toBe(0);
      else expect(await archive.json()).toEqual({ error: "student_has_balance" });
    }
    expect(await reconcileOf(dest)).toMatchObject({ ok: true });
  });
});

describe("fechamento F08 — livro imutável", () => {
  it("movimentos antigos permanecem idênticos depois de novos movimentos, e a projeção continua igual à soma do livro", async () => {
    const [a, b] = await family([5000, 0]);
    expect((await send(guardian, a!, b!, 1000)).status).toBe(200);
    const snapshot = async () => new Map((await adminDb().collection(`wallets/${a!}/entries`).get()).docs.map((d) => [d.id, d.data()]));
    const before = await snapshot();
    expect((await send(guardian, a!, b!, 700)).status).toBe(200);
    expect((await send(guardian, b!, a!, 200)).status).toBe(200);
    const after = await snapshot();
    expect(after.size).toBe(before.size + 2);
    for (const [id, data] of before) expect(after.get(id)).toEqual(data);
    expect(await reconcileOf(a!)).toMatchObject({ ok: true, entryCount: 4, version: 4 });
  });
});
