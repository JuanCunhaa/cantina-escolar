"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { parseBRLToCents } from "@/lib/money/parse";
import { can } from "@/modules/access/permissions";
import type { Role } from "@/modules/access/roles";
import { clockLabel, dayMonth } from "@/modules/menu/format";
import { useServerQuery } from "@/modules/orders/use-operations";
import { usePosSubmit } from "@/modules/pos/use-pos";
import { isUncertain } from "@/modules/wallet/operation";
import { PAYMENT_LABEL } from "../methods";
import type { ReversalResult } from "../topup-commands";
import { REVERSAL_LABEL, REVERSAL_REASONS, type ReversalReason } from "../topup-model";
import type { TopupStudent, TopupView } from "../topup-queries";
import { settlementText, statusText } from "./topup-text";

type Props = { user: User; role: Role; permissions: readonly string[]; topupId: string };

const FEE_TEXT = { none: "Sem taxa (dinheiro)", informed: "Informada pelo operador", confirmed: "Conferida pela administração", pending: "A conferir" } as const;

/**
 * Comprovante interno (imprimível) e estorno. O estorno exige a permissão SEPARADA `topup.reverse`, motivo e valor até o
 * restante estornável e o saldo atual; o servidor confere tudo de novo. O resultado vem da resposta; a tela relê o comprovante.
 */
