"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { addDays, localDateOf } from "@/lib/dates/school-time";
import { api } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { dayLabel, longDayLabel } from "@/modules/menu/format";
import type { DayOrders, Preparation, PrepRow } from "../fulfillment-model";
import { downloadCsv, useServerQuery } from "../use-operations";

function initialDate(): string {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return params.get("date") ?? localDateOf(new Date());
}

/** Previsão: uma linha por produto/turno e uma coluna por dia (hoje … hoje+6), com as unidades agendadas ainda ativas. */
function ForecastTable({ data, shiftName }: { data: Preparation; shiftName: (id: string) => string }) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(data.forecastFrom, i)), [data.forecastFrom]);
  const lines = useMemo(() => {
    const map = new Map<string, { name: string; shiftId: string; byDay: Record<string, PrepRow> }>();
    for (const r of data.forecast) {
      const key = `${r.shiftId}|${r.productId}`;
      const line = map.get(key) ?? { name: r.name, shiftId: r.shiftId, byDay: {} };
      line.byDay[r.consumptionDate] = r;
      map.set(key, line);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.shiftId.localeCompare(b.shiftId));
  }, [data.forecast]);
  if (lines.length === 0) return <p className="muted">Nenhum pedido agendado para os próximos sete dias.</p>;
  return (
    <div className="table-scroll">
      <table className="data-table" data-testid="forecast-table">
        <caption className="visually-hidden">Previsão de unidades a preparar nos próximos sete dias</caption>
        <thead>
          <tr>
            <th scope="col">Produto</th>
            <th scope="col">Turno</th>
            {days.map((d) => (
              <th scope="col" key={d}>
                {dayLabel(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.shiftId}|${l.name}`}>
              <th scope="row">{l.name}</th>
              <td>{shiftName(l.shiftId)}</td>
              {days.map((d) => {
                const r = l.byDay[d];
                const units = r ? r.scheduled - r.canceled : 0;
                return <td key={d}>{units > 0 ? units : "—"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "O que preparar": totais por produto/data/turno, previsão de sete dias, impressão/CSV e pendências de resolução. */
export function PreparationBoard({ user }: { user: User }) {
  const [date, setDate] = useState(initialDate);
  const [shiftId, setShiftId] = useState("");
  const [exportError, setExportError] = useState(false);
  const params = new URLSearchParams({ date });
  if (shiftId) params.set("shiftId", shiftId);
  const panel = useServerQuery<Preparation>(user, "/api/operations/preparation", params.toString());
  const data = panel.data;
  const shiftName = (id: string) => data?.shifts.find((s) => s.id === id)?.name ?? "—";

  async function exportNominal() {
    setExportError(false);
    const q = new URLSearchParams({ date });
    if (shiftId) q.set("shiftId", shiftId);
    const result = await api<DayOrders>(user, "GET", `/api/operations/orders?${q.toString()}`);
    if (!result.ok || result.data.truncated) return setExportError(true); // lista incompleta nunca vira arquivo "completo"
    const rows: (string | number)[][] = [["Data", "Turno", "Turma", "Aluno", "Produto", "Quantidade", "Entregues", "Restantes", "Situação"]];
    for (const o of result.data.orders) for (const i of o.items) rows.push([o.consumptionDate, o.shiftName ?? "", o.className ?? "", o.studentName, i.name, i.quantity, i.deliveredQty, i.remainingQty, o.statusLabel]);
    downloadCsv(`lista-nominal-${date}.csv`, rows);
  }
  function exportProduction() {
    if (!data) return;
    const rows: (string | number)[][] = [["Data", "Turno", "Produto", "Agendadas", "Canceladas", "Entregues", "Restantes", "Não retiradas"]];
    for (const r of data.rows) rows.push([r.consumptionDate, shiftName(r.shiftId), r.name, r.scheduled, r.canceled, r.delivered, r.remaining, r.notPickedUp]);
    downloadCsv(`producao-${date}.csv`, rows);
  }

  return (
    <section data-testid="preparation">
      <h1>O que preparar</h1>
      <div className="form-grid toolbar toolbar-compact no-print">
        <div className="field">
          <label htmlFor="p-date">Data</label>
          <input id="p-date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-shift">Turno</label>
          <select id="p-shift" value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
            <option value="">Todos</option>
            {(data?.shifts ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="row-actions no-print">
        <button type="button" className="secondary" onClick={panel.reload} disabled={panel.refreshing}>
          {panel.refreshing ? "Atualizando…" : "Atualizar"}
        </button>
        <button type="button" className="secondary" onClick={() => window.print()}>
          Imprimir
        </button>
        <button type="button" className="secondary" onClick={exportProduction} disabled={!data}>
          Exportar produção (CSV)
        </button>
        <button type="button" className="secondary" onClick={() => void exportNominal()}>
          Exportar lista nominal (CSV)
        </button>
        <Link href={`/operacao/pedidos?date=${date}`}>Pedidos do dia</Link>
      </p>
      {exportError && (
        <p role="alert" className="notice notice-error">
          Não foi possível gerar a lista nominal completa agora (falha de leitura ou mais pedidos que o limite: filtre por turno).
        </p>
      )}
      {panel.status === "loading" && <p role="status">Carregando…</p>}
      {panel.status === "error" && (
        <p role="alert" className="notice notice-error" data-testid="prep-error">
          {panel.errorCode === "forbidden" ? "Seu perfil não consulta a preparação." : "Não foi possível carregar o painel."}{" "}
          <button type="button" className="secondary" onClick={panel.reload}>
            Tentar de novo
          </button>
        </p>
      )}
      {data && (
        <>
          {data.truncated && (
            <p role="alert" className="notice notice-error">
              Há pedidos além do limite de leitura: os totais podem estar incompletos. Refine por turno.
            </p>
          )}
          <h2>{longDayLabel(data.date)}</h2>
          {data.rows.length === 0 ? (
            <p className="muted">Nenhum pedido para esta data e turno.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table" data-testid="prep-table">
                <caption className="visually-hidden">Totais por produto e turno</caption>
                <thead>
                  <tr>
                    <th scope="col">Produto</th>
                    <th scope="col">Turno</th>
                    <th scope="col">Agendadas</th>
                    <th scope="col">Canceladas</th>
                    <th scope="col">Entregues</th>
                    <th scope="col">Restantes</th>
                    <th scope="col">Não retiradas</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={`${r.shiftId}|${r.productId}`} data-testid="prep-row">
                      <th scope="row">{r.name}</th>
                      <td>{shiftName(r.shiftId)}</td>
                      <td>{r.scheduled}</td>
                      <td>{r.canceled}</td>
                      <td>{r.delivered}</td>
                      <td>
                        <strong>{r.remaining}</strong>
                      </td>
                      <td>{r.notPickedUp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>Próximos sete dias</h2>
          <p className="muted">
            De {longDayLabel(data.forecastFrom)} a {longDayLabel(data.forecastTo)}: unidades agendadas ativas por produto e turno.
          </p>
          <ForecastTable data={data} shiftName={shiftName} />

          <h2>Pendências de resolução</h2>
          {data.attention.length === 0 ? (
            <p className="muted" data-testid="attention-empty">
              Nenhum pedido não retirado aguardando decisão.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table" data-testid="attention-table">
                <caption className="visually-hidden">Pedidos não retirados ou vencidos sem entrega</caption>
                <thead>
                  <tr>
                    <th scope="col">Aluno</th>
                    <th scope="col">Data</th>
                    <th scope="col">Turno</th>
                    <th scope="col">Unidades</th>
                    <th scope="col">Valor pago</th>
                    <th scope="col">Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {data.attention.map((a) => (
                    <tr key={a.orderId}>
                      <th scope="row">{a.studentName}</th>
                      <td>
                        <Link href={`/operacao/pedidos?date=${a.consumptionDate}`}>{dayLabel(a.consumptionDate)}</Link>
                      </td>
                      <td>{shiftName(a.shiftId)}</td>
                      <td>{a.remainingUnits}</td>
                      <td>{formatBRL(a.remainingCents)}</td>
                      <td>{a.marked ? "Não retirado: aguarda a administração" : "Data passada sem entrega: marcar como não retirado"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">Reembolso (F14) e reagendamento (F16) ainda não existem: os casos acima seguem pendentes e visíveis até uma resolução registrada.</p>
        </>
      )}
    </section>
  );
}
