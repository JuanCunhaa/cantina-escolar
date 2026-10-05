"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { addDays, localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import type { Role } from "@/modules/access/roles";
import { useFamilyStudents } from "@/modules/guardians/use-family-students";
import { longDayLabel } from "@/modules/menu/format";
import { CHANNEL_LABEL, CHANNELS, GROUPS, GROUP_LABEL, KNOWN_STATUSES, relativeDay, STATUS_INFO, type OrderGroup, type OrderView } from "../history-model";
import { NO_FILTERS, useOrderHistory, type HistoryFilters } from "../use-order-history";

/** Dia do pedido em destaque para os próximos: "Amanhã, quarta-feira, 07/10 — Manhã". */
export function orderDayText(order: Pick<OrderView, "consumptionDate" | "shiftName">, today: string): string {
  const rel = relativeDay(order.consumptionDate, today, addDays(today, 1));
  return `${rel ? `${rel}, ` : ""}${longDayLabel(order.consumptionDate)}${order.shiftName ? ` — ${order.shiftName}` : ""}`;
}

/** Selo de situação: o texto distingue PAGO aguardando entrega de pagamento pendente; a cor nunca é o único sinal. */
export function StatusBadge({ order }: { order: Pick<OrderView, "status" | "statusLabel" | "paymentState" | "group"> }) {
  return (
    <span className={`badge badge-${order.paymentState === "pending" ? "warn" : order.group}`} data-testid="order-status" data-status={order.status} data-payment={order.paymentState}>
      {order.statusLabel}
    </span>
  );
}

/**
 * Portal: Meus pedidos. Responsável vê um filho ou todos os vinculados; aluno vê só os próprios (o servidor resolve o
 * aluno pela conta). Os pedidos vêm do servidor com os snapshots da compra; vínculo revogado remove o aluno do escopo.
 */
export function MyOrders({ user, role }: { user: User; role: Role }) {
  return role === "guardian" ? <GuardianOrders user={user} /> : <OrdersView user={user} role={role} family={null} />;
}

function GuardianOrders({ user }: { user: User }) {
  const family = useFamilyStudents(user.uid);
  if (family.status === "loading")
    return (
      <section>
        <h1>Meus pedidos</h1>
        <p role="status">Carregando os alunos…</p>
      </section>
    );
  if (family.status === "error")
    return (
      <section>
        <h1>Meus pedidos</h1>
        <p role="alert" className="notice notice-error">
          Não foi possível carregar os alunos vinculados.
        </p>
      </section>
    );
  if (family.students.length === 0)
    return (
      <section>
        <h1>Meus pedidos</h1>
        <p>Nenhum aluno vinculado a esta conta. Peça à escola o convite de vínculo.</p>
      </section>
    );
  return <OrdersView user={user} role="guardian" family={family.students.map((s) => ({ id: s.id, name: s.name }))} />;
}

