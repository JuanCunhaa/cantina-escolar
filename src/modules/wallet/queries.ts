import type { Firestore, Timestamp } from "firebase-admin/firestore";
import type { Actor } from "@/modules/access/actor";
import { authorizeStudent } from "@/modules/access/authorize";
import { checkLedger, parseWalletState, type EntryType, type LedgerRow } from "./model";

export type LedgerEntryView = {
  id: string;
  seq: number;
  type: EntryType;
  amountCents: number;
  balanceAfterCents: number;
  counterpartStudentId: string | null;
  reason: string | null;
  createdAt: string | null;
};
export type WalletReading = { studentId: string; balanceCents: number; version: number; entries: LedgerEntryView[] };

const PAGE = 20;

function toEntry(id: string, d: FirebaseFirestore.DocumentData): LedgerEntryView {
  const createdAt = d.createdAt as Timestamp | undefined;
  return {
    id,
    seq: Number(d.seq),
    type: d.type as EntryType,
    amountCents: Number(d.amountCents),
    balanceAfterCents: Number(d.balanceAfterCents),
    counterpartStudentId: typeof d.counterpartStudentId === "string" ? d.counterpartStudentId : null,
    reason: typeof d.reason === "string" ? d.reason : null,
    createdAt: createdAt?.toDate().toISOString() ?? null,
  };
}

/**
 * Leitura autoritativa (servidor) de saldo, versão e últimos movimentos, num único snapshot transacional (saldo e
 * versão sempre coerentes com o extrato devolvido). Autoriza com vínculo/papel atuais. É o que a tela consulta quando
 * o resultado de um comando é incerto e na carga inicial, sem depender do listener.
 */
export async function readWallet(db: Firestore, actor: Actor, studentId: string): Promise<WalletReading> {
  return db.runTransaction(async (tx) => {
    await authorizeStudent(db, actor, studentId, "wallet.read", tx);
    const [wallet, entries] = await Promise.all([tx.get(db.doc(`wallets/${studentId}`)), tx.get(db.collection(`wallets/${studentId}/entries`).orderBy("seq", "desc").limit(PAGE))]);
    const state = parseWalletState(wallet.data());
    return { studentId, ...state, entries: entries.docs.map((doc) => toEntry(doc.id, doc.data())) };
  });
}

export type Reconciliation = { studentId: string; ok: boolean; balanceCents: number; version: number; ledgerSumCents: number; entryCount: number; problems: string[] };

/**
 * Reconciliação saldo projetado × livro de UMA carteira (O(n) em movimentos; para auditoria/operação, não para tela
 * de família). Lê tudo num snapshot e aplica `checkLedger`.
 */
export async function reconcileWallet(db: Firestore, studentId: string): Promise<Reconciliation> {
  return db.runTransaction(async (tx) => {
    const [wallet, entries] = await Promise.all([tx.get(db.doc(`wallets/${studentId}`)), tx.get(db.collection(`wallets/${studentId}/entries`).orderBy("seq", "asc"))]);
    const state = parseWalletState(wallet.data());
    const rows: LedgerRow[] = entries.docs.map((doc) => ({ seq: Number(doc.get("seq")), amountCents: Number(doc.get("amountCents")), balanceAfterCents: Number(doc.get("balanceAfterCents")) }));
    const problems = checkLedger(state, rows);
    return { studentId, ok: problems.length === 0, ...state, ledgerSumCents: rows.reduce((sum, r) => sum + r.amountCents, 0), entryCount: rows.length, problems };
  });
}
