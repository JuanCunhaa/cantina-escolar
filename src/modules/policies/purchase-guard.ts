import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction } from "firebase-admin/firestore";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction } from "@/modules/access/authorize";
import { evaluatePurchasePolicy, type ActorKind, type PurchaseChannel, type PurchaseEvaluation, type PurchaseLine } from "./evaluate";
import { parseException, parsePolicy, type PolicyException, type StudentPolicy } from "./model";
import { readUsage, writeUsage, type UsageSnapshot } from "./usage";

/**
 * Ponto de integração de checkout (site, F11) e PDV (balcão, F15): os dois comandos chamam as MESMAS funções, dentro
 * da transação idempotente do pedido, nesta ordem:
 *
 *   1. `readPurchaseGuard`   (leituras: aluno, vínculo, política, uso por data/semana, exceção) — antes de qualquer escrita;
 *   2. `decidePurchase`      (puro; negar = lançar/retornar sem escrever);
 *   3. demais leituras/decisões do comando (preço, estoque, cota, saldo);
 *   4. `commitPurchaseUsage` junto com a carteira/livro/pedido (mesma transação): soma o consumo por data/semana e,
 *      se a compra usou uma exceção, a marca como usada.
 *
 * Reembolso/cancelamento/reagendamento liberam com `releaseUsage` (leitura → `writeUsage(..., -1)`) e reservam o destino
 * com este mesmo guard, revalidando os limites dos dias/semanas de destino. Datas, janela e horários (F05) e preço/
 * estoque (F06/F10) continuam sendo verificados pelo comando; aqui só vale a política do responsável.
 */
export type PurchaseRequest = {
  studentId: string;
  channel: PurchaseChannel;
  lines: readonly PurchaseLine[];
  /** Confirmação explícita do responsável na interface (ignorada para aluno/funcionário). */
  confirmed?: boolean;
  /** Exceção registrada (autorização do responsável ou administrativa) a usar nesta compra. */
  exceptionId?: string;
};

export type PurchaseGuard = {
  request: PurchaseRequest;
  actorKind: ActorKind | null;
  permitted: boolean;
  policy: StudentPolicy;
  usage: UsageSnapshot;
  exception: PolicyException | null;
  exceptionRef: DocumentReference | null;
};

export const exceptionRefOf = (db: Firestore, studentId: string, exceptionId: string) => db.doc(`studentPolicies/${studentId}/exceptions/${exceptionId}`);

function actorKindOf(actor: Actor): ActorKind | null {
  if (actor.role === "guardian") return "guardian";
  if (actor.role === "student") return "student";
  if (actor.role === "cantina" || actor.role === "admin") return "staff";
  return null;
}

export async function readPurchaseGuard(db: Firestore, tx: Transaction, actor: Actor, request: PurchaseRequest): Promise<PurchaseGuard> {
  const actorKind = actorKindOf(actor);
  const exceptionRef = request.exceptionId && actorKind !== "guardian" ? exceptionRefOf(db, request.studentId, request.exceptionId) : null;
  const refs = [
    db.doc(`students/${request.studentId}`),
    db.doc(`guardianStudentLinks/${actor.uid}_${request.studentId}`),
    db.doc(`studentPolicies/${request.studentId}`),
    ...(exceptionRef ? [exceptionRef] : []),
  ];
  const [student, link, policy, exception]: DocumentSnapshot[] = await tx.getAll(...refs);
  const usage = await readUsage(db, tx, request.studentId, request.lines.map((l) => l.consumptionDate));
  const permitted = decideStudentAction({
    actor,
    studentId: request.studentId,
    action: request.channel === "advance" ? "purchase.site" : "purchase.counter",
    student: student?.data(),
    link: link?.data(),
    policy: policy?.data(),
  });
  return {
    request,
    actorKind,
    permitted,
    policy: parsePolicy(policy?.data()),
    usage,
    exception: exception ? parseException(exception.id, exception.data()) : null,
    exceptionRef,
  };
}

export function decidePurchase(guard: PurchaseGuard): PurchaseEvaluation {
  return evaluatePurchasePolicy({
    channel: guard.request.channel,
    actorKind: guard.actorKind ?? "student",
    permitted: guard.permitted && guard.actorKind !== null,
    policy: guard.policy,
    lines: guard.request.lines,
    usage: guard.usage,
    confirmed: guard.request.confirmed,
    exception: guard.exception,
  });
}

/** Grava o consumo (e marca a exceção usada) — chamar só quando `evaluation.allowed`, na transação do pedido. */
export function commitPurchaseUsage(db: Firestore, tx: Transaction, actor: Actor, guard: PurchaseGuard, evaluation: PurchaseEvaluation, orderId: string): void {
  if (!evaluation.allowed) throw new Error("Compra negada pela política: nada a comprometer.");
  writeUsage(tx, db, guard.request.studentId, guard.usage, guard.request.lines.map((l) => ({ date: l.consumptionDate, amountCents: l.amountCents })), 1);
  if (evaluation.override?.via === "exception" && guard.exceptionRef) {
    tx.update(guard.exceptionRef, { status: "used", usedBy: actor.uid, usedFor: orderId, usedAt: FieldValue.serverTimestamp() });
  }
}

/** Libera consumo (cancelamento/reembolso/reagendamento): lê o uso na transação e subtrai; nunca deixa negativo. */
export async function releaseUsage(
  db: Firestore,
  tx: Transaction,
  studentId: string,
  lines: readonly { consumptionDate: string; amountCents: number }[],
): Promise<() => void> {
  const snapshot = await readUsage(db, tx, studentId, lines.map((l) => l.consumptionDate));
  return () => writeUsage(tx, db, studentId, snapshot, lines.map((l) => ({ date: l.consumptionDate, amountCents: l.amountCents })), -1);
}
