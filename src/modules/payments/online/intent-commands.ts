import { Timestamp, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore";
import { conflict, notFound, unavailable } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorizeStudent, decideStudentAction, studentAccessRefs } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { auditInTransaction } from "@/modules/audit/log";
import { MAX_BALANCE_CENTS, parseWalletState } from "@/modules/wallet/model";
import {
  checkCharge,
  createIntentSchema,
  decideReconcile,
  displayStatusOf,
  idempotentPayload,
  isOpen,
  MAX_OPEN_INTENTS,
  needsReconcile,
  OPEN_STATUSES,
  PIX_TTL_MS,
  reconcileSchema,
  STATUS_LABEL,
  type Channel,
  type DisplayStatus,
  type IntentStatus,
} from "./intent-model";
import { ProviderError, type ChargeRequest, type OnlineProviders, type PixData, type ProviderCharge } from "./provider";

/**
 * Recarga online (F18): intenção local + criação externa idempotente + conciliação depois de timeout. Fluxo:
 *   1. transação: perfil ATUAL, vínculo ativo com aluno ativo, teto de intenções abertas e de saldo; grava `topupIntents/{id}`
 *      (`creating`) e auditoria — NENHUMA chamada externa aqui (o callback pode ser repetido pelo Firestore);
 *   2. fora da transação: UMA chamada ao provedor com chave de idempotência = ID da intenção (replay/clique duplo não chamam);
 *   3. transação de desfecho: só sai de `creating`/`creation_uncertain` (desfecho tardio não regride um estado já decidido).
 * Timeout/erro incerto → `creation_uncertain`; a conciliação CONSULTA o provedor pela referência e nunca cria outra cobrança
 * sozinha (reenvio só a pedido da família, Pix, mesma chave, dentro da janela de deduplicação do provedor).
 * Nada aqui credita carteira: confirmação confiável e crédito são da F19.
 */

export type IntentDeps = { providers: OnlineProviders; clock?: () => Date };

