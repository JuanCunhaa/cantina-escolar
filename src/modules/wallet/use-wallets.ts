"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { collection, doc, limit, onSnapshot, orderBy, query, type Timestamp } from "firebase/firestore";
import { api } from "@/lib/api-client";
import { getFirebaseClient } from "@/lib/firebase/client";
import type { LedgerEntryView, WalletReading as ServerReading } from "./queries";
import type { TransferResult } from "./commands";
import { applyReading, mergeEntries, syncState, type SyncState, type WalletReading, type WalletView } from "./view";

export type WalletSlot = { view: WalletView | null; entries: LedgerEntryView[]; sync: SyncState | "unknown"; listenerError: boolean; readError: boolean };
type Slot = { view: WalletView | null; entries: LedgerEntryView[]; listenerError: boolean; readError: boolean };

const EMPTY: Slot = { view: null, entries: [], listenerError: false, readError: false };

function entryFromDoc(id: string, d: Record<string, unknown>): LedgerEntryView {
  return {
    id,
    seq: Number(d.seq),
    type: d.type as LedgerEntryView["type"],
    amountCents: Number(d.amountCents),
    balanceAfterCents: Number(d.balanceAfterCents),
    counterpartStudentId: typeof d.counterpartStudentId === "string" ? d.counterpartStudentId : null,
    reason: typeof d.reason === "string" ? d.reason : null,
    createdAt: (d.createdAt as Timestamp | undefined)?.toDate().toISOString() ?? null,
  };
}

/**
 * Carteiras dos alunos informados. Cada carteira recebe leituras de três fontes — carga inicial pela API, listener
 * privado (documento da carteira e últimos movimentos, escopo do aluno vinculado) e resposta confirmada de comando —
 * reconciliadas por `version` (view.ts): dado antigo nunca faz o saldo regredir, e o listener não confirma operação.
 * Os listeners são encerrados ao trocar de conta/alunos e ao desmontar (logout desmonta a tela).
 */
export function useWallets(user: User, studentIds: readonly string[]) {
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const userRef = useRef(user);
  /** Geração da assinatura atual: respostas de leitura de uma geração anterior (conta/alunos trocados) são descartadas. */
  const epoch = useRef(0);
  useEffect(() => {
    userRef.current = user;
  }, [user]);
  const idsKey = [...studentIds].sort().join(",");
  const uid = user.uid;

  const update = useCallback((id: string, change: (slot: Slot) => Slot) => setSlots((all) => ({ ...all, [id]: change(all[id] ?? EMPTY) })), []);
  const feed = useCallback(
    (id: string, reading: WalletReading, entries: readonly LedgerEntryView[] = []) =>
      update(id, (slot) => ({ ...slot, view: applyReading(slot.view, reading), entries: mergeEntries(slot.entries, entries) })),
    [update],
  );

  /** Leitura autoritativa pelo servidor (carga inicial e conferência de resultado incerto). */
  const refresh = useCallback(
    async (id: string): Promise<boolean> => {
      const started = epoch.current;
      const result = await api<ServerReading>(userRef.current, "GET", `/api/wallets?studentId=${encodeURIComponent(id)}`, undefined, { timeoutMs: 15000 });
      if (started !== epoch.current) return false;
      if (!result.ok) {
        update(id, (slot) => ({ ...slot, readError: true }));
        return false;
      }
      const { balanceCents, version, entries } = result.data;
      update(id, (slot) => ({ ...slot, readError: false, view: applyReading(slot.view, { balanceCents, version, source: "read" }), entries: mergeEntries(slot.entries, entries) }));
      return true;
    },
    [update],
  );

  /** Resultado CONFIRMADO de uma transferência: aplica as duas pernas pela versão do servidor, sem esperar o listener. */
  const applyTransfer = useCallback(
    (result: TransferResult) => {
      for (const leg of [result.from, result.to]) {
        const counterpart = leg === result.from ? result.to.studentId : result.from.studentId;
        feed(
          leg.studentId,
          { balanceCents: leg.balanceCents, version: leg.version, source: "command" },
          [{ id: leg.entryId, seq: leg.seq, type: leg === result.from ? "transfer_out" : "transfer_in", amountCents: leg.amountCents, balanceAfterCents: leg.balanceCents, counterpartStudentId: counterpart, reason: result.reason, createdAt: null }],
        );
      }
    },
    [feed],
  );

  useEffect(() => {
    epoch.current += 1;
    const ids = idsKey ? idsKey.split(",") : [];
    const { db } = getFirebaseClient();
    const stops: (() => void)[] = [];
    for (const id of ids) {
      void refresh(id);
      stops.push(
        onSnapshot(
          doc(db, "wallets", id),
          (snap) => {
            const balanceCents = snap.exists() ? Number(snap.get("balanceCents")) : 0;
            const version = snap.exists() ? Number(snap.get("version")) : 0;
            feed(id, { balanceCents, version, source: "listener", fromCache: snap.metadata.fromCache });
            update(id, (slot) => (slot.listenerError ? { ...slot, listenerError: false } : slot));
          },
          () => update(id, (slot) => ({ ...slot, listenerError: true })),
        ),
        onSnapshot(
          query(collection(db, "wallets", id, "entries"), orderBy("seq", "desc"), limit(20)),
          // Movimentos são imutáveis: união por ID, sem tocar no saldo/versão exibidos.
          (snap) => update(id, (slot) => ({ ...slot, entries: mergeEntries(slot.entries, snap.docs.map((d) => entryFromDoc(d.id, d.data()))) })),
          () => update(id, (slot) => ({ ...slot, listenerError: true })),
        ),
      );
    }
    return () => {
      epoch.current += 1;
      for (const stop of stops) stop();
      setSlots({});
    };
  }, [uid, idsKey, refresh, feed, update]);

  const result = useMemo(() => {
    const out: Record<string, WalletSlot> = {};
    for (const id of idsKey ? idsKey.split(",") : []) {
      const slot = slots[id] ?? EMPTY;
      out[id] = { ...slot, sync: slot.view ? syncState(slot.view) : "unknown" };
    }
    return out;
  }, [slots, idsKey]);

  return { wallets: result, refresh, applyTransfer };
}
