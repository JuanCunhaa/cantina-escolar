import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { unavailable } from "@/lib/domain-error";
import { sha256Hex } from "@/lib/firebase/command";
import { COMMAND_TRANSACTION } from "@/lib/firebase/transaction-options";
import { localDateOf } from "@/lib/dates/school-time";
import { auditInTransaction } from "@/modules/audit/log";
import { applyDelta, MAX_BALANCE_CENTS, parseWalletState, pendingReversalOf } from "@/modules/wallet/model";
import { ONLINE_SOURCE_ID } from "@/modules/fees/fee-model";
import { feeApplicationOf, feeRefs, refsToRead } from "@/modules/fees/fee-store";
import { PAYMENT_LABEL } from "../methods";
import { decide, splitRecovery, type Decision, type DecisionContext, type IntentFacts, type ReviewReason } from "./confirmation-model";
import type { IntentDoc } from "./intent-doc";
import type { IntentStatus } from "./intent-model";
import type { OnlineProviders, ProviderOrder } from "./provider";

/**
 * Confirmação confiável, crédito e reversão da recarga online (F19). Fluxo, para QUALQUER gatilho (webhook autenticado,
 * conciliação pela tela, varredura agendada ou ação manual da administração):
 *   1. FORA de transação: consulta a order no provedor (`getOrder`) e a conta recebedora — o status da notificação nunca é usado;
 *   2. UMA transação: relê intenção, carteira, evento e pendência; `decide` (identidade, conta, ambiente, moeda, valor, ordem
 *      dos estados) e aplica o resultado INTEIRO — crédito + livro + intenção + evento + auditoria — ou nada.
 * Crédito exatamente uma vez: o lançamento tem ID determinístico (`{intentId}_credit`, `create` falha se existir) e a decisão
 * só credita quando a intenção NÃO está `confirmed`/`reversed`; notificações duplicadas, concorrentes, fora de ordem e
 * reprocessamentos convergem para `noop`. Nada regride: pendente depois de pago é `noop`.
 * Reversão (reembolso/chargeback): NOVO lançamento `topup_reversal` limitado ao saldo; o que a carteira não cobre vira
 * pendência (`paymentPendencies/{intentId}`) e `wallets.pendingReversalCents` bloqueia novas despesas. Nunca saldo negativo.
 */

export type ConfirmSource = "webhook" | "reconcile" | "sweep" | "admin";
/** `requestId` e `tsMs` são ASSINADOS; `action`, `version`, `liveMode` e `userId` vêm do corpo (não assinado) e só informam/ignoram. */
export type NotificationEvent = { action: string; version: string; requestId: string | null; tsMs: number; liveMode: boolean | null; userId: string | null };
/** `production` é aceito por compatibilidade; o ambiente vem das credenciais (`MERCADOPAGO_ENV`), não do corpo da notificação. */
export type ConfirmDeps = { providers: OnlineProviders; production?: boolean; clock?: () => Date };

export type ConfirmOutcome = "credited" | "already_credited" | "reversal_applied" | "review" | "failed" | "expired" | "noop" | "unknown_order" | "no_charge";
export type ConfirmResult = {
  outcome: ConfirmOutcome;
  reason: string | null;
  intentId: string | null;
  status: IntentStatus | null;
  /** Carteira DEPOIS de um crédito/reversão (a tela reconcilia pela `version`). */
  wallet: { studentId: string; balanceCents: number; version: number } | null;
};

const INTENT_ID = /^tpi_[a-f0-9]{20}$/;
const noResult = (outcome: ConfirmOutcome, reason: string | null, intentId: string | null = null, status: IntentStatus | null = null): ConfirmResult => ({ outcome, reason, intentId, status, wallet: null });

function pickProvider(providers: OnlineProviders) {
  const candidates = [providers.pix, providers.card].filter((p): p is NonNullable<typeof p> => p !== null);
  return candidates.find((p) => p.mode === "live") ?? candidates[0] ?? null;
}


/**
 * ID do evento externo: unicidade por provedor + conta + order + entrega (`x-request-id` e `ts`, ambos ASSINADOS —
 * docs/domains/payments.md §6.4). Ação/versão do corpo ficam FORA da chave: quem reaproveita uma assinatura capturada com outro
 * corpo cai no mesmo evento, sem criar documentos novos.
 */
