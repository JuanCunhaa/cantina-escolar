import { Timestamp } from "firebase-admin/firestore";
import type { LocalDate } from "@/lib/dates/school-time";
import type { Closing, CashLineReceipt, CashPoint, MethodTotals, ReviewStatus, SessionStatus } from "./cash-model";
import type { WalletConsumption } from "./cash-store";

/** Documento `cashSessions/{data}__{ponto}__{uid}` (só servidor; Rules fecham ao cliente). Uma sessão por operador, ponto e data. */
export type ClosureDoc = Omit<Closing, "hasDivergence"> & {
  no: number;
  hasDivergence: boolean;
  closedAtIso: string | null;
  walletConsumption: WalletConsumption;
  note: string | null;
  closedByName: string;
};
export type ReviewDoc = { status: ReviewStatus; closureNo: number; note: string | null; byName: string | null; atIso: string | null; selfReview: boolean };
export type SessionDoc = {
  sessionId: string;
  date: LocalDate;
  point: CashPoint;
  operator: { uid: string; role: string | null; name: string };
  status: SessionStatus;
  openingCents: number;
  openedAtIso: string | null;
  closureNo: number;
  reopenCount: number;
  closure: ClosureDoc | null;
  review: ReviewDoc | null;
  version: number;
};

type Data = Record<string, unknown>;
const int = (v: unknown): number => (Number.isSafeInteger(v) ? (v as number) : 0);
const iso = (v: unknown): string | null => (v instanceof Timestamp ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

function parseClosure(d: Data | null | undefined): ClosureDoc | null {
  if (!d) return null;
  return {
    no: int(d.no),
    closedAtIso: iso(d.closedAt),
    byMethod: (d.byMethod as MethodTotals[]) ?? [],
    expectedCashCents: int(d.expectedCashCents),
    countedCashCents: int(d.countedCashCents),
    cashDifferenceCents: int(d.cashDifferenceCents),
    declared: (d.declared as Closing["declared"]) ?? {},
    largestDifferenceCents: int(d.largestDifferenceCents),
    hasDivergence: d.hasDivergence === true,
    receiptCount: int(d.receiptCount),
    walletConsumption: (d.walletConsumption as WalletConsumption) ?? { orderCount: 0, totalCents: 0 },
    note: typeof d.note === "string" ? d.note : null,
    closedByName: String((d.closedBy as { name?: string } | undefined)?.name ?? ""),
  };
}

export function parseSession(id: string, d: Data): SessionDoc {
  const operator = (d.operator ?? {}) as { uid?: string; role?: string | null; name?: string };
  const opening = (d.opening ?? {}) as { cents?: number; confirmedAt?: unknown };
  const review = d.review as Data | null | undefined;
  return {
    sessionId: id,
    date: String(d.date ?? ""),
    point: d.point as CashPoint,
    operator: { uid: String(operator.uid ?? ""), role: operator.role ?? null, name: String(operator.name ?? "") },
    status: d.status as SessionStatus,
    openingCents: int(opening.cents),
    openedAtIso: iso(opening.confirmedAt),
    closureNo: int(d.closureNo),
    reopenCount: int(d.reopenCount),
    closure: parseClosure(d.closure as Data | null),
    review: review
      ? { status: review.status as ReviewStatus, closureNo: int(review.closureNo), note: typeof review.note === "string" ? review.note : null, byName: typeof review.byName === "string" ? review.byName : null, atIso: iso(review.at), selfReview: review.selfReview === true }
      : null,
    version: int(d.version),
  };
}

/** Linhas guardadas em cada versão do fechamento (base para identificar movimentos posteriores). */
export type ClosureLines = { no: number; lines: CashLineReceipt[] };
