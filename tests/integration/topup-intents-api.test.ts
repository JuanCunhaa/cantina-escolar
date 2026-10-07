// Recarga online (F18) contra Auth/Firestore Emulator, com PROVEDOR ROTEIRIZADO injetado (contrato da fronteira; não prova
// nenhum provedor real). Prova: intenção local com autorização atual e centavos; UMA chamada externa por intenção (replay,
// clique duplo ×6); timeout → conciliação por consulta SEM nova cobrança automática (A06 parcial: criação); reenvio só
// explícito com a MESMA chave; desfecho tardio não regride; recusa/resposta incoerente; sem provedor = indisponível (503,
// nada gravado); token do cartão nunca persistido; NENHUM estado credita a carteira (crédito é da F19).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setDemoProfile } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, seedStudentAccess, targetFromEnv, writeDemoDoc, type TestUser } from "../helpers/auth-emulator";
import type { CardProvider, ChargeRequest, PixProvider, ProviderCharge } from "@/modules/payments/online/provider";

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Json = Record<string, unknown> & { error?: string };

let intentsRoute: { GET: Handler; POST: Handler };
let intentRoute: Handler;
let reconcileRoute: Handler;
let configRoute: Handler;
let commands: typeof import("@/modules/payments/online/intent-commands");
let ProviderError: typeof import("@/modules/payments/online/provider").ProviderError;
let IdempotencyConflictError: typeof import("@/lib/firebase/command").IdempotencyConflictError;
let adminDb: typeof import("@/lib/firebase/admin").adminDb;
let MAX_BALANCE_CENTS: number;

let admin: TestUser;
let secretaria: TestUser;
let cantina: TestUser;
let guardianA: TestUser;
let guardianB: TestUser;
let studentUser: TestUser;

const tag = randomUUID().slice(0, 6);
let seq = 0;

beforeAll(async () => {
  process.env.APP_ENV = "emulator";
  process.env.FIREBASE_PROJECT_ID = "demo-cantina";
  delete process.env.PAYMENTS_PIX_PROVIDER;
  delete process.env.PAYMENTS_CARD_PROVIDER;
  intentsRoute = (await import("@/app/api/topups/online/route")) as unknown as { GET: Handler; POST: Handler };
  intentRoute = (await import("@/app/api/topups/online/[id]/route")).GET as unknown as Handler;
  reconcileRoute = (await import("@/app/api/topups/online/[id]/reconcile/route")).POST as unknown as Handler;
  configRoute = (await import("@/app/api/topups/online/config/route")).GET as unknown as Handler;
  commands = await import("@/modules/payments/online/intent-commands");
  ({ ProviderError } = await import("@/modules/payments/online/provider"));
  ({ IdempotencyConflictError } = await import("@/lib/firebase/command"));
  ({ adminDb } = await import("@/lib/firebase/admin"));
  ({ MAX_BALANCE_CENTS } = await import("@/modules/wallet/model"));
  [admin, secretaria, cantina, guardianA, guardianB, studentUser] = await Promise.all([
    createTestUser("oadm", "admin"),
    createTestUser("osec", "secretaria"),
    createTestUser("ocant", "cantina"),
    createTestUser("oresp-a", "guardian", { displayName: "Responsável A" }),
    createTestUser("oresp-b", "guardian"),
    createTestUser("oaluno", "student"),
  ]);
});

/* ------------------------------------------------------------------------------------------------- apoio */

const db = () => adminDb();
const actor = (u: TestUser, role: "guardian" | "admin" | "student" | "cantina" | "secretaria" = "guardian") => ({ uid: u.uid, role });
const noCtx = { params: Promise.resolve({ id: "" }) };