export const eventIdOf = (provider: string, accountId: string, orderId: string, requestId: string | null, tsMs: number) =>
  `pev_${sha256Hex([provider, accountId, orderId, requestId ?? "", String(tsMs)].join("\u0000")).slice(0, 40)}`;

async function recordEventOnly(db: Firestore, id: string, doc: Record<string, unknown>): Promise<void> {
  await db
    .doc(`paymentEvents/${id}`)
    .create({ ...doc, receivedAt: FieldValue.serverTimestamp() })
    .catch((error: { code?: number }) => {
      if (error.code !== 6) throw error; // 6 = ALREADY_EXISTS: notificação repetida
    });
}

/**
 * Confirma/atualiza a recarga a partir de uma order do provedor. `expectIntentId` (conciliação por intenção) exige que a order
 * pertença àquela intenção. Erros do provedor (`ProviderError`) sobem: o chamador decide (webhook → 503 para o provedor
 * reenviar; conciliação → "consulta falhou").
 */
export async function confirmFromProvider(
  db: Firestore,
  deps: ConfirmDeps,
  orderId: string,
  trigger: { source: ConfirmSource; event?: NotificationEvent; expectIntentId?: string; provider?: NonNullable<ReturnType<typeof pickProvider>> },
): Promise<ConfirmResult> {
  const clock = deps.clock ?? (() => new Date());
  // Conciliação por intenção usa o provedor do CANAL da intenção; o webhook (só traz a order) usa o primeiro provedor real configurado.
  const provider = trigger.provider ?? pickProvider(deps.providers);
  if (!provider) throw unavailable("payment_unavailable", "Pagamento online indisponível.");
  const accountId = await provider.accountId();
  const eventId = trigger.event ? eventIdOf(provider.id, accountId, orderId, trigger.event.requestId, trigger.event.tsMs) : null;
  const eventBase = trigger.event ? { eventId, provider: provider.id, accountId, orderId, bodyUserId: (trigger.event.userId ?? "").slice(0, 24), bodyLiveMode: trigger.event.liveMode, action: trigger.event.action.slice(0, 80), version: trigger.event.version.slice(0, 40), requestId: trigger.event.requestId?.slice(0, 80) ?? null, source: trigger.source } : null;

  // O corpo da notificação NÃO é assinado: `user_id` e `live_mode` dele não decidem nada (a simulação do painel, por exemplo, traz a
  // conta e o ambiente do dono da aplicação). Conta e ambiente valem para a ORDER consultada com a nossa credencial: uma order de
  // outra conta nem é encontrada (404 → `unknown_order`) e `decide` confere a conta recebedora da order. Ficam só registrados.
  const order = await provider.getOrder(orderId);
  // O ID da order pode chegar em outra caixa que a devolvida pelo provedor (a assinatura aceita as duas formas): compara sem caixa.
  if (!order || order.orderId.toLowerCase() !== orderId.toLowerCase()) {
    if (eventId && eventBase) await recordEventOnly(db, eventId, { ...eventBase, intentId: null, outcome: "unknown_order" });
    return noResult("unknown_order", "order_not_found");
  }
  const intentId = order.externalReference;
  if (!intentId || !INTENT_ID.test(intentId) || (trigger.expectIntentId && trigger.expectIntentId !== intentId)) {
    // Dinheiro (ou devolução/contestação) numa order da NOSSA conta cuja referência não é de nenhuma recarga: nada a creditar nem
    // a revisar numa intenção, mas a administração precisa VER (lista “pagamentos sem recarga”); as demais ficam só no evento.
    const moneyMoved = ["paid", "refunded", "partially_refunded", "chargeback", "dispute_open", "dispute_won"].includes(order.state);
    if (eventId && eventBase) await recordEventOnly(db, eventId, { ...eventBase, intentId: null, outcome: moneyMoved ? "orphan_payment" : "unknown_order", reference: (order.externalReference ?? "").slice(0, 60), amountCents: order.paidCents });
    return noResult("unknown_order", "reference_not_ours");
  }
  const ctx: DecisionContext = { accountId, providerId: provider.id };
  return applyOrder(db, { intentId, order, ctx, source: trigger.source, eventId, eventBase, now: clock() });
}

