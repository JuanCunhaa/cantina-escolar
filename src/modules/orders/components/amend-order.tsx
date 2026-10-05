"use client";

import { useRef, useState } from "react";
import type { User } from "firebase/auth";
import { ProductPhoto } from "@/components/ui/product-photo";
import { api, errorText } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { longDayLabel } from "@/modules/menu/format";
import type { AmendOptions, ExchangeQuote } from "../amend-model";
import type { DayOrderView } from "../fulfillment-model";
import { useServerQuery, type useOrderCommand } from "../use-operations";
import { toQty } from "./qty";

type Run = ReturnType<typeof useOrderCommand>["run"];

const REASON_TEXT: Record<string, string> = {
  non_operating_day: "sem funcionamento",
  beyond_window: "fora da janela",
  past_date: "data passada",
  shift_unavailable: "turno indisponível",
};

/** Texto da diferença: + cobra, − devolve, 0 sem lançamento. */
export function differenceText(cents: number): string {
  if (cents > 0) return `cobrar ${formatBRL(cents)} da carteira`;
  if (cents < 0) return `devolver ${formatBRL(-cents)} à carteira`;
  return "sem diferença (nenhum lançamento na carteira)";
}

/**
 * Reagendar/antecipar atendimento (F16). O destino é uma data da janela no turno ATUAL do aluno; data com horário de compra já
 * encerrado só segue marcando a exceção operacional (fica na auditoria). Pagamento e preços do pedido não mudam: a tela
 * nunca mostra cobrança aqui. O resultado exibido vem SEMPRE da resposta do servidor.
 */