function OrdersView({ user, role, family }: { user: User; role: Role; family: { id: string; name: string }[] | null }) {
  const [filters, setFilters] = useState<HistoryFilters>(NO_FILTERS);
  const ids = useMemo(() => (family ? family.map((s) => s.id) : []), [family]);
  // Aluno removido do escopo (vínculo revogado) deixa de ser filtro: a consulta volta a cobrir só os alunos atuais.
  const effective = filters.studentId && !ids.includes(filters.studentId) && family ? { ...filters, studentId: "" } : filters;
  const { state, reload, loadMore } = useOrderHistory(user, effective, role === "guardian" ? ids : [], ids);
  const today = localDateOf(new Date());
  const set = (patch: Partial<HistoryFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const detailStatuses = KNOWN_STATUSES.filter((s) => effective.group === "all" || STATUS_INFO[s]!.group === effective.group);
  const names = new Map([...(family ?? []), ...state.students].map((s) => [s.id, s.name]));

  return (
    <section data-testid="my-orders">
      <h1>Meus pedidos</h1>
      <p className="muted">Pedidos pagos com o saldo da carteira. Preços e nomes são os da data da compra.</p>

      <div role="group" aria-label="Situação dos pedidos" className="order-tabs">
        {GROUPS.map((g: OrderGroup) => (
          <button key={g} type="button" className={effective.group === g ? "" : "secondary"} aria-pressed={effective.group === g} onClick={() => set({ group: g, status: "" })} data-testid={`orders-tab-${g}`}>
            {GROUP_LABEL[g]}
          </button>
        ))}
      </div>

      <form className="toolbar toolbar-compact" aria-label="Filtros" onSubmit={(e) => e.preventDefault()}>
        {family && family.length > 1 && (
          <div className="field">
            <label htmlFor="of-student">Aluno</label>
            <select id="of-student" value={effective.studentId} onChange={(e) => set({ studentId: e.target.value })}>
              <option value="">Todos os alunos</option>
              {family.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="of-from">Consumo a partir de</label>
          <input id="of-from" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="of-to">Consumo até</label>
          <input id="of-to" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="of-channel">Canal</label>
          <select id="of-channel" value={filters.channel} onChange={(e) => set({ channel: e.target.value })}>
            <option value="">Todos os canais</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="of-shift">Turno</label>
          <select id="of-shift" value={filters.shiftId} onChange={(e) => set({ shiftId: e.target.value })}>
            <option value="">Todos os turnos</option>
            {state.shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="of-status">Situação detalhada</label>
          <select id="of-status" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Todas</option>
            {detailStatuses.map((s) => (
              <option key={s} value={s}>
                {STATUS_INFO[s]!.label}
              </option>
            ))}
          </select>
        </div>
      </form>

      <div role="status" aria-live="polite" data-testid="orders-feedback">
        {state.status === "loading" && <p>Carregando pedidos…</p>}
        {state.status === "ready" && state.refreshing && <p className="muted">Atualizando a lista…</p>}
      </div>
      {state.liveError && state.status === "ready" && <p className="muted">A atualização em tempo real está indisponível; use “Atualizar” para ver mudanças.</p>}
      {state.staleError && (
        <p role="alert" className="notice notice-error" data-testid="orders-stale">
          Não foi possível atualizar agora; a lista abaixo pode estar desatualizada.
        </p>
      )}
      {state.status === "error" && (
        <div role="alert" className="notice notice-error" data-testid="orders-error">
          <p>{errorText(state.errorCode ?? "internal")}</p>
          <button type="button" className="secondary" onClick={() => void reload()}>
            Tentar de novo
          </button>
        </div>
      )}
      {state.status === "ready" && state.orders.length === 0 && <p data-testid="orders-empty">Nenhum pedido encontrado com estes filtros.</p>}
      {state.status === "ready" && state.orders.length > 0 && (
        <ul className="plain-list order-list" data-testid="orders-list" aria-busy={state.refreshing}>
          {state.orders.map((o) => (
            <li key={o.orderId} className="order-row" data-testid="order-row" data-order={o.orderId}>
              <div className="order-head">
                <strong>{orderDayText(o, today)}</strong>
                <StatusBadge order={o} />
              </div>
              <p className="muted">
                {names.get(o.studentId) ?? o.studentName} · {CHANNEL_LABEL[o.channel as keyof typeof CHANNEL_LABEL] ?? "Compra"}
              </p>
              <p>
                {o.items
                  .map((i) => {
                    const notes = [i.deliveredQty > 0 && i.deliveredQty < i.quantity ? `${i.deliveredQty} entregue${i.deliveredQty > 1 ? "s" : ""}` : null, i.canceledQty > 0 ? `${i.canceledQty} cancelada${i.canceledQty > 1 ? "s" : ""}` : null].filter(Boolean);
                    return notes.length > 0 ? `${i.quantity}× ${i.name} (${notes.join(", ")})` : `${i.quantity}× ${i.name}`;
                  })
                  .join(", ")}
              </p>
              <p className="order-foot">
                <span>
                  Total <strong>{formatBRL(o.totalCents)}</strong>
                  {o.refundedCents > 0 && (
                    <span className="muted" data-testid="order-refunded">
                      {" "}
                      · devolvido à carteira {formatBRL(o.refundedCents)}
                    </span>
                  )}
                </span>
                <Link href={`/portal/pedidos/${o.orderId}`}>Detalhes e recibo</Link>
              </p>
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" && state.nextCursor && (
        <div>
          <button type="button" className="secondary" disabled={state.loadingMore} onClick={() => void loadMore()} data-testid="orders-more">
            {state.loadingMore ? "Carregando…" : "Carregar mais pedidos"}
          </button>
          {state.moreError && (
            <p role="alert" className="notice notice-error">
              Não foi possível carregar mais. Tente de novo.
            </p>
          )}
        </div>
      )}
      {state.status !== "loading" && (
        <p>
          <button type="button" className="secondary" disabled={state.refreshing} onClick={() => void reload()}>
            Atualizar
          </button>
        </p>
      )}
    </section>
  );
}