type ApplyArgs = { intentId: string; order: ProviderOrder; ctx: DecisionContext; source: ConfirmSource; eventId: string | null; eventBase: Record<string, unknown> | null; now: Date };

const BINDS_CHARGE: readonly ReviewReason[] = ["amount_mismatch", "currency_mismatch", "balance_limit", "reversal_before_credit"];

async function applyOrder(db: Firestore, a: ApplyArgs): Promise<ConfirmResult> {
  const { intentId, order, ctx } = a;
  const intentRef = db.doc(`topupIntents/${intentId}`);
  const eventRef = a.eventId ? db.doc(`paymentEvents/${a.eventId}`) : null;
  const pendencyRef = db.doc(`paymentPendencies/${intentId}`);

  return db.runTransaction(async (tx): Promise<ConfirmResult> => {
    // ---- leituras (todas antes de qualquer escrita)
    const [intentSnap, eventSnap] = await tx.getAll(intentRef, ...(eventRef ? [eventRef] : []));
    if (!intentSnap?.exists) {
      if (eventRef && a.eventBase && !eventSnap?.exists) tx.create(eventRef, { ...a.eventBase, intentId: null, outcome: "unknown_order", receivedAt: FieldValue.serverTimestamp() });
      return noResult("unknown_order", "intent_not_found");
    }
    const data = intentSnap.data() as IntentDoc;
    const walletRef = db.doc(`wallets/${data.studentId}`);
    // Regra de taxa em vigor (F20): lida junto, ANTES de qualquer escrita; só é usada se este gatilho creditar.
    const onlineFeeRefs = feeRefs(db, data.channel === "pix" ? "pix" : "card_credit", ONLINE_SOURCE_ID);
    const [walletSnap, pendencySnap, feeSeriesSnap] = await tx.getAll(walletRef, pendencyRef, ...refsToRead(onlineFeeRefs).slice(0, 1));
    const walletState = parseWalletState(walletSnap!.data());

    const facts: IntentFacts = {
      intentId,
      status: data.status,
      amountCents: data.amountCents,
      chargeId: data.charge?.id ?? null,
      providerId: data.provider.id,
      accountedReversalCents: data.reversal?.accountedCents ?? 0,
      reviewReason: data.review?.reason ?? null,
      dispute: data.dispute?.status ?? null,
      reversalCause: data.reversal && data.reversal.accountedCents > 0 ? data.reversal.cause : null,
    };
    let decision: Decision = decide(facts, order, ctx);
    if (decision.kind === "credit" && walletState.balanceCents + data.amountCents > MAX_BALANCE_CENTS) decision = { kind: "review", reason: "balance_limit" };

    const nowTs = Timestamp.fromDate(a.now);
    const stamp = FieldValue.serverTimestamp();
    const version = data.version + 1;
    const charge = data.charge ?? { id: order.orderId, providerStatus: order.providerStatus };
    const audit = (id: string, action: string, after: Record<string, unknown>) =>
      auditInTransaction(db, tx, id, { action, actorUid: "system", actorRole: null, target: { type: "topupIntent", id: intentId }, before: { status: data.status }, after: { ...after, source: a.source } });
    const event = (outcome: string, reason: string | null) => {
      if (eventRef && a.eventBase && !eventSnap?.exists) tx.create(eventRef, { ...a.eventBase, intentId, outcome, reason, receivedAt: stamp });
    };

    switch (decision.kind) {
      case "noop": {
        event("noop", decision.reason);
        return { ...noResult(decision.reason === "already_credited" ? "already_credited" : "noop", decision.reason, intentId, data.status), wallet: null };
      }

      case "credit": {
        const wallet = applyDelta(walletState, data.amountCents);
        const entryId = `${intentId}_credit`;
        const method = data.channel === "pix" ? "pix" : "card_credit";
        const rule = feeApplicationOf(onlineFeeRefs, feeSeriesSnap, { grossCents: data.amountCents, receivedOn: localDateOf(a.now) });
        // Pagamento que chegou depois de a intenção já constar como encerrada, ou de o Pix vencer pela validade local.
        const afterExpiry = data.status === "expired" || data.status === "failed" || (data.pix !== null && Date.parse(data.pix.expiresAt) <= a.now.getTime());
        tx.create(db.doc(`wallets/${data.studentId}/entries/${entryId}`), {
          type: "topup",
          seq: wallet.version,
          amountCents: data.amountCents,
          balanceAfterCents: wallet.balanceCents,
          reason: `Recarga online · ${PAYMENT_LABEL[method]}`,
          topupId: intentId,
          method,
          source: "online",
          actorUid: "system",
          actorRole: null,
          referenceType: "topup",
          referenceId: intentId,
          createdAt: stamp,
        });
        tx.set(walletRef, { studentId: data.studentId, currency: "BRL", balanceCents: wallet.balanceCents, version: wallet.version, updatedAt: stamp, ...(walletSnap!.exists ? {} : { createdAt: stamp }) }, { merge: true });
        tx.update(intentRef, {
          status: "confirmed",
          charge,
          failure: null,
          review: FieldValue.delete(),
          "provider.accountId": ctx.accountId,
          confirmation: { orderId: order.orderId, paymentId: order.paymentId, source: a.source, paidCents: order.paidCents, confirmedAt: nowTs, afterExpiry, walletEntryId: entryId, walletSeq: wallet.version, balanceAfterCents: wallet.balanceCents },
          reversal: { accountedCents: 0, recoveredCents: 0, pendingCents: 0, cause: "refund", lastEntryId: null },
          // Taxa e liquidação REAIS ainda não são consultadas ao provedor: ficam pendentes até a conferência da administração (F20). A regra
          // em vigor só gera ESTIMATIVA congelada e a previsão de liquidação; nunca altera o crédito (bruto integral).
          fee: { status: "pending", cents: null, source: "provider" },
          feeEstimate: rule.estimate,
          feeSourceId: ONLINE_SOURCE_ID,
          settlement: { status: "pending", expectedOn: rule.expectedSettlementOn, settledOn: null, expectedSource: rule.expectedSettlementOn ? "rule" : null },
          version,
          updatedAt: nowTs,
        });
        event("credited", null);
        audit(`${intentId}__credit`, "topup.online.confirm", { fromStatus: data.status, amountCents: data.amountCents, balanceCents: wallet.balanceCents, walletSeq: wallet.version, afterExpiry, orderId: order.orderId });
        return { outcome: "credited", reason: null, intentId, status: "confirmed", wallet: { studentId: data.studentId, balanceCents: wallet.balanceCents, version: wallet.version } };
      }

      case "dispute": {
        // Contestação em andamento / ganha: SÓ sinaliza para a administração; nenhum lançamento, nenhuma pendência, nenhum bloqueio.
        tx.update(intentRef, { dispute: { status: decision.status, at: nowTs }, version, updatedAt: nowTs });
        event("dispute", decision.status);
        audit(`${intentId}__v${version}`, "topup.online.dispute", { dispute: decision.status, orderId: order.orderId, providerStatus: order.providerStatus });
        return noResult("noop", `dispute_${decision.status}`, intentId, data.status);
      }

      case "review": {
        const bind = !data.charge && BINDS_CHARGE.includes(decision.reason);
        tx.update(intentRef, { status: "in_review", review: { reason: decision.reason, at: nowTs }, ...(bind ? { charge } : {}), version, updatedAt: nowTs });
        event("review", decision.reason);
        audit(`${intentId}__v${version}`, "topup.online.review", { reason: decision.reason, orderId: order.orderId, providerStatus: order.providerStatus, paidCents: order.paidCents, totalCents: order.totalCents });
        return noResult("review", decision.reason, intentId, "in_review");
      }

      case "fail":
      case "expire": {
        const status: IntentStatus = decision.kind === "expire" ? "expired" : "failed";
        const code = decision.kind === "expire" ? "pix_expired" : decision.code;
        tx.update(intentRef, { status, charge, failure: { code }, "provider.accountId": ctx.accountId, version, updatedAt: nowTs });
        event(status, code);
        audit(`${intentId}__v${version}`, "topup.online.closed", { status, code, orderId: order.orderId, providerStatus: order.providerStatus });
        return noResult(status === "expired" ? "expired" : "failed", code, intentId, status);
      }

      case "reverse": {
        const added = decision.targetCents - facts.accountedReversalCents;
        const { recoveredCents, pendingCents } = splitRecovery(added, walletState.balanceCents);
        const entryId = `${intentId}_rev_${decision.targetCents}`;
        const prev = data.reversal ?? { accountedCents: 0, recoveredCents: 0, pendingCents: 0, cause: decision.cause, lastEntryId: null };
        let wallet = walletState;
        if (recoveredCents > 0) {
          wallet = applyDelta(walletState, -recoveredCents);
          tx.create(db.doc(`wallets/${data.studentId}/entries/${entryId}`), {
            type: "topup_reversal",
            seq: wallet.version,
            amountCents: -recoveredCents,
            balanceAfterCents: wallet.balanceCents,
            reason: decision.cause === "chargeback" ? "Contestação de recarga online (chargeback)" : "Reembolso de recarga online",
            topupId: intentId,
            source: "online",
            externalCause: decision.cause,
            pendingCents,
            actorUid: "system",
            actorRole: null,
            referenceType: "topup",
            referenceId: intentId,
            createdAt: stamp,
          });
        }
        tx.set(walletRef, { balanceCents: wallet.balanceCents, version: wallet.version, pendingReversalCents: pendingReversalOf(walletSnap!.data()) + pendingCents, updatedAt: stamp }, { merge: true });
        const fullyReversed = decision.targetCents >= data.amountCents;
        tx.update(intentRef, {
          ...(decision.cause === "chargeback" ? { dispute: { status: "lost", at: nowTs } } : {}),
          status: fullyReversed ? "reversed" : "confirmed",
          reversal: { accountedCents: decision.targetCents, recoveredCents: prev.recoveredCents + recoveredCents, pendingCents: prev.pendingCents + pendingCents, cause: decision.cause, lastEntryId: recoveredCents > 0 ? entryId : prev.lastEntryId },
          version,
          updatedAt: nowTs,
        });
        if (pendingCents > 0) {
          const open = pendencySnap!.exists ? (pendencySnap!.data() as { outstandingCents: number; openedCents: number; version: number }) : null;
          if (open) {
            tx.update(pendencyRef, { status: "open", cause: decision.cause, openedCents: open.openedCents + pendingCents, outstandingCents: open.outstandingCents + pendingCents, resolution: null, version: open.version + 1, updatedAt: nowTs });
          } else {
            tx.create(pendencyRef, { pendencyId: intentId, intentId, studentId: data.studentId, studentName: data.studentName, cause: decision.cause, status: "open", openedCents: pendingCents, outstandingCents: pendingCents, recoveredCents: 0, writtenOffCents: 0, resolution: null, version: 1, createdAt: nowTs, updatedAt: nowTs });
          }
        }
        event("reversal", decision.cause);
        audit(`${intentId}__rev_${decision.targetCents}`, "topup.online.reversal", { cause: decision.cause, targetCents: decision.targetCents, addedCents: added, recoveredCents, pendingCents, balanceCents: wallet.balanceCents, fullyReversed, orderId: order.orderId });
        return { outcome: "reversal_applied", reason: decision.cause, intentId, status: fullyReversed ? "reversed" : "confirmed", wallet: { studentId: data.studentId, balanceCents: wallet.balanceCents, version: wallet.version } };
      }
    }
  }, COMMAND_TRANSACTION);
}

