"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { api, errorText } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { useServerQuery } from "@/modules/orders/use-operations";
import { usePosSubmit } from "@/modules/pos/use-pos";
import type { PendencyView, ResolveResult, ReviewItemView } from "../online/pendencies";

type Message = { kind: "ok" | "error"; text: string };
type Review = { pendencies: PendencyView[]; reviews: ReviewItemView[] };
type Sweep = { checked: number; credited: number; reversals: number; reviews: number; closed: number; unchanged: number; lookupFailed: number; noCharge: number };

const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const CAUSE: Record<PendencyView["cause"], string> = { refund: "Reembolso", chargeback: "Contestação (chargeback)" };

/**
 * Revisão dos pagamentos online (F19), só administração: (1) pendências de reembolso/chargeback com crédito já consumido,
 * que bloqueiam novas compras da carteira até a regularização; (2) pagamentos recebidos com divergência (valor, conta…),
 * que NÃO foram creditados; (3) conciliação manual com o provedor. A regularização pede motivo e confere o valor que a tela
 * viu; o resultado exibido é o da RESPOSTA do servidor. Nada aqui lança crédito.
 */
export function PaymentsReview({ user }: { user: User }) {
  const review = useServerQuery<Review>(user, "/api/admin/payments", "");
  const submit = usePosSubmit(user);
  const [message, setMessage] = useState<Message | null>(null);
  const [open, setOpen] = useState<{ id: string; action: "recover" | "write_off" } | null>(null);
  const [reason, setReason] = useState("");
  const [sweeping, setSweeping] = useState(false);
  const locked = submit.busy || submit.uncertain || sweeping;

  async function resolve(p: PendencyView, action: "recover" | "write_off") {
    if (reason.trim().length < 10) return setMessage({ kind: "error", text: "Informe o motivo (mínimo de 10 caracteres)." });
    const result = await submit.submit<ResolveResult>(`/api/admin/payments/pendencies/${p.intentId}/resolve`, { action, expectedOutstandingCents: p.outstandingCents, reason: reason.trim() });
    if (!result) return;
    if (result.ok) {
      setMessage({ kind: "ok", text: action === "recover" ? `Regularizado: ${formatBRL(result.data.appliedCents)} debitados do saldo. ${result.data.status === "resolved" ? "A carteira foi liberada." : `Pendente: ${formatBRL(result.data.outstandingCents)}.`}` : `Valor absorvido pela escola: ${formatBRL(result.data.appliedCents)}.` });
      setOpen(null);
      setReason("");
    } else {
      setMessage({ kind: "error", text: errorText(result.error) });
    }
    review.reload();
  }

  async function reconcileNow(intentId?: string) {
    setSweeping(true);
    const r = await api<{ sweep?: Sweep; result?: { outcome: string } }>(user, "POST", "/api/admin/payments/reconcile", intentId ? { intentId } : {}, { timeoutMs: 120000 });
    setSweeping(false);
    if (r.ok) {
      const s = r.data.sweep;
      setMessage({ kind: "ok", text: s ? `Conciliação concluída: ${s.checked} consultadas, ${s.credited} creditadas, ${s.reversals} reversões, ${s.reviews} em revisão, ${s.lookupFailed} sem resposta do provedor.` : "Consulta concluída." });
    } else {
      setMessage({ kind: "error", text: errorText(r.error) });
    }
    review.reload();
  }

  if (review.status === "loading") return <p role="status" className="muted">Carregando…</p>;
  if (!review.data) return <p role="alert" className="notice notice-error">{errorText(review.errorCode ?? "internal")}</p>;
  const { pendencies, reviews } = review.data;

  return (
    <section>
      <h1>Pagamentos online</h1>
      <p className="muted">
        Pendências de reembolso e chargeback e pagamentos recebidos com divergência. O crédito normal acontece sozinho, pela confirmação do provedor; aqui ficam só os
        casos que pedem decisão.
      </p>
      <p>
        <button type="button" disabled={locked} onClick={() => void reconcileNow()}>
          {sweeping ? "Conciliando…" : "Conciliar com o provedor agora"}
        </button>
      </p>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid="payments-message">
          {message.text}
        </p>
      )}
      {submit.uncertain && <p role="alert" className="notice">Sem resposta do servidor. Repita a regularização para conferir: a mesma operação é reaproveitada, sem débito duplicado.</p>}

      <h2>Pendências abertas ({pendencies.length})</h2>
      {pendencies.length === 0 && <p className="muted">Nenhuma pendência aberta.</p>}
      <ul className="plain-list" data-testid="payments-pendencies">
        {pendencies.map((p) => (
          <li key={p.pendencyId} data-pendency={p.intentId}>
            <strong>{p.studentName}</strong> · {CAUSE[p.cause]} · em aberto <strong>{formatBRL(p.outstandingCents)}</strong> (de {formatBRL(p.openedCents)}) · saldo atual {formatBRL(p.walletBalanceCents)}
            {p.createdAt && <span className="muted"> · desde {timeFmt.format(new Date(p.createdAt))}</span>}
            <span className="muted"> · a carteira está bloqueada para novas compras</span>
            <div>
              <button type="button" className="secondary" disabled={locked || p.walletBalanceCents <= 0} onClick={() => setOpen({ id: p.intentId, action: "recover" })}>
                Descontar do saldo atual
              </button>{" "}
              <button type="button" className="secondary" disabled={locked} onClick={() => setOpen({ id: p.intentId, action: "write_off" })}>
                Absorver o valor
              </button>
            </div>
            {open?.id === p.intentId && (
              <div className="field" data-testid="payments-resolve">
                <p>
                  {open.action === "recover" ? `Será debitado do saldo o menor valor entre o saldo atual e ${formatBRL(p.outstandingCents)}, com novo lançamento no livro.` : `A escola absorve ${formatBRL(p.outstandingCents)}: nada é debitado do aluno e não há lançamento no livro.`}
                </p>
                <label htmlFor={`reason-${p.intentId}`}>Motivo</label>
                <input id={`reason-${p.intentId}`} type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoComplete="off" />{" "}
                <button type="button" disabled={locked} onClick={() => void resolve(p, open.action)}>
                  Confirmar
                </button>{" "}
                <button type="button" className="secondary" onClick={() => setOpen(null)}>
                  Cancelar
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <h2>Pagamentos em revisão ({reviews.length})</h2>
      {reviews.length === 0 && <p className="muted">Nenhum pagamento em revisão.</p>}
      <ul className="plain-list" data-testid="payments-reviews">
        {reviews.map((r) => (
          <li key={r.intentId} data-review={r.intentId}>
            <strong>{r.studentName}</strong> · {formatBRL(r.amountCents)} · {r.channel === "pix" ? "Pix" : "Cartão"} · {r.label}
            {r.createdAt && <span className="muted"> · {timeFmt.format(new Date(r.createdAt))}</span>}
            <span className="muted"> · nenhum crédito foi lançado</span>{" "}
            <button type="button" className="secondary" disabled={locked} onClick={() => void reconcileNow(r.intentId)}>
              Consultar de novo
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
