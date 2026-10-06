"use client";

import type { User } from "firebase/auth";
import { formatBRL } from "@/lib/money/format";
import { useFamilyStudents } from "@/modules/guardians/use-family-students";
import { useWallets, type WalletSlot } from "../use-wallets";
import type { LedgerEntryView } from "../queries";
import { TransferForm } from "./transfer-form";

const TYPE_LABEL: Record<LedgerEntryView["type"], string> = {
  topup: "Recarga",
  topup_reversal: "Estorno de recarga",
  advance_purchase: "Compra antecipada",
  counter_purchase: "Compra no balcão",
  order_refund: "Reembolso de pedido",
  order_exchange: "Troca de produto (diferença)",
  transfer_out: "Transferência enviada",
  transfer_in: "Transferência recebida",
  adjustment: "Ajuste",
};

/** Texto do estado da leitura em tempo real; nunca sugere falha de uma operação já confirmada pelo servidor. */
function readingText(slot: WalletSlot | undefined): string {
  if (!slot || slot.sync === "unknown") return slot?.readError ? "Não foi possível consultar o saldo agora." : "Consultando o saldo…";
  if (slot.listenerError) return "Saldo confirmado pelo servidor; a atualização em tempo real está indisponível.";
  if (slot.sync === "updating") return "Saldo confirmado pelo servidor. Atualizando a leitura em tempo real…";
  if (slot.sync === "connecting") return "Saldo consultado no servidor. Conectando à atualização em tempo real…";
  return "Atualizado.";
}

/**
 * Carteira por aluno do responsável: saldo individual e total consolidado, extrato (livro) e transferência entre os
 * alunos vinculados. Saldo e extrato chegam por carga inicial + listener privado e são reconciliados por versão do
 * servidor; o resultado de uma operação aparece a partir da resposta confirmada, sem depender do listener.
 */
export function FamilyWallet({ user }: { user: User }) {
  const family = useFamilyStudents(user.uid);
  const students = family.students;
  const { wallets, refresh, applyTransfer } = useWallets(user, students.map((s) => s.id));
  const names = new Map(students.map((s) => [s.id, s.name]));
  const known = students.map((s) => wallets[s.id]?.view).filter((view) => view != null);
  const total = known.reduce((sum, view) => sum + view.balanceCents, 0);

  return (
    <section>
      <h1>Carteira</h1>
      <p className="muted">Cada aluno tem a própria carteira: uma compra de um aluno nunca desconta o saldo de outro.</p>
      {family.status === "loading" && <p role="status">Carregando…</p>}
      {family.status === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar os alunos. Verifique a conexão.
        </p>
      )}
      {family.status === "ready" && students.length === 0 && <p>Nenhum aluno vinculado à sua conta ainda.</p>}
      {students.length > 0 && (
        <p data-testid="wallet-total">
          Total dos alunos: <strong>{known.length === students.length ? formatBRL(total) : "calculando…"}</strong>
        </p>
      )}
      <ul className="plain-list">
        {students.map((s) => {
          const slot = wallets[s.id];
          return (
            <li key={s.id} className="student-block" data-testid="wallet-student" data-student={s.id}>
              <h2>{s.name}</h2>
              <p>
                Saldo: <strong data-testid="wallet-balance">{slot?.view ? formatBRL(slot.view.balanceCents) : "…"}</strong>
              </p>
              <p className="muted" role="status" data-testid="wallet-reading" data-sync={slot?.sync ?? "unknown"}>
                {readingText(slot)}
              </p>
              {slot?.sync !== "live" && slot?.readError && (
                <button type="button" className="secondary" onClick={() => void refresh(s.id)}>
                  Consultar de novo
                </button>
              )}
              <details>
                <summary>Extrato</summary>
                {slot && slot.entries.length > 0 ? (
                  <div className="table-scroll">
                    <table className="data-table" data-testid="wallet-entries">
                      <caption className="visually-hidden">Últimos movimentos de {s.name}</caption>
                      <thead>
                        <tr>
                          <th scope="col">Movimento</th>
                          <th scope="col">Com</th>
                          <th scope="col">Valor</th>
                          <th scope="col">Saldo após</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slot.entries.map((entry) => (
                          <tr key={entry.id}>
                            <td>{TYPE_LABEL[entry.type] ?? "Movimento"}</td>
                            <td>{entry.counterpartStudentId ? (names.get(entry.counterpartStudentId) ?? "Outro aluno") : "—"}</td>
                            <td>{formatBRL(entry.amountCents)}</td>
                            <td>{formatBRL(entry.balanceAfterCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">Nenhum movimento ainda.</p>
                )}
              </details>
            </li>
          );
        })}
      </ul>
      {students.length >= 2 && <TransferForm user={user} students={students.filter((s) => s.status === "active")} wallets={wallets} onConfirmed={applyTransfer} refresh={refresh} />}
      {students.length === 1 && <p className="muted">A transferência entre carteiras exige dois alunos vinculados à sua conta.</p>}
    </section>
  );
}