type IntentDoc = {
  intentId: string;
  channel: Channel;
  status: IntentStatus;
  studentId: string;
  studentName: string;
  amountCents: number;
  currency: "BRL";
  provider: { id: string; mode: "demo" | "live" };
  payer: { name: string; email: string };
  charge: { id: string; providerStatus: string } | null;
  pix: PixData | null;
  failure: { code: string } | null;
  creation: { attempts: number; lastOutcome: string | null; lastCheckedAt: Timestamp | null };
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type IntentView = {
  intentId: string;
  channel: Channel;
  status: IntentStatus;
  displayStatus: DisplayStatus;
  statusLabel: string;
  studentId: string;
  studentName: string;
  amountCents: number;
  currency: "BRL";
  providerMode: "demo" | "live";
  createdAt: string;
  pix: PixData | null;
  failure: { code: string; message: string } | null;
  needsReconcile: boolean;
  /** Sempre falso aqui: só a confirmação da F19 credita. Exposto para a tela não sugerir saldo novo. */
  credited: false;
};

const FAILURE_MESSAGE: Record<string, string> = {
  card_declined: "Pagamento recusado pelo cartão ou pelo provedor. Nenhum crédito foi lançado.",
  not_created: "Não encontramos esta cobrança no provedor. Se você chegou a pagar, o valor será conciliado; se não, inicie outra recarga.",
};
const failureMessage = (code: string) => FAILURE_MESSAGE[code] ?? "O provedor não gerou a cobrança. Nenhum crédito foi lançado; você pode tentar outra recarga.";

const intentRef = (db: Firestore, id: string) => db.doc(`topupIntents/${id}`);
const ms = (t: Timestamp | undefined | null) => (t ? t.toMillis() : 0);

export function intentView(data: IntentDoc, now: Date): IntentView {
  const displayStatus = displayStatusOf(data.status, data.pix, now);
  return {
    intentId: data.intentId,
    channel: data.channel,
    status: data.status,
    displayStatus,
    statusLabel: STATUS_LABEL[displayStatus],
    studentId: data.studentId,
    studentName: data.studentName,
    amountCents: data.amountCents,
    currency: data.currency,
    providerMode: data.provider.mode,
    createdAt: data.createdAt.toDate().toISOString(),
    pix: data.status === "awaiting_payment" ? data.pix : null,
    failure: data.failure ? { code: data.failure.code, message: failureMessage(data.failure.code) } : null,
    needsReconcile: needsReconcile(data.status, ms(data.updatedAt), now),
    credited: false,
  };
}

/* ------------------------------------------------------------------------------------------------ criação */

/** Cria a intenção e chama o provedor uma única vez. `topup.online` (responsável vinculado ativo); idempotente por `key`. */
export async function createTopupIntent(db: Firestore, actor: Actor, raw: unknown, deps: IntentDeps): Promise<IntentView & { replayed: boolean }> {
  const clock = deps.clock ?? (() => new Date());
  const input = createIntentSchema.parse(raw);
  const provider = input.channel === "pix" ? deps.providers.pix : deps.providers.card;
  if (!provider) throw unavailable("payment_unavailable", "Pagamento online indisponível para este meio.");
  const intentId = deterministicId("tpi", actor.uid, input.key);
  const created: { payer: ChargeRequest["payer"] | null } = { payer: null };

  const result = await runIdempotentCommand(
    db,
    actor,
    {
      scope: "topup.online",
      key: input.key,
      payload: idempotentPayload(input),
      allow: (p) => p.role === "guardian",
      // Repetição devolve a MESMA intenção só a quem ainda tem vínculo ativo; nunca chama o provedor de novo.
      revalidateReplay: async ({ tx, actor: current }) => {
        const [student, link, policy] = await tx.getAll(...studentAccessRefs(db, current, input.studentId));
        if (!decideStudentAction({ actor: current, studentId: input.studentId, action: "wallet.transfer", student: student?.data(), link: link?.data(), policy: policy?.data() })) {
          throw new ForbiddenError("Sem acesso ao aluno (topup.online).");
        }
      },
    },
    async ({ tx, actor: current, profile, auditId }) => {
      const now = clock();
      const [student, link, policy, wallet] = await tx.getAll(...studentAccessRefs(db, current, input.studentId), db.doc(`wallets/${input.studentId}`));
      const access = { actor: current, studentId: input.studentId, student: student?.data(), link: link?.data(), policy: policy?.data() };
      if (!decideStudentAction({ ...access, action: "topup.online" })) {
        if (decideStudentAction({ ...access, action: "wallet.transfer" })) throw conflict("student_inactive", "Aluno inativo.");
        throw new ForbiddenError("Sem acesso ao aluno (topup.online).");
      }
      const open = await tx.get(db.collection("topupIntents").where("studentId", "==", input.studentId).where("status", "in", [...OPEN_STATUSES]));
      const openCount = open.docs.filter((d) => isOpen(d.get("status") as IntentStatus, (d.get("pix") as PixData | null) ?? null, now)).length;
      if (openCount >= MAX_OPEN_INTENTS) throw conflict("too_many_open_intents", "Há recargas em aberto para este aluno. Conclua ou aguarde a validade delas.", { max: MAX_OPEN_INTENTS });
      const balance = parseWalletState(wallet?.data()).balanceCents;
      if (balance + input.amountCents > MAX_BALANCE_CENTS) throw conflict("balance_limit", "Saldo acima do limite da carteira.");

      const payer = { name: profile.displayName, email: profile.email };
      created.payer = payer;
      const stamp = Timestamp.fromDate(now);
      const doc: IntentDoc = {
        intentId,
        channel: input.channel,
        status: "creating",
        studentId: input.studentId,
        studentName: String(student?.get("name") ?? ""),
        amountCents: input.amountCents,
        currency: "BRL",
        provider: { id: provider.id, mode: provider.mode },
        payer,
        charge: null,
        pix: null,
        failure: null,
        creation: { attempts: 1, lastOutcome: null, lastCheckedAt: null },
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      tx.create(intentRef(db, intentId), { ...doc, kind: "online", externalReference: intentId, createdBy: { uid: current.uid, role: current.role ?? null } });
      auditInTransaction(db, tx, auditId, {
        action: "topup.online.intent",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        target: { type: "topupIntent", id: intentId },
        after: { studentId: input.studentId, amountCents: input.amountCents, channel: input.channel, provider: provider.id },
      });
      return { intentId };
    },
  );

  // Só a execução que CRIOU a intenção chama o provedor (o callback pode ter rodado mais de uma vez; o efeito vem depois).
  if (!result.replayed && created.payer) {
    const card = input.channel === "card" ? { cardToken: input.cardToken, paymentMethodId: input.paymentMethodId, payer: input.payer } : undefined;
    await attemptCreation(db, intentId, { channel: input.channel, amountCents: input.amountCents, card }, created.payer, deps, clock);
  }
  const view = intentView((await intentRef(db, intentId).get()).data() as IntentDoc, clock());
  return { ...view, replayed: result.replayed };
}

type Outcome = { type: "charge"; charge: ProviderCharge } | { type: "rejected"; code: string } | { type: "uncertain"; code: string } | { type: "not_created" } | { type: "checked" };

function request(intentId: string, amountCents: number, payer: ChargeRequest["payer"]): ChargeRequest {
  return { intentId, idempotencyKey: intentId, externalReference: intentId, amountCents, currency: "BRL", description: "Recarga da carteira da cantina", payer };
}

/** Chamada externa (fora de qualquer transação) e registro do desfecho. Erro desconhecido = incerto (falha segura). */
async function attemptCreation(
  db: Firestore,
  intentId: string,
  input: { channel: Channel; amountCents: number; card?: { cardToken: string; paymentMethodId: string; payer: { email: string; identification: { type: "CPF" | "CNPJ"; number: string } } } },
  payer: ChargeRequest["payer"],
  deps: IntentDeps,
  clock: () => Date,
): Promise<void> {
  let outcome: Outcome;
  try {
    const base = request(intentId, input.amountCents, payer);
    const charge =
      input.channel === "pix"
        ? await deps.providers.pix!.createPixCharge({ ...base, expiresAt: new Date(clock().getTime() + PIX_TTL_MS) })
        : await deps.providers.card!.createCardCharge({
            ...base,
            payer: { name: payer.name, email: input.card!.payer.email, identification: input.card!.payer.identification },
            cardToken: input.card!.cardToken,
            paymentMethodId: input.card!.paymentMethodId,
            installments: 1,
          });
    outcome = { type: "charge", charge };
  } catch (error) {
    outcome = error instanceof ProviderError && error.kind === "rejected" ? { type: "rejected", code: error.code } : { type: "uncertain", code: error instanceof ProviderError ? error.code : "provider_error" };
  }
  await applyOutcome(db, intentId, outcome, clock);
}

/**
 * Transação de desfecho: só altera intenção ainda em `creating`/`creation_uncertain`; um desfecho tardio (ex.: a resposta
 * original chegando depois da conciliação) não regride nem duplica nada. Resposta incoerente do provedor = incerta.
 */
async function applyOutcome(db: Firestore, intentId: string, outcome: Outcome, clock: () => Date): Promise<void> {
  const ref = intentRef(db, intentId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as IntentDoc | undefined;
    if (!data || (data.status !== "creating" && data.status !== "creation_uncertain")) return;
    const now = Timestamp.fromDate(clock());
    let patch: Partial<IntentDoc> & Record<string, unknown>;
    let lastOutcome: string;
    if (outcome.type === "charge") {
      const problem = checkCharge(data.channel, outcome.charge);
      const charge = { id: outcome.charge.chargeId, providerStatus: outcome.charge.providerStatus };
      if (problem) {
        patch = { status: "creation_uncertain" };
        lastOutcome = `invalid_response:${problem}`;
      } else if (outcome.charge.outcome === "declined") {
        patch = { status: "failed", charge, failure: { code: outcome.charge.declineCode && /^[a-z_]{1,40}$/.test(outcome.charge.declineCode) ? outcome.charge.declineCode : "card_declined" } };
        lastOutcome = "declined";
      } else {
        patch = { status: outcome.charge.outcome, charge, pix: data.channel === "pix" ? outcome.charge.pix : null };
        lastOutcome = "created";
      }
    } else if (outcome.type === "rejected") {
      patch = { status: "failed", failure: { code: /^[a-z_]{1,40}$/.test(outcome.code) ? outcome.code : "provider_rejected" } };
      lastOutcome = "rejected";
    } else if (outcome.type === "uncertain") {
      patch = { status: "creation_uncertain" };
      lastOutcome = `uncertain:${outcome.code.slice(0, 40)}`;
    } else if (outcome.type === "not_created") {
      patch = { status: "failed", failure: { code: "not_created" } };
      lastOutcome = "not_found_after_timeout";
    } else {
      patch = { status: "creation_uncertain" };
      lastOutcome = "not_found_yet";
    }
    const version = data.version + 1;
    tx.update(ref, { ...patch, "creation.lastOutcome": lastOutcome, "creation.lastCheckedAt": now, version, updatedAt: now });
    auditInTransaction(db, tx, `${intentId}__v${version}`, {
      action: "topup.online.outcome",
      actorUid: "system",
      actorRole: null,
      target: { type: "topupIntent", id: intentId },
      before: { status: data.status },
      after: { status: patch.status ?? data.status, outcome: lastOutcome },
    });
  });
}

/* ------------------------------------------------------------------------------------------------ conciliação */

const idSchema = /^tpi_[a-f0-9]{20}$/;

async function readAuthorized(db: Firestore, actor: Actor, intentId: string, action: "wallet.read" | "wallet.transfer"): Promise<IntentDoc> {
  if (!idSchema.test(intentId)) throw notFound("intent_not_found");
  const snap: DocumentSnapshot = await intentRef(db, intentId).get();
  if (!snap.exists) throw notFound("intent_not_found");
  const data = snap.data() as IntentDoc;
  if (!(action === "wallet.transfer" && actor.role === "admin")) await authorizeStudent(db, actor, data.studentId, action);
  return data;
}

/**
 * Conciliação de criação incerta (automática pela tela e manual): consulta o provedor pela referência = ID da intenção.
 * Encontrou → aplica o desfecho; não encontrou → continua "verificando" (ou encerra como não criada depois do limite);
 * `resend: true` (botão da família) reenvia o MESMO Pix com a MESMA chave dentro da janela de deduplicação do provedor.
 * Responsável vinculado ativo ou administração (ação manual autorizada).
 */
export async function reconcileTopupIntent(
  db: Firestore,
  actor: Actor,
  intentId: string,
  raw: unknown,
  deps: IntentDeps,
): Promise<IntentView & { reconcile: "not_needed" | "found" | "resent" | "not_found" | "given_up" | "provider_unavailable" | "lookup_failed" }> {
  const clock = deps.clock ?? (() => new Date());
  const input = reconcileSchema.parse(raw ?? {});
  if (actor.role !== "guardian" && actor.role !== "admin") throw new ForbiddenError("Sem permissão para conciliar recarga.");
  const data = await readAuthorized(db, actor, intentId, "wallet.transfer");
  const view = async (reconcile: Awaited<ReturnType<typeof reconcileTopupIntent>>["reconcile"]) => ({ ...intentView((await intentRef(db, intentId).get()).data() as IntentDoc, clock()), reconcile });

  if (!needsReconcile(data.status, ms(data.updatedAt), clock())) return view("not_needed");
  const provider = data.channel === "pix" ? deps.providers.pix : deps.providers.card;
  if (!provider || provider.id !== data.provider.id) return view("provider_unavailable");

  let found: ProviderCharge | null;
  try {
    found = await provider.findCharge(intentId, data.createdAt.toDate());
  } catch {
    return view("lookup_failed");
  }
  const decision = decideReconcile({
    found: found !== null,
    channel: data.channel,
    resend: input.resend === true,
    createdAtMs: ms(data.createdAt),
    now: clock(),
    idempotencyWindowMs: data.channel === "pix" && deps.providers.pix ? deps.providers.pix.idempotencyWindowMs : 0,
  });
  if (decision === "apply_found") {
    await applyOutcome(db, intentId, { type: "charge", charge: found! }, clock);
    return view("found");
  }
  if (decision === "resend") {
    await db.doc(`topupIntents/${intentId}`).update({ "creation.attempts": data.creation.attempts + 1 });
    await attemptCreation(db, intentId, { channel: "pix", amountCents: data.amountCents }, data.payer, deps, clock);
    return view("resent");
  }
  if (decision === "give_up") {
    await applyOutcome(db, intentId, { type: "not_created" }, clock);
    return view("given_up");
  }
  await applyOutcome(db, intentId, { type: "checked" }, clock);
  return view("not_found");
}

/* ------------------------------------------------------------------------------------------------ leituras */

/** Detalhe da intenção: quem lê a carteira do aluno (responsável vinculado, administração, o próprio aluno). */
export async function getTopupIntent(db: Firestore, actor: Actor, intentId: string, clock: () => Date = () => new Date()): Promise<IntentView> {
  return intentView(await readAuthorized(db, actor, intentId, "wallet.read"), clock());
}

/** Últimas recargas online do aluno (10, mais recentes primeiro). */
export async function listTopupIntents(db: Firestore, actor: Actor, query: Record<string, string>, clock: () => Date = () => new Date()): Promise<{ intents: IntentView[] }> {
  const studentId = query.studentId ?? "";
  await authorizeStudent(db, actor, studentId, "wallet.read");
  const snap = await db.collection("topupIntents").where("studentId", "==", studentId).orderBy("createdAt", "desc").limit(10).get();
  const now = clock();
  return { intents: snap.docs.map((d) => intentView(d.data() as IntentDoc, now)) };
}
