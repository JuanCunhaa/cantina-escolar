import { FieldValue, type DocumentSnapshot, type Firestore } from "firebase-admin/firestore";
import { conflict } from "@/lib/domain-error";
import { runIdempotentCommand, deterministicId } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction, studentAccessRefs } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { auditInTransaction } from "@/modules/audit/log";
import { assertCanSpend, parseWalletState, planTransfer, transferSchema } from "./model";

export type TransferLeg = {
  studentId: string;
  entryId: string;
  /** Posição do movimento no livro desta carteira = versão da carteira depois dele. */
  seq: number;
  /** Valor assinado: débito negativo na origem, crédito positivo no destino. */
  amountCents: number;
  balanceCents: number;
  version: number;
};
export type TransferResult = { transferId: string; amountCents: number; reason: string; from: TransferLeg; to: TransferLeg };

/**
 * Transferência entre duas carteiras (docs/domains/wallet.md): o responsável precisa de vínculo ativo com AMBOS os
 * alunos, ambos ativos. Dentro de UMA transação, depois das leituras (idempotência, perfil, alunos, vínculos e as
 * duas carteiras), grava as duas pernas do livro com o mesmo transferId, as duas projeções, o registro da transferência
 * e a auditoria. Saldo insuficiente aborta tudo. Mesma chave + mesmo payload devolve a resposta original (sem novo
 * movimento) depois de reautorizar com o vínculo atual; chave com payload diferente é conflito.
 */
export async function transferBetweenWallets(db: Firestore, actor: Actor, raw: unknown): Promise<TransferResult & { replayed: boolean }> {
  const input = transferSchema.parse(raw);
  const { fromStudentId, toStudentId } = input;
  const transferId = deterministicId("trf", actor.uid, input.key); // estável entre retentativas
  const entryIds = { out: `${transferId}_out`, in: `${transferId}_in` };

  /** Vínculo ativo com as duas pontas (estado ATUAL, lido na transação) e alunos ativos. `snaps`: aluno, vínculo e política de cada ponta, em sequência. */
  function assertBoth(current: Actor, snaps: DocumentSnapshot[]): void {
    for (const [index, id] of [fromStudentId, toStudentId].entries()) {
      const [student, link, policy] = snaps.slice(index * 3, index * 3 + 3);
      const allowed = decideStudentAction({ actor: current, studentId: id, action: "wallet.transfer", student: student?.data(), link: link?.data(), policy: policy?.data() });
      if (!allowed) throw new ForbiddenError("Sem acesso ao aluno (wallet.transfer).");
      if (student?.get("status") !== "active") throw conflict("student_inactive", "Aluno inativo.");
    }
  }
  const accessRefs = (current: Actor) => [fromStudentId, toStudentId].flatMap((id) => studentAccessRefs(db, current, id));

  return runIdempotentCommand(
    db,
    actor,
    {
      scope: "wallet.transfer",
      key: input.key,
      payload: input,
      allow: (p) => p.role === "guardian",
      revalidateReplay: async ({ tx, actor: current }) => assertBoth(current, await tx.getAll(...accessRefs(current))),
    },
    async ({ tx, actor: current, auditId }) => {
      const walletRefs = { from: db.doc(`wallets/${fromStudentId}`), to: db.doc(`wallets/${toStudentId}`) };
      // Todas as leituras antes de qualquer escrita.
      const snaps = await tx.getAll(...accessRefs(current), walletRefs.from, walletRefs.to);
      assertBoth(current, snaps);
      const fromSnap = snaps[6]!;
      const toSnap = snaps[7]!;
      const fromBefore = parseWalletState(fromSnap.data());
      const toBefore = parseWalletState(toSnap.data());
      assertCanSpend(fromSnap.data()); // transferência de SAÍDA é despesa: bloqueada com pendência de reversão externa (F19)
      const plan = planTransfer(fromBefore, toBefore, input.amountCents); // lança saldo insuficiente / limite

      const now = FieldValue.serverTimestamp();
      const leg = (studentId: string, entryId: string, state: { balanceCents: number; version: number }, amountCents: number): TransferLeg => ({
        studentId,
        entryId,
        seq: state.version,
        amountCents,
        balanceCents: state.balanceCents,
        version: state.version,
      });
      const from = leg(fromStudentId, entryIds.out, plan.from, -input.amountCents);
      const to = leg(toStudentId, entryIds.in, plan.to, input.amountCents);
      const entryBase = { transferId, actorUid: current.uid, actorRole: current.role ?? null, reason: input.reason, referenceType: "transfer", referenceId: transferId, createdAt: now };

      tx.create(db.doc(`wallets/${fromStudentId}/entries/${entryIds.out}`), { ...entryBase, type: "transfer_out", seq: from.seq, amountCents: from.amountCents, balanceAfterCents: from.balanceCents, counterpartStudentId: toStudentId });
      tx.create(db.doc(`wallets/${toStudentId}/entries/${entryIds.in}`), { ...entryBase, type: "transfer_in", seq: to.seq, amountCents: to.amountCents, balanceAfterCents: to.balanceCents, counterpartStudentId: fromStudentId });
      tx.set(walletRefs.from, { studentId: fromStudentId, currency: "BRL", balanceCents: from.balanceCents, version: from.version, updatedAt: now, ...(fromSnap.exists ? {} : { createdAt: now }) }, { merge: true });
      tx.set(walletRefs.to, { studentId: toStudentId, currency: "BRL", balanceCents: to.balanceCents, version: to.version, updatedAt: now, ...(toSnap.exists ? {} : { createdAt: now }) }, { merge: true });
      tx.create(db.doc(`walletTransfers/${transferId}`), {
        transferId,
        fromStudentId,
        toStudentId,
        amountCents: input.amountCents,
        reason: input.reason,
        actorUid: current.uid,
        fromEntryId: entryIds.out,
        toEntryId: entryIds.in,
        fromSeq: from.seq,
        toSeq: to.seq,
        createdAt: now,
      });
      auditInTransaction(db, tx, auditId, {
        action: "wallet.transfer",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        target: { type: "walletTransfer", id: transferId },
        reason: input.reason,
        before: { fromBalanceCents: fromBefore.balanceCents, toBalanceCents: toBefore.balanceCents },
        after: { fromBalanceCents: from.balanceCents, toBalanceCents: to.balanceCents, amountCents: input.amountCents, fromStudentId, toStudentId },
      });
      return { transferId, amountCents: input.amountCents, reason: input.reason, from, to };
    },
  );
}