export function RescheduleForm({ user, order, busy, run, onClose, onNotice, resolution = false }: { user: User; order: DayOrderView; busy: boolean; run: Run; onClose: () => void; onNotice?: (message: { kind: "ok" | "error"; text: string }) => void; resolution?: boolean }) {
  const options = useServerQuery<AmendOptions>(user, `/api/operations/orders/${encodeURIComponent(order.orderId)}/amend-options`, "", true, false);
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const data = options.data;
  const destinations = (data?.destinations ?? []).filter((d) => !(d.date === order.consumptionDate && data?.studentShiftId === order.shiftId));
  // Padrão: antecipar para HOJE quando possível (caso típico do balcão); senão a primeira data disponível.
  const fallback = destinations.find((d) => d.date === data?.today && d.allowed)?.date ?? destinations.find((d) => d.allowed)?.date ?? "";
  const date = toDate || fallback;
  const chosen = destinations.find((d) => d.date === date);
  const needsOverride = Boolean(chosen?.cutoffPassed);
  const url = resolution ? `/api/operations/orders/${encodeURIComponent(order.orderId)}/resolve` : `/api/operations/orders/${encodeURIComponent(order.orderId)}/reschedule`;

  return (
    <form
      className="day-panel"
      data-testid="reschedule-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!data?.studentShiftId || !date) return;
        const body = { ...(resolution ? { resolution: "reschedule" } : {}), reason, toDate: date, toShiftId: data.studentShiftId, overrideCutoff: needsOverride && override };
        // O pedido sai da lista desta data: o aviso vai para o topo da lista (`onNotice`), não só para a linha que some.
        void run(
          url,
          body,
          (d) => {
            const to = (d.to ?? d.rescheduledTo) as { date: string } | undefined;
            const text = `${order.studentName}: pedido reagendado para ${to ? longDayLabel(to.date) : date}. Pagamento e preços mantidos — nada foi cobrado de novo.${d.cutoffOverride || (d.rescheduledTo as { cutoffOverride?: boolean } | undefined)?.cutoffOverride ? " Exceção de horário registrada." : ""}`;
            onNotice?.({ kind: "ok", text });
            return text;
          },
          (error, uncertain) => {
            if (uncertain) onNotice?.({ kind: "error", text: `Não foi possível confirmar o reagendamento de ${order.studentName} (conexão). Confira a data do pedido na lista antes de repetir; repetir o mesmo envio não move duas vezes.` });
            else onNotice?.({ kind: "error", text: `${order.studentName}: ${errorText(error)}` });
          },
        ).then((ok) => ok && onClose());
      }}
    >
      <h3>{resolution ? "Reagendar o não retirado" : "Reagendar / antecipar atendimento"} — {order.studentName}</h3>
      <p className="muted">
        Move o que falta entregar para outra data do turno atual do aluno: libera a reserva desta data e reserva no destino, conferindo cardápio, estoque/cota e os limites do aluno. O pagamento e os preços do pedido são mantidos — não há segunda cobrança.
      </p>
      {options.status === "loading" && <p role="status">Carregando as datas…</p>}
      {options.status === "error" && (
        <p role="alert" className="notice notice-error">
          {errorText(options.errorCode ?? "internal")}
        </p>
      )}
      {data && !data.canReschedule && !resolution && <p className="notice">{data.blockedReason ?? "Este pedido não pode ser reagendado."}</p>}
      {data && (data.canReschedule || resolution) && (
        <>
          <div className="field">
            <label htmlFor={`rd-${order.orderId}`}>Nova data</label>
            <select id={`rd-${order.orderId}`} value={date} onChange={(e) => { setToDate(e.target.value); setOverride(false); }} data-testid="reschedule-date">
              {destinations.map((d) => (
                <option key={d.date} value={d.date} disabled={!d.allowed}>
                  {longDayLabel(d.date)}
                  {d.date === data.today ? " (hoje)" : ""}
                  {d.cutoffPassed ? " — horário de compra encerrado" : ""}
                  {!d.allowed && d.reason ? ` — ${REASON_TEXT[d.reason] ?? "indisponível"}` : ""}
                </option>
              ))}
            </select>
          </div>
          {needsOverride && (
            <p className="field field-wide">
              <label>
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="reschedule-override" /> Usar exceção operacional de horário (o fechamento desta data já passou; fica registrado na auditoria com o seu nome e o motivo)
              </label>
            </p>
          )}
          <div className="field field-wide">
            <label htmlFor={`rr-${order.orderId}`}>Motivo (obrigatório; fica na auditoria)</label>
            <input id={`rr-${order.orderId}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} required data-testid="reschedule-reason" />
          </div>
          <button type="submit" disabled={busy || reason.trim().length < 5 || !date || (needsOverride && !override)} data-testid="reschedule-submit">
            {date === data.today ? "Antecipar para hoje" : "Reagendar"}
          </button>
        </>
      )}
    </form>
  );
}

type Choice = { lineNo: number; quantity: string };

/**
 * Troca de produto (F16): escolha o que sai (só o que falta entregar) e o que entra (cardápio da data/turno do pedido). O
 * servidor calcula a prévia — crédito do valor PAGO do que sai, preço ATUAL do que entra e a diferença — e só a diferença
 * confirmada é aplicada. Mudar a escolha descarta a prévia; prévia antiga que chega depois é ignorada (geração).
 */
export function ExchangeForm({ user, order, busy, run, onClose }: { user: User; order: DayOrderView; busy: boolean; run: Run; onClose: () => void }) {
  const options = useServerQuery<AmendOptions>(user, `/api/operations/orders/${encodeURIComponent(order.orderId)}/amend-options`, "", true, false);
  const remaining = order.items.filter((i) => i.remainingQty > 0);
  const [out, setOut] = useState<Choice>({ lineNo: remaining[0]?.lineNo ?? 0, quantity: "1" });
  const [inProduct, setInProduct] = useState("");
  const [inQty, setInQty] = useState("1");
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [quote, setQuote] = useState<{ key: string; value: ExchangeQuote } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const generation = useRef(0);
  const products = (options.data?.products ?? []).filter((p) => p.id !== remaining.find((i) => i.lineNo === out.lineNo)?.productId);
  const product = products.find((p) => p.id === inProduct) ?? null;
  const outItem = remaining.find((i) => i.lineNo === out.lineNo);
  const outQty = outItem ? toQty(out.quantity, outItem.remainingQty) : 0;
  const addQty = toQty(inQty, 20);
  const body = product && outQty > 0 && addQty > 0 ? { remove: [{ lineNo: out.lineNo, quantity: outQty }], add: [{ productId: product.id, quantity: addQty, expectedPriceCents: product.priceCents }] } : null;
  const selectionKey = body ? JSON.stringify(body) : "";
  const current = quote && quote.key === selectionKey ? quote.value : null;

  const reset = () => {
    generation.current += 1; // qualquer prévia em voo fica obsoleta
    setQuote(null);
    setQuoteError(null);
    setOverride(false);
  };

  async function preview() {
    if (!body) return;
    const mine = ++generation.current;
    setQuoting(true);
    setQuoteError(null);
    const result = await api<ExchangeQuote>(user, "POST", `/api/operations/orders/${encodeURIComponent(order.orderId)}/exchange/quote`, body);
    if (mine !== generation.current) return; // escolha mudou enquanto a prévia viajava
    setQuoting(false);
    if (result.ok) setQuote({ key: selectionKey, value: result.data });
    else setQuoteError(errorText(result.error));
  }

  const blocked = current ? !current.policy.allowed || !current.wallet.sufficient || (current.cutoffPassed && !override) : true;

  return (
    <form
      className="day-panel"
      data-testid="exchange-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body || !current || blocked) return;
        void run(`/api/operations/orders/${encodeURIComponent(order.orderId)}/exchange`, { ...body, reason, expectedDifferenceCents: current.differenceCents, overrideCutoff: current.cutoffPassed && override }, (d) => {
          const diff = Number(d.differenceCents ?? 0);
          const wallet = d.wallet as { balanceCents: number } | null;
          return `Troca registrada para ${order.studentName}: ${diff > 0 ? `${formatBRL(diff)} cobrado(s)` : diff < 0 ? `${formatBRL(-diff)} devolvido(s)` : "sem diferença"}${wallet ? ` (saldo atual ${formatBRL(wallet.balanceCents)})` : ""}.`;
        }, (_error, uncertain) => {
          // Resultado INCERTO (resposta perdida): mantém a prévia para repetir a MESMA troca (mesma chave; o servidor não cobra de novo).
          // Recusa real (diferença/preço/saldo/restante mudou): descarta a prévia — nunca confirma com valor antigo.
          if (!uncertain) reset();
        }).then((ok) => ok && onClose());
      }}
    >
      <h3>Trocar produto — {order.studentName}</h3>
      <p className="muted">Só o que ainda falta entregar pode ser trocado. O valor pago do que sai vira crédito; o que entra custa o preço atual; só a diferença mexe na carteira do aluno, depois da sua confirmação.</p>
      {options.status === "loading" && <p role="status">Carregando o cardápio da data…</p>}
      {options.status === "error" && (
        <p role="alert" className="notice notice-error">
          {errorText(options.errorCode ?? "internal")}
        </p>
      )}
      {options.data && !options.data.canExchange && <p className="notice">{options.data.blockedReason ?? "Este pedido não pode ser trocado."}</p>}
      {options.data?.canExchange && (
        <>
          <div className="field">
            <label htmlFor={`xo-${order.orderId}`}>Sai</label>
            <select id={`xo-${order.orderId}`} value={out.lineNo} onChange={(e) => { setOut({ lineNo: Number(e.target.value), quantity: "1" }); reset(); }} data-testid="exchange-out">
              {remaining.map((i) => (
                <option key={i.lineNo} value={i.lineNo}>
                  {i.name} (faltam {i.remainingQty})
                </option>
              ))}
            </select>
            <label htmlFor={`xoq-${order.orderId}`}>Quantidade que sai</label>
            <input id={`xoq-${order.orderId}`} inputMode="numeric" value={out.quantity} onChange={(e) => { setOut({ ...out, quantity: e.target.value }); reset(); }} data-testid="exchange-out-qty" />
          </div>
          <fieldset className="field field-wide">
            <legend>Entra</legend>
            {products.length === 0 && <p className="muted">Nenhum outro produto no cardápio desta data e turno.</p>}
            <ul className="plain-list exchange-products">
              {products.map((p) => (
                <li key={p.id}>
                  <label className="exchange-product">
                    <input type="radio" name={`xi-${order.orderId}`} checked={inProduct === p.id} onChange={() => { setInProduct(p.id); reset(); }} />
                    <ProductPhoto productId={p.id} photoPath={p.photoPath} name={p.name} />
                    <span>
                      {p.name} <span className="muted">· {formatBRL(p.priceCents)}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <label htmlFor={`xiq-${order.orderId}`}>Quantidade que entra</label>
            <input id={`xiq-${order.orderId}`} inputMode="numeric" value={inQty} onChange={(e) => { setInQty(e.target.value); reset(); }} data-testid="exchange-in-qty" />
          </fieldset>
          <button type="button" className="secondary" disabled={!body || quoting} onClick={() => void preview()} data-testid="exchange-quote">
            {quoting ? "Calculando…" : "Calcular diferença"}
          </button>
          {quoteError && (
            <p role="alert" className="notice notice-error" data-testid="exchange-quote-error">
              {quoteError}
            </p>
          )}
          {current && (
            <div className="exchange-quote" data-testid="exchange-quote-result" role="status">
              <p>
                Sai: {current.removed.map((r) => `${r.quantity}× ${r.name} (crédito ${formatBRL(r.creditCents)})`).join(", ")}. Entra: {current.added.map((a) => `${a.quantity}× ${a.name} (${formatBRL(a.subtotalCents)})`).join(", ")}.
              </p>
              <p>
                <strong data-testid="exchange-difference">Diferença: {differenceText(current.differenceCents)}</strong> <span className="muted">· saldo atual {formatBRL(current.wallet.balanceCents)}</span>
              </p>
              {!current.wallet.sufficient && <p className="notice notice-error">Saldo insuficiente para a diferença: a troca não pode ser feita.</p>}
              {!current.policy.allowed && <p className="notice notice-error">O produto novo passa dos limites ou bloqueios do aluno: só com exceção registrada.</p>}
              {current.cutoffPassed && (
                <label>
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="exchange-override" /> Usar exceção operacional de horário (fica na auditoria)
                </label>
              )}
            </div>
          )}
          <div className="field field-wide">
            <label htmlFor={`xr-${order.orderId}`}>Motivo (obrigatório; fica na auditoria)</label>
            <input id={`xr-${order.orderId}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} required data-testid="exchange-reason" />
          </div>
          <button type="submit" disabled={busy || !current || blocked || reason.trim().length < 5} data-testid="exchange-submit">
            {current ? `Confirmar troca — ${differenceText(current.differenceCents)}` : "Confirmar troca"}
          </button>
        </>
      )}
    </form>
  );
}
