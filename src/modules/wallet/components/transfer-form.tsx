"use client";

import { useRef, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { parseBRLToCents } from "@/lib/money/parse";
import type { FamilyStudent } from "@/modules/guardians/use-family-students";
import type { TransferResult } from "../commands";
import { executeWithRetry } from "../operation";
import type { WalletSlot } from "../use-wallets";

type Op =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "confirmed"; result: TransferResult; replayed: boolean }
  | { phase: "refused"; text: string }
  | { phase: "uncertain" };

/**
 * Transferência entre dois alunos do responsável. O sucesso só aparece depois da resposta confirmada do servidor. Sem
 * resposta definitiva (rede, tempo esgotado, erro transitório) a operação fica INCERTA — nunca "falhou": ela é repetida
 * com a MESMA chave (idempotência do servidor) e o formulário trava até a conferência, para que uma segunda tentativa
 * nunca seja uma transferência nova.
 */
export function TransferForm({
  user,
  students,
  wallets,
  onConfirmed,
  refresh,
}: {
  user: User;
  students: FamilyStudent[];
  wallets: Record<string, WalletSlot>;
  onConfirmed: (result: TransferResult) => void;
  refresh: (studentId: string) => Promise<boolean>;
}) {
  const [from, setFrom] = useState(students[0]?.id ?? "");
  const [to, setTo] = useState(students[1]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [op, setOp] = useState<Op>({ phase: "idle" });
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const names = new Map(students.map((s) => [s.id, s.name]));
  const locked = op.phase === "pending" || op.phase === "uncertain";

  async function send() {
    if (inFlight.current) return;
    const cents = parseBRLToCents(amount);
    if (cents === null) return setOp({ phase: "refused", text: "Informe um valor em reais maior que zero (exemplo: 12,50)." });
    if (!from || !to || from === to) return setOp({ phase: "refused", text: "Escolha dois alunos diferentes." });
    const sig = `${from}|${to}|${cents}`;
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: newKey() };
    const key = attempt.current.key;
    inFlight.current = true;
    setOp({ phase: "pending" });
    const outcome = await executeWithRetry(() => api<TransferResult & { replayed: boolean }>(user, "POST", "/api/wallets/transfer", { key, fromStudentId: from, toStudentId: to, amountCents: cents }, { timeoutMs: 15000 }));
    inFlight.current = false;
    if (outcome.phase === "confirmed") {
      attempt.current = null;
      onConfirmed(outcome.data);
      setAmount("");
      setOp({ phase: "confirmed", result: outcome.data, replayed: outcome.data.replayed });
    } else if (outcome.phase === "refused") {
      attempt.current = null;
      setOp({ phase: "refused", text: errorText(outcome.error) });
    } else {
      setOp({ phase: "uncertain" });
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  const syncing = op.phase === "confirmed" && [op.result.from.studentId, op.result.to.studentId].some((id) => wallets[id]?.sync !== "live");

  return (
    <form onSubmit={submit} aria-labelledby="transfer-title" data-testid="transfer-form">
      <h2 id="transfer-title">Transferir entre carteiras</h2>
      <p className="muted">Move saldo disponível de um aluno para outro. O total não muda e não há taxa.</p>
      <fieldset disabled={locked} className="form-grid">
        <div className="field">
          <label htmlFor="transfer-from">De</label>
          <select id="transfer-from" value={from} onChange={(e) => setFrom(e.target.value)}>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="transfer-to">Para</label>
          <select id="transfer-to" value={to} onChange={(e) => setTo(e.target.value)}>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="transfer-amount">Valor (R$)</label>
          <input id="transfer-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
        </div>
      </fieldset>
      {op.phase !== "uncertain" && (
        <button type="submit" disabled={locked}>
          {op.phase === "pending" ? "Aguardando confirmação do servidor…" : "Transferir"}
        </button>
      )}
      {op.phase === "pending" && (
        <p role="status" data-testid="transfer-status" data-phase="pending" className="notice">
          Enviado. O resultado só é mostrado depois da confirmação do servidor.
        </p>
      )}
      {op.phase === "uncertain" && (
        <div role="status" data-testid="transfer-status" data-phase="uncertain" className="notice">
          <p>
            Ainda não sabemos se a transferência de {formatBRL(parseBRLToCents(amount) ?? 0)} de {names.get(from)} para {names.get(to)} foi concluída. Nada foi repetido como uma transferência nova: ao verificar, a mesma operação é consultada e
            não será feita duas vezes.
          </p>
          <button type="button" onClick={() => void send()}>
            Verificar resultado
          </button>{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void refresh(from);
              void refresh(to);
            }}
          >
            Conferir os saldos
          </button>{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              attempt.current = null;
              setOp({ phase: "idle" });
            }}
          >
            Abandonar esta operação
          </button>
        </div>
      )}
      {op.phase === "confirmed" && (
        <p role="status" data-testid="transfer-status" data-phase="confirmed" data-syncing={syncing} className="notice">
          Transferência confirmada pelo servidor: {formatBRL(op.result.amountCents)} de {names.get(op.result.from.studentId) ?? "aluno"} para {names.get(op.result.to.studentId) ?? "aluno"}.
          {op.replayed ? " (A operação já tinha sido concluída antes; nada foi repetido.)" : ""}
          {syncing ? " Atualizando a leitura em tempo real…" : ""}
        </p>
      )}
      {op.phase === "refused" && (
        <p role="alert" data-testid="transfer-status" data-phase="refused" className="notice notice-error">
          {op.text}
        </p>
      )}
    </form>
  );
}
