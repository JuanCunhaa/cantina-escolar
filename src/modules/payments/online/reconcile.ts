import type { Firestore } from "firebase-admin/firestore";
import type { Actor } from "@/modules/access/actor";
import { refreshIntent, type ConfirmDeps, type ConfirmOutcome } from "./confirmation";
import { getTopupIntent, reconcileTopupIntent, type IntentDeps, type IntentView } from "./intent-commands";
import { ProviderError } from "./provider";

export type ReconcileResult = Awaited<ReturnType<typeof reconcileTopupIntent>> & {
  /** Resultado da consulta confirmatória ao provedor (`null` = não consultada ou consulta falhou). */
  confirmation: ConfirmOutcome | null;
  /** Carteira depois de um crédito/reversão lançado NESTA chamada (a tela reconcilia por `version`). */
  wallet: { studentId: string; balanceCents: number; version: number } | null;
};

/**
 * Conciliação pela tela / ação manual (F19): primeiro a criação incerta da F18 (consulta por referência), depois a consulta
 * CONFIRMATÓRIA da order no provedor — a mesma decisão e transação do webhook. É o caminho de recuperação de notificação
 * perdida e de pagamento tardio, e a base do acompanhamento do Pix na tela. Autorização: responsável vinculado ou
 * administração (a de `reconcileTopupIntent`). Falha na consulta não altera nada.
 */
export async function reconcileAndConfirm(db: Firestore, actor: Actor, intentId: string, raw: unknown, deps: IntentDeps & { production?: boolean }): Promise<ReconcileResult> {
  const clock = deps.clock ?? (() => new Date());
  const base = await reconcileTopupIntent(db, actor, intentId, raw, deps);
  if (base.status === "reversed" || (base.status === "failed" && base.failure?.code === "refunded_before_credit")) return { ...base, confirmation: null, wallet: null };
  const confirmDeps: ConfirmDeps = { providers: deps.providers, production: deps.production, clock };
  let confirmation: ConfirmOutcome | null = null;
  let wallet: ReconcileResult["wallet"] = null;
  try {
    const result = await refreshIntent(db, confirmDeps, intentId, actor.role === "admin" ? "admin" : "reconcile");
    confirmation = result.outcome;
    wallet = result.wallet;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error; // indisponibilidade do provedor: segue com a leitura local
  }
  const view: IntentView = await getTopupIntent(db, actor, intentId, clock);
  return { ...base, ...view, reconcile: base.reconcile, confirmation, wallet };
}
