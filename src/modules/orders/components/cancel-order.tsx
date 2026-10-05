"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { formatBRL } from "@/lib/money/format";
import { refundValueOf } from "../fulfillment-model";
import type { OrderDetail } from "../history-model";
import { useOrderCommand, type CommandMessage } from "../use-operations";
import { toQty } from "./qty";

const REASONS = ["Mudança de planos", "O aluno não vai à escola nesse dia", "Pedido feito por engano", "Outro motivo"] as const;
const OTHER = REASONS[REASONS.length - 1];

export function Notice({ message, testId }: { message: CommandMessage | null; testId: string }) {
  if (!message) return null;
  return (
    <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid={testId}>
      {message.text}
    </p>
  );
}

/**
 * Cancelamento pelo responsável (F14): total ou parcial, só do que ainda não foi entregue, dentro do prazo salvo no pedido.
 * O valor mostrado é uma ESTIMATIVA calculada com o preço pago registrado no pedido (mesma regra do servidor); o resultado
 * exibido vem SEMPRE da resposta confirmada do servidor, que decide o prazo, o vínculo e as quantidades. O reembolso volta
 * só à carteira do aluno (nunca por Pix/cartão). Resposta perdida: o mesmo envio reaproveita a chave (idempotente).
 */
export function CancelPanel({ user, order, onDone, onMessage }: { user: User; order: OrderDetail; onDone: () => void; onMessage: (message: CommandMessage | null) => void }) {
  const cmd = useOrderCommand(user, onDone);
  // O resultado sobe para a tela: depois de cancelar o que resta, o painel some (não há mais o que cancelar), mas a confirmação fica.
  useEffect(() => {
    onMessage(cmd.message);
  }, [cmd.message, onMessage]);
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [preset, setPreset] = useState<string>(REASONS[0]);
  const [other, setOther] = useState("");
  const remaining = order.items.filter((i) => i.remainingQty > 0);
  const chosen = remaining.map((i) => ({ item: i, quantity: toQty(qty[i.lineNo] ?? String(i.remainingQty), i.remainingQty) })).filter((l) => l.quantity > 0);
  const estimate = chosen.reduce((sum, l) => sum + refundValueOf({ quantity: l.item.quantity, subtotalCents: l.item.subtotalCents, deliveredQty: l.item.deliveredQty, canceledQty: l.item.canceledQty }, l.quantity), 0);
  const reason = preset === OTHER ? other.trim() : preset;
  const total = chosen.length === remaining.length && chosen.every((l) => l.quantity === l.item.remainingQty);

  return (
    <div className="no-print" data-testid="cancel-area">
      {!open && (
        <button type="button" className="secondary" aria-expanded={false} onClick={() => {
            setQty({}); // quantidades digitadas antes não valem depois de um cancelamento parcial: o restante mudou
            setOpen(true);
          }} data-testid="cancel-open">
          Cancelar pedido
        </button>
      )}
      {open && (
        <form
          className="day-panel"
          data-testid="cancel-form"
          onSubmit={(e) => {
            e.preventDefault();
            const lines = total ? undefined : chosen.map((l) => ({ lineNo: l.item.lineNo, quantity: l.quantity }));
            void cmd
              .run(`/api/orders/${encodeURIComponent(order.orderId)}/cancel`, { reason, ...(lines ? { lines } : {}) }, (d) => {
                const w = d.wallet as { balanceCents: number };
                return `Cancelamento confirmado: ${formatBRL(Number(d.refundCents))} devolvido(s) à carteira de ${order.studentName}. Saldo atual: ${formatBRL(w.balanceCents)}.`;
              })
              .then((ok) => ok && setOpen(false));
          }}
        >
          <h3>Cancelar pedido</h3>
          <p className="muted">
            Só o que ainda não foi entregue pode ser cancelado, até o prazo informado no pedido. O valor volta <strong>somente à carteira de {order.studentName}</strong>, pelo preço pago na compra — não há devolução por Pix ou cartão.
          </p>
          {remaining.map((i) => (
            <div className="field" key={i.lineNo}>
              <label htmlFor={`c-${order.orderId}-${i.lineNo}`}>
                {i.name} — quantidade a cancelar (restam {i.remainingQty})
              </label>
              <input id={`c-${order.orderId}-${i.lineNo}`} inputMode="numeric" value={qty[i.lineNo] ?? String(i.remainingQty)} onChange={(e) => setQty({ ...qty, [i.lineNo]: e.target.value })} data-testid="cancel-qty" />
            </div>
          ))}
          <div className="field">
            <label htmlFor={`cr-${order.orderId}`}>Motivo</label>
            <select id={`cr-${order.orderId}`} value={preset} onChange={(e) => setPreset(e.target.value)} data-testid="cancel-reason">
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          {preset === OTHER && (
            <div className="field field-wide">
              <label htmlFor={`co-${order.orderId}`}>Descreva o motivo (mínimo 5 caracteres)</label>
              <input id={`co-${order.orderId}`} value={other} onChange={(e) => setOther(e.target.value)} maxLength={300} data-testid="cancel-reason-other" />
            </div>
          )}
          <p data-testid="cancel-estimate">
            {chosen.length === 0 ? "Informe ao menos uma unidade." : `${total ? "Cancelamento total do que resta" : "Cancelamento parcial"}: valor estimado de ${formatBRL(estimate)} de volta à carteira.`}
          </p>
          <button type="submit" disabled={cmd.busy || chosen.length === 0 || reason.length < 5} data-testid="cancel-confirm">
            {cmd.busy ? "Cancelando…" : "Confirmar cancelamento"}
          </button>{" "}
          <button type="button" className="secondary" disabled={cmd.busy} onClick={() => setOpen(false)}>
            Voltar
          </button>
        </form>
      )}
    </div>
  );
}
