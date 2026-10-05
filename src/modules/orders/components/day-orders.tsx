"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import { longDayLabel } from "@/modules/menu/format";
import { isOpenStatus, type DayOrderView, type DayOrders, type Preparation } from "../fulfillment-model";
import { useOrderCommand, useServerQuery, type CommandMessage } from "../use-operations";
import { ExchangeForm, RescheduleForm } from "./amend-order";
import { toQty } from "./qty";

type Filters = { date: string; shiftId: string; classId: string; status: string; q: string };

const STATUS_FILTERS: [string, string][] = [
  ["", "Todas"],
  ["open", "A entregar"],
  ["paid", "Agendado"],
  ["preparing", "Em preparo"],
  ["ready", "Pronto"],
  ["partially_delivered", "Entregue em parte"],
  ["delivered", "Entregue"],
  ["cancelled", "Cancelado"],
  ["not_picked_up", "Não retirado (a resolver)"],
  ["not_picked_up_closed", "Não retirado (encerrado)"],
];

const badgeClass = (status: string) => (status === "delivered" || status === "not_picked_up_closed" ? "badge-completed" : status === "cancelled" ? "badge-cancelled" : status === "not_picked_up" ? "badge-warn" : "badge-pending");

function initialFilters(): Filters {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return { date: params.get("date") ?? localDateOf(new Date()), shiftId: "", classId: "", status: "", q: "" };
}

function Notice({ message, testId }: { message: CommandMessage | null; testId: string }) {
  if (!message) return null;
  return (
    <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid={testId}>
      {message.text}
    </p>
  );
}