async function call(handler: Handler, user: TestUser | null, method: string, url: string, body?: unknown, id = "") {
  const response = await handler(
    new Request(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${user.idToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    id ? { params: Promise.resolve({ id }) } : noCtx,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

async function newStudent(over: { status?: "active" | "inactive"; revoked?: boolean; studentUid?: string } = {}) {
  const id = `tso_${tag}_${++seq}`;
  await seedStudentAccess({
    studentId: id,
    name: `Aluno Online ${seq}`,
    guardianUids: over.revoked ? [] : [guardianA.uid],
    revokedGuardianUids: over.revoked ? [guardianA.uid] : [],
    studentStatus: over.status ?? "active",
    studentUid: over.studentUid,
  });
  return id;
}

/** Provedor roteirizado: registra chamadas e chaves; `script` decide o desfecho de cada criação. */
type Script = (req: ChargeRequest, n: number) => Promise<ProviderCharge> | ProviderCharge;
function scripted(script?: Script) {
  const charges = new Map<string, ProviderCharge>();
  const calls = { create: 0, find: 0, keys: [] as string[], refs: [] as string[], amounts: [] as number[] };
  const pixCharge = (req: ChargeRequest & { expiresAt?: Date }): ProviderCharge => ({
    chargeId: `ch_${req.intentId}`,
    providerStatus: "pending",
    outcome: "awaiting_payment",
    pix: { copyPaste: `00020126PIX${req.intentId}`, qrImagePngBase64: "iVBORw0KGgo=", expiresAt: (req.expiresAt ?? new Date(Date.now() + 1_800_000)).toISOString() },
  });
  const create = async (req: ChargeRequest & { expiresAt?: Date }) => {
    calls.create += 1;
    calls.keys.push(req.idempotencyKey);
    calls.refs.push(req.externalReference);
    calls.amounts.push(req.amountCents);
    const existing = charges.get(req.externalReference);
    if (existing) return existing;
    const charge = script ? await script(req, calls.create) : pixCharge(req);
    charges.set(req.externalReference, charge);
    return charge;
  };
  const pix: PixProvider = {
    id: "fake",
    mode: "live",
    idempotencyWindowMs: 3_600_000,
    createPixCharge: (req) => create(req),
    findCharge: async (ref) => {
      calls.find += 1;
      return charges.get(ref) ?? null;
    },
  };
  const card: CardProvider = {
    id: "fake",
    mode: "live",
    publicConfig: {},
    createCardCharge: (req) => create(req),
    findCharge: pix.findCharge,
  };
  return { pix, card, calls, charges, pixCharge };
}

const pixBody = (studentId: string, over: Record<string, unknown> = {}) => ({ key: randomUUID(), studentId, amountCents: 5000, channel: "pix", ...over });
const cardBody = (studentId: string, over: Record<string, unknown> = {}) => ({ key: randomUUID(), studentId, amountCents: 5000, channel: "card", installments: 1, cardToken: `tok_secret_${randomUUID().slice(0, 8)}`, paymentMethodId: "visa", payer: { email: "pagador@example.test", identification: { type: "CPF", number: "12345678909" } }, ...over });

async function walletUntouched(studentId: string) {
  const w = await db().doc(`wallets/${studentId}`).get();
  expect(w.exists ? (w.get("balanceCents") as number) : 0).toBe(0);
  expect((await db().collection(`wallets/${studentId}/entries`).get()).size).toBe(0);
}
const intentDoc = async (id: string) => (await db().doc(`topupIntents/${id}`).get()).data()!;

/* ---------------------------------------------------------------------------------------- criação e idempotência */

describe("criação da cobrança: intenção local, UMA chamada externa, nada creditado", () => {
  it("Pix: intenção com aluno/valor/moeda/provedor; chave de idempotência = referência = ID local; QR, copia e cola e validade; carteira intacta", async () => {
    const student = await newStudent();
    const p = scripted();
    const before = Date.now();
    const v = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), { providers: { pix: p.pix, card: null } });
    expect(v).toMatchObject({ replayed: false, status: "awaiting_payment", displayStatus: "awaiting_payment", channel: "pix", amountCents: 5000, currency: "BRL", studentId: student, credited: false, failure: null });
    expect(v.intentId).toMatch(/^tpi_[a-f0-9]{20}$/);
    expect(v.pix?.copyPaste).toContain(v.intentId);
    expect(v.pix?.qrImagePngBase64).toBeTruthy();
    const ttl = Date.parse(v.pix!.expiresAt) - before;
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(31 * 60_000);
    expect(p.calls).toMatchObject({ create: 1, keys: [v.intentId], refs: [v.intentId], amounts: [5000] });
    const d = await intentDoc(v.intentId);
    expect(d).toMatchObject({ studentId: student, amountCents: 5000, currency: "BRL", provider: { id: "fake", mode: "live" }, externalReference: v.intentId, status: "awaiting_payment", charge: { id: `ch_${v.intentId}` } });
    const audits = await db().collection("auditLog").where("target.id", "==", v.intentId).get();
    expect(audits.docs.map((a) => a.get("action")).sort()).toEqual(["topup.online.intent", "topup.online.outcome"]);
    await walletUntouched(student);
    expect(JSON.stringify(v)).not.toMatch(/example\.test|payer|createdBy|externalReference/);
  });

  it("replay devolve a MESMA intenção sem nova chamada; mesma chave com outro valor = conflito; clique duplo ×6 = 1 chamada", async () => {
    const student = await newStudent();
    const p = scripted();
    const deps = { providers: { pix: p.pix, card: null } };
    const body = pixBody(student);
    const first = await commands.createTopupIntent(db(), actor(guardianA), body, deps);
    const again = await commands.createTopupIntent(db(), actor(guardianA), body, deps);
    expect(again).toMatchObject({ intentId: first.intentId, replayed: true, status: "awaiting_payment" });
    await expect(commands.createTopupIntent(db(), actor(guardianA), { ...body, amountCents: 5100 }, deps)).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(p.calls.create).toBe(1);

    const burst = pixBody(student, { amountCents: 2000 });
    const results = await Promise.all(Array.from({ length: 6 }, () => commands.createTopupIntent(db(), actor(guardianA), burst, deps)));
    expect(new Set(results.map((r) => r.intentId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(p.calls.create).toBe(2); // 1 da primeira intenção + 1 da rajada
    expect((await db().collection("topupIntents").where("studentId", "==", student).get()).size).toBe(2);
    await walletUntouched(student);
  });

  it("recusa definitiva → falhou; cartão recusado → falhou; resposta incoerente → verificando (nunca sucesso); nada creditado", async () => {
    const student = await newStudent();
    const rejecting = scripted(() => {
      throw new ProviderError("rejected", "invalid_payer");
    });
    const r = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), { providers: { pix: rejecting.pix, card: null } });
    expect(r).toMatchObject({ status: "failed", failure: { code: "invalid_payer" } });
    expect(r.failure!.message).toMatch(/Nenhum crédito/);

    const declining = scripted((req) => ({ chargeId: `ch_${req.intentId}`, providerStatus: "rejected", outcome: "declined", pix: null, declineCode: "card_declined" }));
    const c = await commands.createTopupIntent(db(), actor(guardianA), cardBody(student), { providers: { pix: null, card: declining.card } });
    expect(c).toMatchObject({ status: "failed", channel: "card", failure: { code: "card_declined" } });

    const garbage = scripted((req) => ({ chargeId: `ch_${req.intentId}`, providerStatus: "pending", outcome: "awaiting_payment", pix: null }));
    const g = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), { providers: { pix: garbage.pix, card: null } });
    expect(g).toMatchObject({ status: "creation_uncertain", needsReconcile: true, pix: null });
    await walletUntouched(student);
  });

  it("cartão 1x: aprovado no provedor fica 'em análise' (não é recebimento confirmado) e o token NUNCA é persistido", async () => {
    const student = await newStudent();
    const p = scripted((req) => ({ chargeId: `ch_${req.intentId}`, providerStatus: "approved", outcome: "processing", pix: null }));
    const body = cardBody(student);
    const v = await commands.createTopupIntent(db(), actor(guardianA), body, { providers: { pix: null, card: p.card } });
    expect(v).toMatchObject({ status: "processing", statusLabel: "Pagamento em análise", credited: false, pix: null });
    const stored = [
      await intentDoc(v.intentId),
      (await db().doc(`idempotencyRecords/${guardianA.uid}__topup.online__${body.key}`).get()).data(),
      ...(await db().collection("auditLog").where("target.id", "==", v.intentId).get()).docs.map((d) => d.data()),
    ];
    expect(JSON.stringify(stored)).not.toContain(body.cardToken);
    expect(JSON.stringify(v)).not.toContain(body.cardToken);
    // Token NOVO com a mesma chave (resposta perdida, cartão re-tokenizado) é a mesma operação: replay, sem cobrar de novo.
    const again = await commands.createTopupIntent(db(), actor(guardianA), { ...body, cardToken: "tok_other_0000001" }, { providers: { pix: null, card: p.card } });
    expect(again).toMatchObject({ intentId: v.intentId, replayed: true });
    expect(p.calls.create).toBe(1);
    await walletUntouched(student);
  });

  it("parcelas ≠ 1 e dados de cartão em claro são recusados ANTES de qualquer gravação ou chamada", async () => {
    const student = await newStudent();
    const p = scripted();
    for (const body of [cardBody(student, { installments: 2 }), cardBody(student, { cardNumber: "4111111111111111" }), cardBody(student, { cvv: "123" })]) {
      const r = await call(intentsRoute.POST, guardianA, "POST", "/api/topups/online", body);
      expect(r.status).toBe(400);
    }
    await expect(commands.createTopupIntent(db(), actor(guardianA), cardBody(student, { installments: 3 }), { providers: { pix: null, card: p.card } })).rejects.toThrow();
    expect(p.calls.create).toBe(0);
    expect((await db().collection("topupIntents").where("studentId", "==", student).get()).size).toBe(0);
  });
});

/* ------------------------------------------------------------------------------- indisponível (produção sem provedor) */

describe("integração ausente: canal indisponível, nada gravado nem cobrado", () => {
  it("sem provedor configurado a API responde 503 `payment_unavailable` e a configuração mostra os dois canais indisponíveis", async () => {
    const student = await newStudent();
    const cfg = await call(configRoute, guardianA, "GET", "/api/topups/online/config");
    expect(cfg.body).toMatchObject({ pix: { available: false }, card: { available: false, installments: 1 } });
    const r = await call(intentsRoute.POST, guardianA, "POST", "/api/topups/online", pixBody(student));
    expect(r).toMatchObject({ status: 503, body: { error: "payment_unavailable" } });
    expect((await db().collection("topupIntents").where("studentId", "==", student).get()).size).toBe(0);
    expect((await call(intentsRoute.POST, null, "POST", "/api/topups/online", pixBody(student))).status).toBe(401);
    await walletUntouched(student);
  });
});

/* ------------------------------------------------------------------------- A06 (criação): timeout e conciliação */

describe("A06 (parcial) — timeout da criação é conciliado antes de qualquer nova cobrança", () => {
  it("timeout DEPOIS de criar: fica 'verificando'; a conciliação consulta, encontra a cobrança e não cria outra", async () => {
    const student = await newStudent();
    const p = scripted();
    p.pix.createPixCharge = async (req) => {
      p.calls.create += 1;
      p.charges.set(req.externalReference, p.pixCharge(req));
      throw new ProviderError("uncertain", "timeout");
    };
    const deps = { providers: { pix: p.pix, card: null } };
    const v = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), deps);
    expect(v).toMatchObject({ status: "creation_uncertain", statusLabel: "Verificando a cobrança", needsReconcile: true, pix: null });
    const r = await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, {}, deps);
    expect(r).toMatchObject({ reconcile: "found", status: "awaiting_payment", needsReconcile: false });
    expect(r.pix?.copyPaste).toContain(v.intentId);
    expect(p.calls).toMatchObject({ create: 1, find: 1 });
    // Outra conciliação depois de resolvida não consulta nem cria nada.
    expect(await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, {}, deps)).toMatchObject({ reconcile: "not_needed" });
    expect(p.calls).toMatchObject({ create: 1, find: 1 });
    await walletUntouched(student);
  });

  it("timeout ANTES de criar: a consulta não encontra e NADA é recriado sozinho; só o reenvio explícito, com a MESMA chave, cria", async () => {
    const student = await newStudent();
    const p = scripted((req, n) => {
      if (n === 1) throw new ProviderError("uncertain", "network");
      return p.pixCharge(req);
    });
    const deps = { providers: { pix: p.pix, card: null } };
    const v = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), deps);
    expect(v.status).toBe("creation_uncertain");
    for (let i = 0; i < 3; i += 1) expect(await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, {}, deps)).toMatchObject({ reconcile: "not_found", status: "creation_uncertain" });
    expect(p.calls.create).toBe(1);
    const resent = await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, { resend: true }, deps);
    expect(resent).toMatchObject({ reconcile: "resent", status: "awaiting_payment" });
    expect(p.calls.keys).toEqual([v.intentId, v.intentId]);
    expect(p.calls.refs).toEqual([v.intentId, v.intentId]);
    await walletUntouched(student);
  });

  it("cartão incerto não é reenviado (token de uso único, não guardado); depois do limite a intenção encerra como não criada", async () => {
    const student = await newStudent();
    const p = scripted(() => {
      throw new ProviderError("uncertain", "gateway_timeout");
    });
    let now = new Date();
    const deps = { providers: { pix: null, card: p.card }, clock: () => now };
    const v = await commands.createTopupIntent(db(), actor(guardianA), cardBody(student), deps);
    expect(v.status).toBe("creation_uncertain");
    expect(await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, { resend: true }, deps)).toMatchObject({ reconcile: "not_found" });
    expect(p.calls.create).toBe(1);
    now = new Date(now.getTime() + 31 * 60_000);
    const done = await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, {}, deps);
    expect(done).toMatchObject({ reconcile: "given_up", status: "failed", failure: { code: "not_created" } });
    expect(done.failure!.message).toMatch(/será conciliado/);
    expect(p.calls.create).toBe(1);
    await walletUntouched(student);
  });

  it("falha na CONSULTA não muda nada (segue verificando) e não cria cobrança", async () => {
    const student = await newStudent();
    const p = scripted(() => {
      throw new ProviderError("uncertain", "timeout");
    });
    p.pix.findCharge = async () => {
      throw new Error("provider down");
    };
    const deps = { providers: { pix: p.pix, card: null } };
    const v = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), deps);
    expect(await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, { resend: true }, deps)).toMatchObject({ reconcile: "lookup_failed", status: "creation_uncertain" });
    expect(p.calls.create).toBe(1);
  });

  it("resposta original atrasada não regride o estado decidido pela conciliação (processo parado em 'gerando')", async () => {
    const student = await newStudent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const p = scripted();
    p.pix.createPixCharge = async (req) => {
      p.calls.create += 1;
      p.charges.set(req.externalReference, p.pixCharge(req));
      await gate; // resposta "presa" na rede
      throw new ProviderError("uncertain", "late_timeout");
    };
    let now = new Date();
    const deps = { providers: { pix: p.pix, card: null }, clock: () => now };
    const pending = commands.createTopupIntent(db(), actor(guardianA), pixBody(student), deps);
    let intentId = "";
    for (let i = 0; i < 50 && !intentId; i += 1) {
      const s = await db().collection("topupIntents").where("studentId", "==", student).get();
      intentId = s.docs[0]?.id ?? "";
      if (!intentId) await new Promise((r) => setTimeout(r, 100));
    }
    expect((await intentDoc(intentId)).status).toBe("creating");
    expect(await commands.reconcileTopupIntent(db(), actor(guardianA), intentId, {}, deps)).toMatchObject({ reconcile: "not_needed", status: "creating" });
    now = new Date(now.getTime() + 61_000); // 'gerando' parado
    expect(await commands.reconcileTopupIntent(db(), actor(guardianA), intentId, {}, deps)).toMatchObject({ reconcile: "found", status: "awaiting_payment" });
    release();
    expect(await pending).toMatchObject({ intentId, status: "awaiting_payment" });
    expect((await intentDoc(intentId)).status).toBe("awaiting_payment");
    expect(p.calls.create).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------- autorização e limites */

describe("autorização atual e limites", () => {
  it("só o responsável vinculado ativo inicia; outra família, vínculo revogado, aluno, equipe e conta desativada são negados (403)", async () => {
    const student = await newStudent();
    const revoked = await newStudent({ revoked: true });
    const p = scripted();
    const deps = { providers: { pix: p.pix, card: null } };
    await expect(commands.createTopupIntent(db(), actor(guardianB), pixBody(student), deps)).rejects.toThrow(/Sem acesso/);
    await expect(commands.createTopupIntent(db(), actor(guardianA), pixBody(revoked), deps)).rejects.toThrow(/Sem acesso/);
    for (const [u, role] of [[studentUser, "student"], [secretaria, "secretaria"], [cantina, "cantina"], [admin, "admin"]] as const) {
      await expect(commands.createTopupIntent(db(), actor(u, role), pixBody(student), deps)).rejects.toThrow(/permissão/);
    }
    const disabled = await createTestUser("oresp-off", "guardian");
    await seedStudentAccess({ studentId: student, name: "Aluno Online", guardianUids: [guardianA.uid, disabled.uid] });
    await setDemoProfile(targetFromEnv(), disabled.uid, disabled.email, { role: "guardian", status: "disabled" });
    await expect(commands.createTopupIntent(db(), actor(disabled), pixBody(student), deps)).rejects.toThrow(/permissão/);
    expect(p.calls.create).toBe(0);
    expect((await db().collection("topupIntents").where("studentId", "in", [student, revoked]).get()).size).toBe(0);
  });

  it("aluno inativo: 409 para o responsável vinculado; vínculo revogado depois bloqueia replay, leitura e conciliação", async () => {
    const inactive = await newStudent({ status: "inactive" });
    const p = scripted();
    const deps = { providers: { pix: p.pix, card: null } };
    await expect(commands.createTopupIntent(db(), actor(guardianA), pixBody(inactive), deps)).rejects.toMatchObject({ code: "student_inactive" });

    const student = await newStudent();
    const body = pixBody(student);
    const v = await commands.createTopupIntent(db(), actor(guardianA), body, deps);
    expect((await call(intentRoute, guardianA, "GET", `/api/topups/online/${v.intentId}`, undefined, v.intentId)).status).toBe(200);
    expect((await call(intentRoute, guardianB, "GET", `/api/topups/online/${v.intentId}`, undefined, v.intentId)).status).toBe(403);
    expect((await call(intentRoute, admin, "GET", `/api/topups/online/${v.intentId}`, undefined, v.intentId)).status).toBe(200);
    expect((await call(intentsRoute.GET, guardianB, "GET", `/api/topups/online?studentId=${student}`)).status).toBe(403);
    expect((await call(reconcileRoute, guardianB, "POST", `/api/topups/online/${v.intentId}/reconcile`, {}, v.intentId)).status).toBe(403);
    await writeDemoDoc(targetFromEnv(), `guardianStudentLinks/${guardianA.uid}_${student}`, { guardianUid: guardianA.uid, studentId: student, status: "revoked" });
    await expect(commands.createTopupIntent(db(), actor(guardianA), body, deps)).rejects.toThrow(/Sem acesso/);
    expect((await call(intentRoute, guardianA, "GET", `/api/topups/online/${v.intentId}`, undefined, v.intentId)).status).toBe(403);
    expect((await call(reconcileRoute, guardianA, "POST", `/api/topups/online/${v.intentId}/reconcile`, {}, v.intentId)).status).toBe(403);
    expect(p.calls.create).toBe(1);
  });

  it("no máximo 3 recargas abertas por aluno; Pix vencido deixa de contar; teto de saldo da carteira respeitado", async () => {
    const student = await newStudent();
    const p = scripted();
    let now = new Date();
    const deps = { providers: { pix: p.pix, card: null }, clock: () => now };
    for (let i = 0; i < 3; i += 1) await commands.createTopupIntent(db(), actor(guardianA), pixBody(student, { amountCents: 1000 + i }), deps);
    await expect(commands.createTopupIntent(db(), actor(guardianA), pixBody(student), deps)).rejects.toMatchObject({ code: "too_many_open_intents" });
    now = new Date(now.getTime() + 31 * 60_000);
    const later = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), deps);
    expect(later.status).toBe("awaiting_payment");
    const list = await call(intentsRoute.GET, guardianA, "GET", `/api/topups/online?studentId=${student}`);
    const listed = list.body.intents as { intentId: string; amountCents: number }[];
    expect(listed).toHaveLength(4);
    expect(listed[0]!.intentId).toBe(later.intentId); // mais recente primeiro

    const rich = await newStudent();
    await writeDemoDoc(targetFromEnv(), `wallets/${rich}`, { balanceCents: MAX_BALANCE_CENTS - 100, version: 1 });
    await expect(commands.createTopupIntent(db(), actor(guardianA), pixBody(rich, { amountCents: 200 }), deps)).rejects.toMatchObject({ code: "balance_limit" });
  });
});