export function TopupReceipt({ user, role, permissions, topupId }: Props) {
  const receipt = useServerQuery<TopupView>(user, `/api/topups/${topupId}`, "");
  const t = receipt.data && receipt.data.topupId === topupId ? receipt.data : null;
  const mayReverse = can({ role, permissions }, "topup.reverse");
  const studentQuery = useServerQuery<TopupStudent>(user, "/api/topups/students", `id=${t?.student.id ?? ""}`, Boolean(t) && mayReverse);
  const [open, setOpen] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [reasonCode, setReasonCode] = useState<ReversalReason>("registration_error");
  const [reason, setReason] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const submit = usePosSubmit(user);
  const locked = submit.busy || submit.uncertain;
  const messageRef = useRef<HTMLParagraphElement>(null);
  const [seenReversed, setSeenReversed] = useState<number | null>(null);

  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  if (receipt.status === "loading") return <p className="muted">Carregando comprovante…</p>;
  if (!t) return <p role="alert" className="notice notice-error">{errorText(receipt.errorCode ?? "internal")}</p>;

  const balance = studentQuery.data?.student.id === t.student.id ? studentQuery.data.wallet.balanceCents : null;
  const maxNow = balance === null ? t.reversibleCents : Math.min(balance, t.reversibleCents);
  const amount = parseBRLToCents(amountText);
  const amountOk = amount !== null && amount <= maxNow;
  const reasonOk = reason.trim().length >= 10;
  // O estornado que a tela mostrou ao abrir a revisão vai junto: se mudou no meio, o servidor recusa (sem estorno duplicado).
  const expectedReversed = seenReversed ?? t.reversedCents;

  async function confirm() {
    if (!t || amount === null) return;
    setMessage(null);
    const result = await submit.submit<ReversalResult & { replayed: boolean }>(`/api/topups/${t.topupId}/reverse`, { amountCents: amount, reasonCode, reason: reason.trim(), expectedReversedCents: expectedReversed });
    if (!result) return;
    if (result.ok) {
      setMessage({ kind: "ok", text: `Estorno de ${formatBRL(result.data.amountCents)} registrado. Saldo do aluno agora: ${formatBRL(result.data.wallet.balanceCents)}.` });
      setOpen(false);
      setReviewing(false);
      setAmountText("");
      setReason("");
      setSeenReversed(null);
    } else if (!isUncertain(result)) {
      const d = result.details;
      setMessage({ kind: "error", text: result.error === "insufficient_balance" && typeof d?.maxNowCents === "number" ? `O crédito já foi usado: o saldo atual (${formatBRL(Number(d.balanceCents ?? 0))}) só permite estornar até ${formatBRL(d.maxNowCents)} agora.` : errorText(result.error) });
      setReviewing(false);
      setSeenReversed(null);
    }
    receipt.reload();
    studentQuery.reload();
  }

  return (
    <article className="topup-receipt" aria-labelledby="topup-receipt-title" data-testid="topup-receipt">
      <p className="no-print">
        <Link href="/operacao/recebimentos">← Recebimentos</Link>
      </p>
      <h1 id="topup-receipt-title">Comprovante interno de recarga</h1>
      <p className="muted">Documento interno da cantina. Não é nota fiscal.</p>
      <dl className="receipt-grid">
        <dt>Aluno</dt>
        <dd data-testid="receipt-student">
          <strong>{t.student.name}</strong> · matrícula {t.student.enrollment}
        </dd>
        <dt>Valor recebido</dt>
        <dd>{formatBRL(t.amountCents)}</dd>
        <dt>Creditado na carteira</dt>
        <dd data-testid="receipt-credited">
          <strong>{formatBRL(t.creditedCents)}</strong>
        </dd>
        <dt>Forma</dt>
        <dd>{PAYMENT_LABEL[t.method]}</dd>
        <dt>Taxa</dt>
        <dd data-testid="receipt-fee">
          {t.fee.cents === null ? FEE_TEXT.pending : formatBRL(t.fee.cents)} · {FEE_TEXT[t.fee.status]}
        </dd>
        <dt>Líquido para a cantina</dt>
        <dd data-testid="receipt-net">{t.netCents === null ? "a conferir (taxa pendente)" : formatBRL(t.netCents)}</dd>
        <dt>Liquidação</dt>
        <dd>{settlementText(t.settlement)}</dd>
        <dt>Referência</dt>
        <dd>{t.reference ?? "—"}</dd>
        {t.payerName && (
          <>
            <dt>Quem pagou</dt>
            <dd>{t.payerName}</dd>
          </>
        )}
        {t.note && (
          <>
            <dt>Conferência</dt>
            <dd>{t.note}</dd>
          </>
        )}
        <dt>Data</dt>
        <dd>
          {dayMonth(t.receivedOn)}/{t.receivedOn.slice(0, 4)}
          {t.receivedAt ? ` às ${clockLabel(t.receivedAt)}` : ""}
        </dd>
        <dt>Operador</dt>
        <dd>{t.operatorName}</dd>
        <dt>Situação</dt>
        <dd data-testid="receipt-status">{statusText(t)}</dd>
        <dt>Código</dt>
        <dd>
          <code>{t.topupId}</code>
        </dd>
      </dl>

      {t.reversals.length > 0 && (
        <section aria-labelledby="receipt-reversals-title">
          <h2 id="receipt-reversals-title">Estornos</h2>
          <table className="data-table stock-table" data-testid="receipt-reversals">
            <caption className="visually-hidden">Estornos desta recarga</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col" className="checkout-amount">Valor</th>
                <th scope="col">Motivo</th>
                <th scope="col">Operador</th>
              </tr>
            </thead>
            <tbody>
              {t.reversals.map((r) => (
                <tr key={r.reversalId}>
                  <td data-label="Data">
                    {dayMonth(r.createdOn)}
                    {r.createdAt ? ` ${clockLabel(r.createdAt)}` : ""}
                  </td>
                  <td className="checkout-amount" data-label="Valor">−{formatBRL(r.amountCents)}</td>
                  <td data-label="Motivo">
                    {REVERSAL_LABEL[r.reasonCode]}: {r.reason}
                    {r.referenceReleased ? " (referência liberada para novo lançamento)" : ""}
                  </td>
                  <td data-label="Operador">{r.operatorName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Ainda estornável: {formatBRL(t.reversibleCents)}</p>
        </section>
      )}

      {message && (
        <p ref={messageRef} tabIndex={-1} role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid="receipt-message">
          {message.text}
        </p>
      )}

      <div className="checkout-actions no-print">
        <button type="button" className="secondary" onClick={() => window.print()}>
          Imprimir comprovante
        </button>
        {mayReverse && t.reversibleCents > 0 && !open && (
          <button type="button" className="secondary" onClick={() => setOpen(true)} data-testid="receipt-reverse-open">
            Estornar recarga
          </button>
        )}
      </div>
      {!mayReverse && <p className="muted no-print">Estorno só com permissão específica (administração).</p>}

      {mayReverse && open && (
        <section className="pos-direct no-print" aria-labelledby="reverse-title" data-testid="receipt-reverse">
          <h2 id="reverse-title">{reviewing ? "Revisar estorno" : "Estornar recarga"}</h2>
          <p>
            O estorno é um novo lançamento negativo na carteira do aluno; o recebimento original continua no histórico. Estornável agora: <strong data-testid="reverse-max">{formatBRL(maxNow)}</strong>
            {balance !== null && balance < t.reversibleCents ? ` (o saldo atual é ${formatBRL(balance)}: parte do crédito já foi usada)` : ""}.
          </p>
          {!reviewing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (amountOk && reasonOk) {
                  setSeenReversed(t.reversedCents);
                  setReviewing(true);
                }
              }}
            >
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="reverse-amount">Valor do estorno (R$)</label>
                  <input id="reverse-amount" type="text" inputMode="decimal" value={amountText} disabled={locked} onChange={(e) => setAmountText(e.target.value)} data-testid="reverse-amount" />
                </div>
                <div className="field">
                  <label htmlFor="reverse-code">Tipo</label>
                  <select id="reverse-code" value={reasonCode} disabled={locked} onChange={(e) => setReasonCode(e.target.value as ReversalReason)}>
                    {REVERSAL_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {REVERSAL_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="reverse-reason">Motivo (mínimo 10 caracteres)</label>
                <input id="reverse-reason" type="text" maxLength={200} value={reason} disabled={locked} onChange={(e) => setReason(e.target.value)} data-testid="reverse-reason" />
              </div>
              {amountText.trim() !== "" && !amountOk && <p role="alert" className="notice notice-error">Informe um valor de até {formatBRL(maxNow)}.</p>}
              <div className="checkout-actions">
                <button type="submit" disabled={!amountOk || !reasonOk || locked} data-testid="reverse-review">
                  Revisar estorno
                </button>
                <button type="button" className="secondary" disabled={locked} onClick={() => setOpen(false)}>
                  Cancelar
                </button>
              </div>
            </form>
          ) : (
            <div>
              <p data-testid="reverse-summary">
                Estornar <strong>{formatBRL(amount ?? 0)}</strong> da carteira de {t.student.name} ({REVERSAL_LABEL[reasonCode].toLowerCase()}): “{reason.trim()}”.
                {reasonCode === "registration_error" && amount === t.reversibleCents && t.reference ? " A referência fica liberada para um novo lançamento correto." : ""}
              </p>
              <div className="checkout-actions">
                <button type="button" disabled={submit.busy} aria-busy={submit.busy} onClick={() => void confirm()} data-testid="reverse-confirm">
                  {submit.uncertain ? "Tentar novamente o mesmo estorno" : `Confirmar estorno de ${formatBRL(amount ?? 0)}`}
                </button>
                <button type="button" className="secondary" disabled={locked} onClick={() => setReviewing(false)}>
                  Voltar
                </button>
              </div>
              {submit.uncertain && <p role="alert" className="notice notice-error">Sem resposta do servidor. O estorno pode ter sido registrado: use “Tentar novamente o mesmo estorno” (não estorna duas vezes).</p>}
            </div>
          )}
        </section>
      )}
    </article>
  );
}
