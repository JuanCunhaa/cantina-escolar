"use client";

import { formatBRL } from "@/lib/money/format";
import { TerminalField } from "@/modules/fees/components/terminal-field";
import type { TerminalOption } from "@/modules/fees/fee-queries";
import { parseBRLInput } from "@/modules/catalog/model";
import { BUYER_KINDS, BUYER_LABEL, MAX_POS_QUANTITY, PAYMENT_LABEL, PAYMENT_METHODS, type BuyerKind, type PaymentMethod } from "../model";
import type { PosProduct, PosStudent } from "../queries";
import { precheck, type CartLine } from "../view";

export type DirectFields = { paymentMethod: PaymentMethod; buyerKind: BuyerKind; buyerNote: string; feeText: string; received: boolean; sourceId: string };
export const EMPTY_DIRECT: DirectFields = { paymentMethod: "cash", buyerKind: "teacher", buyerNote: "", feeText: "", received: false, sourceId: "" };

/** Taxa digitada (R$) → centavos; vazio = não informada (`undefined`); inválido = `null`. */
export function feeCentsOf(fields: DirectFields): number | undefined | null {
  if (fields.paymentMethod === "cash" || fields.feeText.trim() === "") return undefined;
  return /^\s*0+([.,]0{1,2})?\s*$/.test(fields.feeText) ? 0 : parseBRLInput(fields.feeText);
}

type Props = {
  mode: "student" | "direct";
  cart: readonly CartLine[];
  products: readonly PosProduct[];
  student: PosStudent | null;
  balanceCents: number | null;
  /** Edição travada (envio em andamento ou resposta incerta). */
  locked: boolean;
  /** Envio em andamento: só isto desabilita o reenvio da MESMA venda quando a resposta se perdeu. */
  busy: boolean;
  uncertain: boolean;
  reviewing: boolean;
  exceptionId: string | null;
  direct: DirectFields;
  /** Maquininhas ativas (F20); vazio = sem escolha. */
  terminals?: readonly TerminalOption[];
  message: { kind: "ok" | "error"; text: string } | null;
  onQty: (productId: string, quantity: number) => void;
  onRemove: (productId: string) => void;
  onClear: () => void;
  onException: (id: string | null) => void;
  onDirect: (fields: DirectFields) => void;
  onReview: () => void;
  onBack: () => void;
  onConfirm: () => void;
};

/**
 * Carrinho → revisão → confirmação. A revisão repete aluno (turma/turno), itens, total e o efeito no saldo; a confirmação
 * só envia o que foi visto (o preço cobrado é o do servidor). Enquanto há envio ou resposta incerta, a edição fica travada
 * para que o reenvio seja exatamente a mesma venda.
 */
