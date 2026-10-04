import { Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import { z } from "zod";
import { invalid } from "@/lib/domain-error";
import { addDays, isLocalDate, localInstant } from "@/lib/dates/school-time";
import type { Actor } from "@/modules/access/actor";
import { authorizeStudent } from "@/modules/access/authorize";
import { checkLedger, ENTRY_TYPES, parseWalletState, type EntryType, type LedgerRow } from "./model";

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

/* ------------------------------------------------------------------------------ extrato paginado (F12) */

export type StatementEntry = LedgerEntryView & { orderId: string | null };
export type StatementPage = { studentId: string; entries: StatementEntry[]; nextCursor: string | null };

const statementSchema = z
  .object({
    studentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    type: z.enum(ENTRY_TYPES).optional(),
    from: z.string().refine(isLocalDate).optional(),
    to: z.string().refine(isLocalDate).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "Período invertido." });
const seqCursor = z.object({ q: z.number().int() }).strict();
const dateCursor = z.object({ s: z.number().int(), n: z.number().int().min(0).max(999_999_999), q: z.number().int() }).strict();

/**
 * Extrato (livro) por página, mais novo primeiro. Sem período a ordem é `seq desc` (contíguo e sempre presente: nenhum
 * movimento fica de fora do extrato); com período a ordem é `createdAt desc, seq desc` (seq desempata movimentos gravados
 * no mesmo instante, p. ex. várias datas de um lote). Cursor opaco = último (seq) ou (segundos, nanos, seq) devolvido.
 * Período em datas locais de São Paulo (fim exclusivo no dia seguinte). Autorização atual por `wallet.read`.
 */
export async function listStatement(db: Firestore, actor: Actor, raw: unknown): Promise<StatementPage> {
  const f = statementSchema.parse(raw);
  await authorizeStudent(db, actor, f.studentId, "wallet.read");
  const byDate = Boolean(f.from || f.to);
  let cursor: z.infer<typeof seqCursor> | z.infer<typeof dateCursor> | null = null;
  if (f.cursor) {
    try {
      cursor = (byDate ? dateCursor : seqCursor).parse(JSON.parse(Buffer.from(f.cursor, "base64url").toString("utf8")));
    } catch {
      throw invalid("invalid_cursor", "Cursor inválido.");
    }
  }
  let q: Query = db.collection(`wallets/${f.studentId}/entries`);
  if (f.type) q = q.where("type", "==", f.type);
  if (f.from) q = q.where("createdAt", ">=", Timestamp.fromDate(localInstant(f.from, "00:00")));
  if (f.to) q = q.where("createdAt", "<", Timestamp.fromDate(localInstant(addDays(f.to, 1), "00:00")));
  q = byDate ? q.orderBy("createdAt", "desc").orderBy("seq", "desc") : q.orderBy("seq", "desc");
  if (cursor) q = byDate ? q.startAfter(new Timestamp((cursor as z.infer<typeof dateCursor>).s, (cursor as z.infer<typeof dateCursor>).n), cursor.q) : q.startAfter(cursor.q);
  const docs = (await q.limit(f.limit + 1).get()).docs;
  const slice = docs.slice(0, f.limit);
  const last = slice[slice.length - 1];
  const lastAt = last?.get("createdAt") as Timestamp | undefined;
  return {
    studentId: f.studentId,
    entries: slice.map((doc) => ({ ...toEntry(doc.id, doc.data()), orderId: typeof doc.get("orderId") === "string" ? String(doc.get("orderId")) : null })),
    nextCursor:
      docs.length > f.limit && last && (!byDate || lastAt)
        ? Buffer.from(JSON.stringify(byDate ? { s: lastAt!.seconds, n: lastAt!.nanoseconds, q: Number(last.get("seq")) } : { q: Number(last.get("seq")) })).toString("base64url")
        : null,
  };
}