/** Ações de UM pedido: entregar tudo, entrega parcial por quantidade, preparo, não retirado e (administração) resolução. */
function OrderActions({ user, order, canDeliver, canResolve, canCancel, canDiscard, canAmend, onDone, onNotice }: { user: User; order: DayOrderView; canDeliver: boolean; canResolve: boolean; canCancel: boolean; canDiscard: boolean; canAmend: boolean; onDone: () => void; onNotice: (message: CommandMessage) => void }) {
  const cmd = useOrderCommand(user, onDone);
  const [panel, setPanel] = useState<"partial" | "notpicked" | "resolve" | "cancel" | "reschedule" | "exchange" | null>(null);
  const today = localDateOf(new Date());
  const nothingDelivered = order.items.every((i) => i.deliveredQty === 0);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const base = `/api/operations/orders/${encodeURIComponent(order.orderId)}`;
  const open = isOpenStatus(order.status);
  const remaining = order.items.filter((i) => i.remainingQty > 0);
  const label = order.studentName;

  const deliver = (lines: { lineNo: number; quantity: number }[]) =>
    cmd.run(`${base}/deliver`, { studentId: order.studentId, lines }, (d) => `Entrega registrada para ${label}.${d.status === "delivered" ? " Pedido entregue por completo." : " Restante continua pendente."}`);

  return (
    <div className="day-actions">
      {open && canDeliver && (
        <>
          <button type="button" disabled={cmd.busy || remaining.length === 0} onClick={() => void deliver(remaining.map((i) => ({ lineNo: i.lineNo, quantity: i.remainingQty })))} data-testid="deliver-all" aria-label={`Entregar tudo a ${label}`}>
            Entregar tudo
          </button>
          {remaining.length > 0 && (
            <button type="button" className="secondary" aria-expanded={panel === "partial"} disabled={cmd.busy} onClick={() => setPanel(panel === "partial" ? null : "partial")} data-testid="deliver-partial-toggle">
              Entrega parcial
            </button>
          )}
        </>
      )}
      {open && canDeliver && order.status === "paid" && (
        <button type="button" className="secondary" disabled={cmd.busy} onClick={() => void cmd.run(`${base}/prepare`, { to: "preparing" }, () => `${label}: em preparo.`)} data-testid="prepare">
          Em preparo
        </button>
      )}
      {open && canDeliver && (order.status === "paid" || order.status === "preparing") && (
        <button type="button" className="secondary" disabled={cmd.busy} onClick={() => void cmd.run(`${base}/prepare`, { to: "ready" }, () => `${label}: pronto para retirada.`)} data-testid="ready">
          Pronto
        </button>
      )}
      {open && order.remainingUnits > 0 && order.consumptionDate <= localDateOf(new Date()) && (
        <button type="button" className="secondary" aria-expanded={panel === "notpicked"} disabled={cmd.busy} onClick={() => setPanel(panel === "notpicked" ? null : "notpicked")} data-testid="notpicked-toggle">
          Não retirado
        </button>
      )}
      {open && canCancel && remaining.length > 0 && (
        <button type="button" className="secondary" aria-expanded={panel === "cancel"} disabled={cmd.busy} onClick={() => setPanel(panel === "cancel" ? null : "cancel")} data-testid="cancel-toggle">
          Cancelar / reembolsar
        </button>
      )}
      {open && canAmend && nothingDelivered && remaining.length > 0 && (order.consumptionDate >= today || canResolve) && (
        <button type="button" className="secondary" aria-expanded={panel === "reschedule"} disabled={cmd.busy} onClick={() => setPanel(panel === "reschedule" ? null : "reschedule")} data-testid="reschedule-toggle">
          {order.consumptionDate > today ? "Antecipar / reagendar" : "Reagendar"}
        </button>
      )}
      {open && canAmend && remaining.length > 0 && order.consumptionDate >= today && (
        <button type="button" className="secondary" aria-expanded={panel === "exchange"} disabled={cmd.busy} onClick={() => setPanel(panel === "exchange" ? null : "exchange")} data-testid="exchange-toggle">
          Trocar produto
        </button>
      )}
      {order.status === "not_picked_up" && canResolve && (
        <button type="button" aria-expanded={panel === "resolve"} disabled={cmd.busy} onClick={() => setPanel(panel === "resolve" ? null : "resolve")} data-testid="resolve-toggle">
          Resolver
        </button>
      )}
      {order.status === "not_picked_up" && !canResolve && <span className="muted">Aguarda resolução da administração.</span>}

      {panel === "partial" && (
        <form
          className="day-panel"
          data-testid="partial-form"
          onSubmit={(e) => {
            e.preventDefault();
            const lines = remaining.map((i) => ({ lineNo: i.lineNo, quantity: toQty(qty[i.lineNo] ?? "", i.remainingQty) })).filter((l) => l.quantity > 0);
            if (lines.length > 0) void deliver(lines).then((ok) => ok && setPanel(null));
          }}
        >
          <p className="muted">Informe quanto de cada item está sendo entregue agora. O que ficar sem entregar continua pendente (para devolver o dinheiro do que não for entregue, use “Cancelar / reembolsar”).</p>
          {remaining.map((i) => (
            <div className="field" key={i.lineNo}>
              <label htmlFor={`q-${order.orderId}-${i.lineNo}`}>
                {i.name} (faltam {i.remainingQty})
              </label>
              <input id={`q-${order.orderId}-${i.lineNo}`} inputMode="numeric" value={qty[i.lineNo] ?? ""} onChange={(e) => setQty({ ...qty, [i.lineNo]: e.target.value })} placeholder="0" />
            </div>
          ))}
          <button type="submit" disabled={cmd.busy} data-testid="deliver-partial-submit">
            Entregar quantidades informadas
          </button>
        </form>
      )}

      {panel === "notpicked" && (
        <form
          className="day-panel"
          data-testid="notpicked-form"
          onSubmit={(e) => {
            e.preventDefault();
            void cmd.run(`${base}/not-picked-up`, { reason }, () => `${label}: marcado como não retirado. A administração decide a resolução; nada foi reembolsado nem perdido.`).then((ok) => ok && setPanel(null));
          }}
        >
          <p className="muted">Marcar como não retirado só registra a situação: não reembolsa, não gera perda e mantém as unidades reservadas até a administração resolver.</p>
          <div className="field">
            <label htmlFor={`r-${order.orderId}`}>Motivo (obrigatório)</label>
            <input id={`r-${order.orderId}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} required />
          </div>
          <button type="submit" disabled={cmd.busy || reason.trim().length < 5}>
            Confirmar não retirado
          </button>
        </form>
      )}

      {panel === "cancel" && <CancelForm order={order} busy={cmd.busy} run={cmd.run} canDiscard={canDiscard} onClose={() => setPanel(null)} />}
      {panel === "resolve" && <ResolveForm user={user} order={order} busy={cmd.busy} run={cmd.run} base={base} onClose={() => setPanel(null)} onNotice={onNotice} />}
      {panel === "reschedule" && <RescheduleForm user={user} order={order} busy={cmd.busy} run={cmd.run} onClose={() => setPanel(null)} onNotice={onNotice} />}
      {panel === "exchange" && <ExchangeForm user={user} order={order} busy={cmd.busy} run={cmd.run} onClose={() => setPanel(null)} />}
      <Notice message={cmd.message} testId="order-command-message" />
    </div>
  );
}

function ResolveForm({ user, order, busy, run, base, onClose, onNotice }: { user: User; order: DayOrderView; busy: boolean; run: ReturnType<typeof useOrderCommand>["run"]; base: string; onClose: () => void; onNotice: (message: CommandMessage) => void }) {
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState<"close_charged" | "cancel_refund" | "reschedule">("close_charged");
  const [discard, setDiscard] = useState<Record<number, string>>({});
  const items = order.items.filter((i) => i.remainingQty > 0);
  return (
    <div className="day-panel" data-testid="resolve-panel">
      <h3>Resolver não retirado — {order.studentName}</h3>
      <fieldset className="field field-wide">
        <legend>Como resolver</legend>
        <label>
          <input type="radio" name={`res-${order.orderId}`} checked={resolution === "close_charged"} onChange={() => setResolution("close_charged")} data-testid="resolution-close" /> Encerrar com cobrança mantida
        </label>{" "}
        <label>
          <input type="radio" name={`res-${order.orderId}`} checked={resolution === "cancel_refund"} onChange={() => setResolution("cancel_refund")} data-testid="resolution-refund" /> Cancelar e reembolsar a carteira
        </label>{" "}
        <label>
          <input type="radio" name={`res-${order.orderId}`} checked={resolution === "reschedule"} onChange={() => setResolution("reschedule")} data-testid="resolution-reschedule" /> Reagendar para outra data
        </label>
      </fieldset>
      {resolution === "reschedule" ? (
        <RescheduleForm user={user} order={order} busy={busy} run={run} onClose={onClose} onNotice={onNotice} resolution />
      ) : (
        <form
          data-testid="resolve-form"
          onSubmit={(e) => {
            e.preventDefault();
            const discards = items.map((i) => ({ lineNo: i.lineNo, quantity: toQty(discard[i.lineNo] ?? "", i.remainingQty) })).filter((d) => d.quantity > 0);
            void run(`${base}/resolve`, { resolution, reason, discards }, (d) => (d.resolution === "cancel_refund" ? `Cancelado e reembolsado: ${formatBRL(Number(d.refundCents ?? 0))} devolvido(s) à carteira de ${order.studentName} (saldo atual ${formatBRL(Number((d.wallet as { balanceCents: number } | null)?.balanceCents ?? 0))}). ` : `Encerrado com cobrança mantida (${formatBRL(Number(d.retainedCents ?? 0))}). `) + `${d.discardedUnits ? `${d.discardedUnits} unidade(s) descartada(s) como perda.` : "Nenhuma perda registrada."}${Number(d.shortfallUnits ?? 0) > 0 ? ` ATENÇÃO: o descarte deixou ${d.shortfallUnits} unidade(s) de outros pedidos sem estoque físico — trate esses pedidos (Estoque).` : ""}`).then((ok) => ok && onClose());
          }}
        >
          {resolution === "close_charged" ? (
            <p>
              <strong>Encerrar com cobrança mantida:</strong> o valor já pago (das unidades não retiradas) fica com a escola, classificado como <em>cobrança mantida por não retirada</em> — não é venda entregue, não gera novo lançamento na carteira e não é reembolso. As unidades voltam à disponibilidade, exceto as que você marcar como descarte (perda explícita).
            </p>
          ) : (
            <p>
              <strong>Cancelar e reembolsar:</strong> o valor pago das unidades não retiradas volta <strong>somente à carteira de {order.studentName}</strong> (preço da compra; sem Pix/cartão), com lançamento no extrato. A reserva e o consumo do limite são liberados; as unidades voltam à disponibilidade, exceto as que você marcar como descarte (perda explícita, separada do reembolso).
            </p>
          )}
          {items.map((i) => (
            <div className="field" key={i.lineNo}>
              <label htmlFor={`d-${order.orderId}-${i.lineNo}`}>
                Descartar de {i.name} (até {i.remainingQty}; vazio = voltam ao estoque)
              </label>
              <input id={`d-${order.orderId}-${i.lineNo}`} inputMode="numeric" value={discard[i.lineNo] ?? ""} onChange={(e) => setDiscard({ ...discard, [i.lineNo]: e.target.value })} placeholder="0" />
            </div>
          ))}
          <div className="field field-wide">
            <label htmlFor={`rs-${order.orderId}`}>Motivo / política aplicada (obrigatório)</label>
            <input id={`rs-${order.orderId}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} required />
          </div>
          <button type="submit" disabled={busy || reason.trim().length < 5} data-testid="resolve-submit">
            {resolution === "cancel_refund" ? "Cancelar e reembolsar" : "Encerrar com cobrança mantida"}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Cancelamento operacional (F14): excepcional, também depois do prazo da família, SEMPRE com motivo. Cancela o que ainda não
 * foi entregue (total ou por quantidade), devolve o valor PAGO à carteira original do aluno e libera reserva/cota. Descarte é
 * perda explícita, com motivo, separada do reembolso (só com permissão de perda); sem descarte a unidade apenas volta à disponibilidade.
 */
function CancelForm({ order, busy, run, canDiscard, onClose }: { order: DayOrderView; busy: boolean; run: ReturnType<typeof useOrderCommand>["run"]; canDiscard: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState<Record<number, string>>({});
  const [discard, setDiscard] = useState<Record<number, string>>({});
  const items = order.items.filter((i) => i.remainingQty > 0);
  const chosen = items.map((i) => ({ i, quantity: toQty(qty[i.lineNo] ?? String(i.remainingQty), i.remainingQty) })).filter((l) => l.quantity > 0);
  const total = chosen.length === items.length && chosen.every((l) => l.quantity === l.i.remainingQty);
  return (
    <form
      className="day-panel"
      data-testid="cancel-form"
      onSubmit={(e) => {
        e.preventDefault();
        const discards = canDiscard ? chosen.map((l) => ({ lineNo: l.i.lineNo, quantity: Math.min(toQty(discard[l.i.lineNo] ?? "", l.quantity), l.quantity) })).filter((d) => d.quantity > 0) : [];
        const lines = total ? undefined : chosen.map((l) => ({ lineNo: l.i.lineNo, quantity: l.quantity }));
        void run(
          `/api/orders/${encodeURIComponent(order.orderId)}/cancel`,
          { reason, ...(lines ? { lines } : {}), ...(discards.length > 0 ? { discards } : {}) },
          (d) => `Cancelado: ${formatBRL(Number(d.refundCents))} devolvido(s) à carteira de ${order.studentName} (saldo atual ${formatBRL(Number((d.wallet as { balanceCents: number }).balanceCents))}). ${d.discardedUnits ? `${d.discardedUnits} unidade(s) descartada(s) como perda.` : "Nenhuma perda registrada."}${Number(d.shortfallUnits ?? 0) > 0 ? ` ATENÇÃO: o descarte deixou ${d.shortfallUnits} unidade(s) de outros pedidos sem estoque físico — trate esses pedidos (Estoque).` : ""}`,
        ).then((ok) => ok && onClose());
      }}
    >
      <h3>Cancelar e reembolsar — {order.studentName}</h3>
      <p className="muted">O valor pago das unidades canceladas volta somente à carteira do aluno, com lançamento no extrato. O que já foi entregue não entra. Liberar a reserva não cria entrada física no estoque.</p>
      {items.map((i) => (
        <div className="field" key={i.lineNo}>
          <label htmlFor={`cq-${order.orderId}-${i.lineNo}`}>
            {i.name} — cancelar (restam {i.remainingQty})
          </label>
          <input id={`cq-${order.orderId}-${i.lineNo}`} inputMode="numeric" value={qty[i.lineNo] ?? String(i.remainingQty)} onChange={(e) => setQty({ ...qty, [i.lineNo]: e.target.value })} />
          {canDiscard && (
            <>
              <label htmlFor={`cd-${order.orderId}-${i.lineNo}`}>Descartar como perda (vazio = só libera a reserva)</label>
              <input id={`cd-${order.orderId}-${i.lineNo}`} inputMode="numeric" value={discard[i.lineNo] ?? ""} onChange={(e) => setDiscard({ ...discard, [i.lineNo]: e.target.value })} placeholder="0" />
            </>
          )}
        </div>
      ))}
      <div className="field field-wide">
        <label htmlFor={`cm-${order.orderId}`}>Motivo (obrigatório; fica na auditoria)</label>
        <input id={`cm-${order.orderId}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} required data-testid="cancel-reason-input" />
      </div>
      <button type="submit" disabled={busy || reason.trim().length < 5 || chosen.length === 0} data-testid="cancel-submit">
        {total ? "Cancelar tudo e reembolsar" : "Cancelar quantidades e reembolsar"}
      </button>
    </form>
  );
}

/** Pedidos do dia da cantina: data/turno, filtros por turma/situação, busca por aluno e ações de preparo/entrega. */
export function DayOrdersBoard({ user, canResolve, canCancel, canDiscard, canAmend }: { user: User; canResolve: boolean; canCancel: boolean; canDiscard: boolean; canAmend: boolean }) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  /** Aviso de comandos que tiram o pedido desta lista (reagendamento): fica no topo, não na linha que some. */
  const [notice, setNotice] = useState<CommandMessage | null>(null);
  const [q, setQ] = useState(filters.q);
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === q ? f : { ...f, q })), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const list = useServerQuery<DayOrders>(user, "/api/operations/orders", params.toString());
  const attention = useServerQuery<Preparation>(user, "/api/operations/preparation", "scope=attention");
  const data = list.data;
  const reloadAll = () => {
    list.reload();
    attention.reload();
  };
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const pending = (attention.data?.attention ?? []).filter((a) => a.marked);
  const overdue = (attention.data?.attention ?? []).filter((a) => !a.marked);

  return (
    <section data-testid="day-orders">
      <h1>Pedidos do dia</h1>
      <p className="muted no-print">Entrega e preparo só no dia do consumo (fuso da escola). A entrega não cobra de novo: o pedido já foi pago no checkout.</p>

      <div className="form-grid toolbar toolbar-compact no-print">
        <div className="field">
          <label htmlFor="d-date">Data</label>
          <input id="d-date" type="date" value={filters.date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="d-shift">Turno</label>
          <select id="d-shift" value={filters.shiftId} onChange={(e) => set({ shiftId: e.target.value })}>
            <option value="">Todos</option>
            {(data?.shifts ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-class">Turma</label>
          <select id="d-class" value={filters.classId} onChange={(e) => set({ classId: e.target.value })}>
            <option value="">Todas</option>
            {(data?.classes ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-status">Situação</label>
          <select id="d-status" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
            {STATUS_FILTERS.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-q">Buscar aluno</label>
          <input id="d-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome do aluno" />
        </div>
      </div>
      <p className="row-actions no-print">
        <button type="button" className="secondary" onClick={reloadAll} disabled={list.refreshing}>
          {list.refreshing ? "Atualizando…" : "Atualizar"}
        </button>
        <button type="button" className="secondary" onClick={() => window.print()}>
          Imprimir lista nominal
        </button>
        <Link href={`/operacao/preparacao?date=${filters.date}`}>O que preparar</Link>
      </p>

      {(pending.length > 0 || overdue.length > 0) && (
        <div className="notice no-print" data-testid="attention" role="status">
          {pending.length > 0 && (
            <p>
              <strong>{pending.length} pedido(s) não retirado(s) aguardam resolução da administração.</strong> Nada foi reembolsado nem perdido automaticamente.
            </p>
          )}
          {overdue.length > 0 && (
            <p>
              <strong>{overdue.length} pedido(s) de datas passadas continuam sem entrega.</strong> Marque-os como não retirados (abra a data deles) para a administração resolver.{" "}
              {[...new Set(overdue.map((o) => o.consumptionDate))].slice(0, 5).map((date) => (
                <button key={date} type="button" className="secondary" onClick={() => set({ date })}>
                  {longDayLabel(date)}
                </button>
              ))}
            </p>
          )}
        </div>
      )}

      <Notice message={notice} testId="board-message" />
      {list.status === "loading" && <p role="status">Carregando os pedidos…</p>}
      {list.status === "error" && (
        <p role="alert" className="notice notice-error" data-testid="day-error">
          {list.errorCode === "forbidden" ? "Seu perfil não opera pedidos." : "Não foi possível carregar os pedidos."}{" "}
          <button type="button" className="secondary" onClick={list.reload}>
            Tentar de novo
          </button>
        </p>
      )}
      {data && (
        <>
          <h2>
            {longDayLabel(data.date)} · {data.orders.length} pedido(s)
          </h2>
          {!data.canDeliver && <p className="muted">Entrega e preparo ficam disponíveis no dia do consumo ({data.date < data.today ? "data já passada" : "data futura"}).</p>}
          {data.truncated && (
            <p role="alert" className="notice notice-error">
              A lista passou do limite e está incompleta: refine por turno ou turma.
            </p>
          )}
          {data.orders.length === 0 && <p className="muted">Nenhum pedido para estes filtros.</p>}
          <ul className="plain-list day-list" data-testid="day-list">
            {data.orders.map((o) => (
              <li key={o.orderId} className="day-row" data-testid="day-order" data-status={o.status}>
                <div className="day-head">
                  <div>
                    <strong>{o.studentName}</strong> <span className="muted">· {o.className ?? "sem turma"} · {o.shiftName ?? "turno"}</span>
                  </div>
                  <span className={`badge ${badgeClass(o.status)}`} data-testid="day-status">
                    {o.statusLabel}
                  </span>
                </div>
                <ul className="plain-list day-items">
                  {o.items.map((i) => (
                    <li key={i.lineNo}>
                      {i.quantity}× {i.name}
                      {i.deliveredQty > 0 && <span className="muted"> — entregues {i.deliveredQty}</span>}
                      {i.canceledQty > 0 && <span className="muted" data-testid="day-canceled"> — canceladas {i.canceledQty}</span>}
                      {i.exchangedQty > 0 && <span className="muted" data-testid="day-exchanged"> — trocadas {i.exchangedQty}</span>}
                      {i.remainingQty > 0 && (i.deliveredQty > 0 || i.canceledQty > 0 || i.exchangedQty > 0) && <span className="muted">, faltam {i.remainingQty}</span>}
                    </li>
                  ))}
                </ul>
                <div className="no-print">
                  <OrderActions user={user} order={o} canDeliver={data.canDeliver} canResolve={canResolve} canCancel={canCancel} canDiscard={canDiscard} canAmend={canAmend} onDone={reloadAll} onNotice={setNotice} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