export function SalePanel(p: Props) {
  const byId = new Map(p.products.map((x) => [x.id, x]));
  const lines = p.cart.flatMap((l) => (byId.has(l.productId) ? [{ ...l, product: byId.get(l.productId)! }] : []));
  const check = precheck(p.cart, p.products, p.student);
  const total = check.totalCents;
  const units = p.cart.reduce((n, l) => n + l.quantity, 0);
  const fee = feeCentsOf(p.direct);
  const feeInvalid = fee === null || (typeof fee === "number" && fee > total);
  const exceptions = p.student?.exceptions ?? [];
  const covered = p.exceptionId !== null;
  const hasAlert = !covered && (check.blocked.length > 0 || check.overLimitCents > 0);
  const studentBlocked = p.mode === "student" && (!p.student || !p.student.counterAllowed);
  const directReady = p.mode !== "direct" || (p.direct.received && !feeInvalid);
  const canReview = lines.length > 0 && !studentBlocked && !p.locked && check.overBalanceCents === 0;
  const readyToConfirm = lines.length > 0 && !studentBlocked && check.overBalanceCents === 0 && directReady && !hasAlert;
  const after = p.balanceCents === null ? null : p.balanceCents - total;

  return (
    <section aria-labelledby="pos-cart-title" className="pos-cart" data-testid="pos-cart">
      <h2 id="pos-cart-title">{p.reviewing ? "Revisar venda" : "Carrinho"}</h2>
      {p.student && (
        <p className="pos-who" data-testid="pos-who">
          <strong>{p.student.student.name}</strong> · {p.student.student.className ?? "Sem turma"} · {p.student.student.shiftName ?? "Sem turno"}
        </p>
      )}
      {p.mode === "direct" && <p className="pos-who">Venda direta, sem aluno e sem carteira.</p>}

      {lines.length === 0 ? (
        <p className="muted">Nenhum produto no carrinho. Adicione pelos botões +1/+5/+10 ou pela busca.</p>
      ) : (
        <table className="data-table stock-table pos-lines">
          <caption className="visually-hidden">Itens da venda</caption>
          <thead>
            <tr>
              <th scope="col">Produto</th>
              <th scope="col">Qtd.</th>
              <th scope="col" className="checkout-amount">Preço</th>
              <th scope="col" className="checkout-amount">Subtotal</th>
              {!p.reviewing && <th scope="col"><span className="visually-hidden">Remover</span></th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.productId} data-testid="pos-line">
                <th scope="row">{l.product.name}</th>
                <td data-label="Qtd.">
                  {p.reviewing ? (
                    l.quantity
                  ) : (
                    <span className="qty">
                      <button type="button" className="secondary" disabled={p.locked} onClick={() => p.onQty(l.productId, l.quantity - 1)} aria-label={`Diminuir ${l.product.name}`}>−</button>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={Math.min(MAX_POS_QUANTITY, l.product.availableUnits)}
                        value={l.quantity}
                        disabled={p.locked}
                        aria-label={`Quantidade de ${l.product.name}`}
                        className="pos-qty-input"
                        onChange={(e) => p.onQty(l.productId, Number(e.target.value))}
                      />
                      <button type="button" className="secondary" disabled={p.locked || l.quantity >= Math.min(MAX_POS_QUANTITY, l.product.availableUnits)} onClick={() => p.onQty(l.productId, l.quantity + 1)} aria-label={`Aumentar ${l.product.name}`}>+</button>
                    </span>
                  )}
                </td>
                <td className="checkout-amount" data-label="Preço">{formatBRL(l.product.priceCents)}</td>
                <td className="checkout-amount" data-label="Subtotal">{formatBRL(l.product.priceCents * l.quantity)}</td>
                {!p.reviewing && (
                  <td>
                    <button type="button" className="secondary" disabled={p.locked} onClick={() => p.onRemove(l.productId)} aria-label={`Remover ${l.product.name}`}>Remover</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="checkout-total" data-testid="pos-total">
        <strong>Total: {formatBRL(total)}</strong> ({units} unidade{units === 1 ? "" : "s"})
      </p>
      {p.mode === "student" && p.balanceCents !== null && (
        <p data-testid="pos-balance-effect">
          Saldo do aluno: {formatBRL(p.balanceCents)}
          {lines.length > 0 && <> → depois da venda: <strong>{formatBRL(Math.max(0, after ?? 0))}</strong></>}
        </p>
      )}

      {studentBlocked && p.mode === "student" && <p role="alert" className="notice notice-error">O responsável não liberou compras no balcão para este aluno. Não é possível vender.</p>}
      {check.overBalanceCents > 0 && <p role="alert" className="notice notice-error" data-testid="pos-over-balance">Saldo insuficiente: faltam {formatBRL(check.overBalanceCents)}. Reduza o carrinho.</p>}
      {check.blocked.length > 0 && !covered && <p role="alert" className="notice notice-error">Bloqueado pelo responsável: {check.blocked.join(", ")}. Retire do carrinho{exceptions.length > 0 ? " ou use a autorização registrada" : ""}.</p>}
      {check.overLimitCents > 0 && !covered && <p role="alert" className="notice notice-error">Passa {formatBRL(check.overLimitCents)} do que ainda cabe hoje no limite do aluno{p.student?.restrictions.remainingTodayCents !== null ? ` (cabem ${formatBRL(p.student?.restrictions.remainingTodayCents ?? 0)})` : ""}.</p>}
      {check.overStock.length > 0 && <p role="alert" className="notice notice-error">Acima do estoque livre: {check.overStock.join(", ")}.</p>}

      {p.mode === "student" && exceptions.length > 0 && (
        <div className="field">
          <label htmlFor="pos-exception">Autorização de uso único registrada (superar bloqueio/limite)</label>
          <select id="pos-exception" value={p.exceptionId ?? ""} disabled={p.locked} onChange={(e) => p.onException(e.target.value || null)}>
            <option value="">Não usar</option>
            {exceptions.map((x) => (
              <option key={x.id} value={x.id}>
                {x.kind === "guardian" ? "Autorizada pelo responsável" : "Exceção administrativa"} · até {formatBRL(x.maxCents)}
              </option>
            ))}
          </select>
        </div>
      )}

      {p.mode === "direct" && p.reviewing && (
        <fieldset className="pos-direct">
          <legend>Recebimento no balcão</legend>
          <p>
            {PAYMENT_LABEL[p.direct.paymentMethod]} · {BUYER_LABEL[p.direct.buyerKind]}
            {p.direct.buyerNote ? ` · ${p.direct.buyerNote}` : ""}
          </p>
          {p.direct.paymentMethod !== "cash" && <p>{fee === undefined ? "Taxa do meio de pagamento: a conferir depois." : fee === null ? "Taxa inválida." : `Taxa informada: ${formatBRL(fee)} · líquido ${formatBRL(total - fee)}`}</p>}
          <label className="check-line">
            <input type="checkbox" checked={p.direct.received} disabled={p.locked} onChange={(e) => p.onDirect({ ...p.direct, received: e.target.checked })} data-testid="pos-received" />
            <span>Confirmo que recebi {formatBRL(total)} em {PAYMENT_LABEL[p.direct.paymentMethod].toLowerCase()}.</span>
          </label>
        </fieldset>
      )}
      {p.mode === "direct" && !p.reviewing && (
        <fieldset className="pos-direct">
          <legend>Pagamento direto</legend>
          <div className="choice-group" role="radiogroup" aria-label="Forma de pagamento">
            {PAYMENT_METHODS.map((m) => (
              <label key={m}>
                <input type="radio" name="pos-method" value={m} checked={p.direct.paymentMethod === m} disabled={p.locked} onChange={() => p.onDirect({ ...p.direct, paymentMethod: m, feeText: m === "cash" ? "" : p.direct.feeText, sourceId: "" })} data-testid={`pos-method-${m}`} />
                {PAYMENT_LABEL[m]}
              </label>
            ))}
          </div>
          {p.direct.paymentMethod !== "cash" && (
            <div className="field">
              <label htmlFor="pos-fee">Taxa do meio de pagamento, em R$ (se já souber)</label>
              <input id="pos-fee" inputMode="decimal" value={p.direct.feeText} disabled={p.locked} onChange={(e) => p.onDirect({ ...p.direct, feeText: e.target.value })} aria-invalid={feeInvalid} data-testid="pos-fee" />
              {feeInvalid && <span role="alert" className="notice-error">Informe um valor válido (ex.: 0,35) que não passe do total.</span>}
            </div>
          )}
          <TerminalField id="pos-terminal" terminals={p.terminals ?? []} method={p.direct.paymentMethod} value={p.direct.sourceId} disabled={p.locked} onChange={(sourceId) => p.onDirect({ ...p.direct, sourceId })} />
          <div className="form-grid">
            <div className="field">
              <label htmlFor="pos-buyer-kind">Quem comprou</label>
              <select id="pos-buyer-kind" value={p.direct.buyerKind} disabled={p.locked} onChange={(e) => p.onDirect({ ...p.direct, buyerKind: e.target.value as BuyerKind })}>
                {BUYER_KINDS.map((k) => (
                  <option key={k} value={k}>{BUYER_LABEL[k]}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pos-buyer-note">Identificação (opcional)</label>
              <input id="pos-buyer-note" maxLength={60} value={p.direct.buyerNote} disabled={p.locked} onChange={(e) => p.onDirect({ ...p.direct, buyerNote: e.target.value })} />
            </div>
          </div>
        </fieldset>
      )}

      {p.message && (
        <p role={p.message.kind === "error" ? "alert" : "status"} className={p.message.kind === "error" ? "notice notice-error" : "notice"} data-testid="pos-message">
          {p.message.text}
        </p>
      )}

      <div className="checkout-actions">
        {!p.reviewing ? (
          <>
            <button type="button" disabled={!canReview} onClick={p.onReview} data-testid="pos-review">Revisar venda</button>
            <button type="button" className="secondary" disabled={p.locked || p.cart.length === 0} onClick={p.onClear}>Limpar carrinho</button>
          </>
        ) : (
          <>
            <button type="button" disabled={!readyToConfirm || p.busy} aria-busy={p.busy} onClick={p.onConfirm} data-testid="pos-confirm">
              {p.uncertain ? "Tentar novamente a mesma venda" : p.mode === "student" ? `Confirmar venda de ${formatBRL(total)}` : `Registrar venda direta de ${formatBRL(total)}`}
            </button>
            <button type="button" className="secondary" disabled={p.locked} onClick={p.onBack}>Voltar ao carrinho</button>
          </>
        )}
      </div>
      {p.uncertain && <p role="alert" className="notice notice-error">Sem resposta do servidor. A venda pode ter sido registrada: use “Tentar novamente a mesma venda” (não cobra duas vezes). Se fechou a tela, confira o saldo do aluno antes de vender de novo.</p>}
    </section>
  );
}