/* ------------------------------------------- adapter Mercado Pago com HTTP SIMULADO (não é sandbox) no fluxo real */

describe("adapter Mercado Pago no fluxo da intenção (HTTP simulado no formato da API Orders; não é sandbox)", () => {
  /** "Mercado Pago" em memória: guarda orders por external_reference, responde 409 a chave repetida e busca por referência. */
  function fakeMercadoPago(plan: { failFirstCreate?: "timeout_after_create" | "500_before_create" }) {
    const orders = new Map<string, Record<string, unknown>>();
    const keys = new Set<string>();
    const log: string[] = [];
    let creates = 0;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const fetchFn = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (init.method === "POST" && u.pathname === "/v1/orders") {
        creates += 1;
        const key = (init.headers as Record<string, string>)["x-idempotency-key"]!;
        log.push(`POST ${key}`);
        if (keys.has(key)) return json(409, { errors: [{ code: "idempotency_key_already_used" }] });
        const body = JSON.parse(String(init.body)) as { external_reference: string };
        if (creates === 1 && plan.failFirstCreate === "500_before_create") return json(500, { errors: [{ code: "internal_error" }] });
        keys.add(key);
        const order = { id: `ORD${orders.size + 1}`, status: "action_required", status_detail: "waiting_transfer", external_reference: body.external_reference, transactions: { payments: [{ id: "PAY1", date_of_expiration: new Date(Date.now() + 1_800_000).toISOString(), payment_method: { id: "pix", type: "bank_transfer", qr_code: `00020126MP${body.external_reference}`, qr_code_base64: "iVBORw0KGgo=" } }] } };
        orders.set(body.external_reference, order);
        if (creates === 1 && plan.failFirstCreate === "timeout_after_create") throw new Error("timeout");
        return json(201, order);
      }
      if (init.method === "GET" && u.pathname === "/v1/orders") {
        log.push("SEARCH");
        if (!u.searchParams.get("begin_date") || !u.searchParams.get("end_date")) return json(400, { errors: [{ code: "required_search_params" }] });
        const order = orders.get(u.searchParams.get("external_reference") ?? "");
        return json(200, { data: order ? [{ id: order.id, external_reference: order.external_reference }] : [], paging: { total: order ? "1" : "0" } });
      }
      if (init.method === "GET" && u.pathname.startsWith("/v1/orders/")) {
        const order = [...orders.values()].find((o) => o.id === u.pathname.split("/").pop());
        return order ? json(200, order) : json(404, { errors: [{ code: "not_found" }] });
      }
      return json(404, {});
    }) as unknown as typeof fetch;
    return { fetchFn, orders, log };
  }
  const mpConfig = (fetchFn: typeof fetch) => ({ accessToken: ["APP", "USR", "simulado", "0".repeat(24)].join("-"), publicKey: "", env: "sandbox" as const, fetch: fetchFn });

  it("resposta perdida depois de criar: 'verificando' → busca acha a order → QR do provedor; nenhuma segunda order", async () => {
    const { mercadoPagoPix } = await import("@/modules/payments/online/mercadopago");
    const student = await newStudent();
    const mp = fakeMercadoPago({ failFirstCreate: "timeout_after_create" });
    const deps = { providers: { pix: mercadoPagoPix(mpConfig(mp.fetchFn)), card: null } };
    const v = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), deps);
    expect(v.status).toBe("creation_uncertain");
    const r = await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, {}, deps);
    expect(r).toMatchObject({ reconcile: "found", status: "awaiting_payment" });
    expect(r.pix?.copyPaste).toBe(`00020126MP${v.intentId}`);
    expect(mp.orders.size).toBe(1);
    expect(mp.log).toEqual([`POST ${v.intentId}`, "SEARCH"]);
    await walletUntouched(student);
  });

  it("5xx antes de criar: busca não acha; reenvio explícito com a MESMA chave cria UMA order; novo reenvio recebe 409 e a busca mantém 1", async () => {
    const { mercadoPagoPix } = await import("@/modules/payments/online/mercadopago");
    const student = await newStudent();
    const mp = fakeMercadoPago({ failFirstCreate: "500_before_create" });
    const deps = { providers: { pix: mercadoPagoPix(mpConfig(mp.fetchFn)), card: null } };
    const v = await commands.createTopupIntent(db(), actor(guardianA), pixBody(student), deps);
    expect(v.status).toBe("creation_uncertain");
    expect(await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, {}, deps)).toMatchObject({ reconcile: "not_found" });
    expect(mp.orders.size).toBe(0);
    expect(await commands.reconcileTopupIntent(db(), actor(guardianA), v.intentId, { resend: true }, deps)).toMatchObject({ reconcile: "resent", status: "awaiting_payment" });
    expect(mp.orders.size).toBe(1);
    expect(mp.log.filter((l) => l.startsWith("POST"))).toEqual([`POST ${v.intentId}`, `POST ${v.intentId}`]);
    await walletUntouched(student);
  });
});