/**
 * Consulta e aplica o estado do provedor para UMA intenção (conciliação por intenção). Sem cobrança conhecida, procura pela
 * referência (a mesma busca da F18). Nunca cria cobrança. `ProviderError` sobe.
 */
export async function refreshIntent(db: Firestore, deps: ConfirmDeps, intentId: string, source: ConfirmSource): Promise<ConfirmResult> {
  const snap = await db.doc(`topupIntents/${intentId}`).get();
  if (!snap.exists) return noResult("unknown_order", "intent_not_found");
  const data = snap.data() as IntentDoc;
  if (data.provider.mode === "demo") return noResult("no_charge", "demo_provider", intentId, data.status);
  const provider = data.channel === "pix" ? deps.providers.pix : deps.providers.card;
  if (!provider || provider.id !== data.provider.id) return noResult("no_charge", "provider_unavailable", intentId, data.status);
  const chargeId = data.charge?.id ?? (await provider.findCharge(intentId, data.createdAt.toDate()))?.chargeId ?? null;
  if (!chargeId) return noResult("no_charge", "charge_not_found", intentId, data.status);
  return confirmFromProvider(db, deps, chargeId, { source, expectIntentId: intentId, provider });
}

/* ------------------------------------------------------------------------------------------------ varredura */

export const SWEEP_WINDOWS = { openDays: 30, closedDays: 7, confirmedDays: 120, defaultLimit: 100 } as const;
const OPEN_FOR_SWEEP: IntentStatus[] = ["creating", "creation_uncertain", "awaiting_payment", "processing", "in_review"];
const CLOSED_FOR_SWEEP: IntentStatus[] = ["failed", "expired"];

