import { z } from "zod";
import { conflict } from "@/lib/domain-error";

/**
 * Carteira individual (F08): `wallets/{studentId}` guarda o saldo PROJETADO em centavos e a `version`, que é a ordem
 * monotônica definida no servidor: cada movimento do livro soma 1 e grava o mesmo número em `entries/{id}.seq`. Quem lê
 * (resposta de comando, leitura da API ou listener) compara `version` — nunca a hora de chegada — para decidir qual
 * leitura é mais nova. Regras puras, sem Firebase.
 */
export const MAX_TRANSFER_CENTS = 500_000; // R$ 5.000,00 por operação
export const MAX_BALANCE_CENTS = 100_000_000; // R$ 1.000.000,00: teto de sanidade do saldo (inteiro seguro com folga)

export const ENTRY_TYPES = ["topup", "advance_purchase", "counter_purchase", "order_refund", "transfer_out", "transfer_in", "adjustment"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const transferSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    fromStudentId: z.string().regex(ID),
    toStudentId: z.string().regex(ID),
    amountCents: z.number().int().min(1).max(MAX_TRANSFER_CENTS),
    reason: z.string().trim().min(3).max(140).default("Transferência entre alunos"),
  })
  .refine((v) => v.fromStudentId !== v.toStudentId, { message: "Origem e destino iguais." });
export type TransferInput = z.infer<typeof transferSchema>;

export type WalletState = { balanceCents: number; version: number };

/** Documento inexistente = carteira ainda sem movimento (saldo 0, versão 0). Valor corrompido nunca é "corrigido" em silêncio. */
export function parseWalletState(data: Record<string, unknown> | undefined): WalletState {
  if (!data) return { balanceCents: 0, version: 0 };
  const { balanceCents, version } = data;
  if (!Number.isSafeInteger(balanceCents) || (balanceCents as number) < 0 || !Number.isSafeInteger(version) || (version as number) < 0) {
    throw new Error("Carteira corrompida.");
  }
  return { balanceCents: balanceCents as number, version: version as number };
}

/** Resultado de aplicar um valor assinado (centavos) a uma carteira: novo saldo e seq do movimento. */
export function applyDelta(state: WalletState, deltaCents: number): WalletState {
  const balanceCents = state.balanceCents + deltaCents;
  if (!Number.isSafeInteger(balanceCents)) throw new Error("Saldo fora do limite seguro.");
  if (balanceCents < 0) throw conflict("insufficient_balance", "Saldo insuficiente.");
  if (balanceCents > MAX_BALANCE_CENTS) throw conflict("balance_limit", "Saldo acima do limite da carteira.");
  return { balanceCents, version: state.version + 1 };
}

export type TransferPlan = { from: WalletState; to: WalletState };

/** Duas pernas: débito na origem, crédito no destino; a soma dos saldos não muda. */
export function planTransfer(from: WalletState, to: WalletState, amountCents: number): TransferPlan {
  return { from: applyDelta(from, -amountCents), to: applyDelta(to, amountCents) };
}

export type LedgerRow = { seq: number; amountCents: number; balanceAfterCents: number };

/**
 * Reconcilia saldo projetado × livro: seq contíguo 1..n, saldo após cada movimento coerente e total do livro igual ao
 * saldo. `entries` em ordem crescente de seq. Devolve os problemas encontrados (vazio = reconciliado).
 */
export function checkLedger(wallet: WalletState, entries: readonly LedgerRow[]): string[] {
  const problems: string[] = [];
  let running = 0;
  entries.forEach((entry, index) => {
    if (entry.seq !== index + 1) problems.push(`seq ${entry.seq} fora de ordem (esperado ${index + 1})`);
    running += entry.amountCents;
    if (entry.balanceAfterCents !== running) problems.push(`seq ${entry.seq}: saldo após ${entry.balanceAfterCents} ≠ acumulado ${running}`);
    if (running < 0) problems.push(`seq ${entry.seq}: saldo negativo no livro`);
  });
  if (wallet.version !== entries.length) problems.push(`versão ${wallet.version} ≠ ${entries.length} movimentos`);
  if (wallet.balanceCents !== running) problems.push(`saldo ${wallet.balanceCents} ≠ soma do livro ${running}`);
  return problems;
}
