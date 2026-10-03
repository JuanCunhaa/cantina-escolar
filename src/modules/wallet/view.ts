import type { LedgerEntryView } from "./queries";

/**
 * Reconciliação no cliente. Três fontes entregam leituras da mesma carteira: a RESPOSTA confirmada de um comando, a
 * leitura autoritativa da API e o listener. Todas carregam a `version` definida no servidor (+1 por movimento do
 * livro); a tela adota uma leitura somente se a versão for MAIOR que a exibida, de modo que um snapshot atrasado ou uma
 * resposta repetida nunca fazem o saldo regredir. A chegada do listener não confirma nem desfaz comando algum: ela só
 * indica que a leitura em tempo real alcançou a versão exibida.
 */
export type ReadingSource = "command" | "read" | "listener";
export type WalletReading = { balanceCents: number; version: number; source: ReadingSource; fromCache?: boolean };

export type WalletView = {
  balanceCents: number;
  version: number;
  /** Maior versão entregue pelo listener a partir do servidor (não do cache local); -1 = ainda não entregou. */
  listenerVersion: number;
};

export function applyReading(current: WalletView | null, reading: WalletReading): WalletView {
  const fromServerListener = reading.source === "listener" && !reading.fromCache;
  const listenerVersion = Math.max(current?.listenerVersion ?? -1, fromServerListener ? reading.version : -1);
  if (current && reading.version <= current.version) return { ...current, listenerVersion };
  return { balanceCents: reading.balanceCents, version: reading.version, listenerVersion };
}

/** connecting: o listener ainda não entregou; updating: o saldo exibido é mais novo que o do listener; live: em dia. */
export type SyncState = "connecting" | "updating" | "live";
export function syncState(view: WalletView): SyncState {
  if (view.listenerVersion < 0) return "connecting";
  return view.listenerVersion < view.version ? "updating" : "live";
}

/** Une extratos por ID (movimentos são imutáveis), mais novo primeiro, limitado a `limit`. */
export function mergeEntries(current: readonly LedgerEntryView[], incoming: readonly LedgerEntryView[], limit = 20): LedgerEntryView[] {
  const byId = new Map<string, LedgerEntryView>();
  for (const entry of [...current, ...incoming]) {
    const known = byId.get(entry.id);
    byId.set(entry.id, known && known.createdAt && !entry.createdAt ? known : entry);
  }
  return [...byId.values()].sort((a, b) => b.seq - a.seq).slice(0, limit);
}