export type SweepSummary = { checked: number; credited: number; reversals: number; reviews: number; closed: number; unchanged: number; lookupFailed: number; noCharge: number; total: number; partial: boolean };

/** Prazo padrão de uma varredura: abaixo do limite da função serverless (`maxDuration` das rotas = 60 s). */
export const SWEEP_DEADLINE_MS = 45_000;

/**
 * Conciliação agendada/manual: recupera notificações perdidas. Reconsulta (a) intenções abertas dos últimos 30 dias,
 * (b) falhas/expiradas dos últimos 7 dias (um pagamento tardio é creditado) e (c) recargas confirmadas dos últimos 120 dias
 * (reembolso/chargeback). Cada grupo tem o SEU limite (as abertas não tiram a vez das confirmadas) e os grupos são percorridos
 * intercalados; há um PRAZO por execução (`partial: true` quando acaba antes de percorrer tudo — rodar de novo continua). Falha de uma
 * intenção não interrompe as demais.
 */
export async function sweepIntents(db: Firestore, deps: ConfirmDeps, options: { limit?: number; deadlineMs?: number } = {}): Promise<SweepSummary> {
  const startedAt = Date.now();
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const limit = Math.min(Math.max(options.limit ?? SWEEP_WINDOWS.defaultLimit, 1), 300);
  const since = (days: number) => Timestamp.fromMillis(now.getTime() - days * 86_400_000);
  const col = db.collection("topupIntents");
  const [open, closed, confirmed] = await Promise.all([
    col.where("status", "in", OPEN_FOR_SWEEP).where("createdAt", ">=", since(SWEEP_WINDOWS.openDays)).orderBy("createdAt", "desc").limit(limit).get(),
    col.where("status", "in", CLOSED_FOR_SWEEP).where("createdAt", ">=", since(SWEEP_WINDOWS.closedDays)).orderBy("createdAt", "desc").limit(limit).get(),
    col.where("status", "==", "confirmed").where("confirmation.confirmedAt", ">=", since(SWEEP_WINDOWS.confirmedDays)).orderBy("confirmation.confirmedAt", "desc").limit(limit).get(),
  ]);
  const groups = [open.docs, confirmed.docs, closed.docs].map((docs) => docs.map((d) => d.id));
  const ids: string[] = [];
  for (let i = 0; i < Math.max(...groups.map((g) => g.length)); i += 1) for (const g of groups) if (g[i] !== undefined) ids.push(g[i]!);
  const unique = [...new Set(ids)];
  const summary: SweepSummary = { checked: 0, credited: 0, reversals: 0, reviews: 0, closed: 0, unchanged: 0, lookupFailed: 0, noCharge: 0, total: unique.length, partial: false };
  const deadlineMs = options.deadlineMs ?? SWEEP_DEADLINE_MS;
  for (const id of unique) {
    if (Date.now() - startedAt >= deadlineMs) {
      summary.partial = true;
      break;
    }
    summary.checked += 1;
    try {
      const result = await refreshIntent(db, deps, id, "sweep");
      if (result.outcome === "credited") summary.credited += 1;
      else if (result.outcome === "reversal_applied") summary.reversals += 1;
      else if (result.outcome === "review") summary.reviews += 1;
      else if (result.outcome === "failed" || result.outcome === "expired") summary.closed += 1;
      else if (result.outcome === "no_charge") summary.noCharge += 1;
      else summary.unchanged += 1;
    } catch (error) {
      summary.lookupFailed += 1;
      console.error("payments sweep: intent failed", error instanceof Error ? error.name : "unknown");
    }
  }
  return summary;
}
