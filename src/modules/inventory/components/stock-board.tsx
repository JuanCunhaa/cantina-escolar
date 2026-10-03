"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { dayLabel } from "@/modules/menu/format";
import type { OverviewItem } from "../queries";
import { MODE_LABEL, MOVEMENT_LABEL, RECEIPT_KIND_LABEL, formatCost } from "../format";
import { useProductStock, useStockOverview } from "../use-stock";
import { CapacityForm, CountForm, EntryForm, ExtendControl, LossForm, ReverseControl, ThresholdForm } from "./stock-forms";

const alertsOf = (item: OverviewItem): string[] => {
  const out: string[] = [];
  if (item.lowStock) out.push("Estoque baixo");
  if (item.expiredUnits > 0) out.push(`${item.expiredUnits} vencida${item.expiredUnits > 1 ? "s" : ""}`);
  if (item.expiringUnits > 0) out.push(`${item.expiringUnits} vence${item.expiringUnits > 1 ? "m" : ""} em breve`);
  if (item.missingEntryUnits > 0) out.push(`Falta entrada de ${item.missingEntryUnits}`);
  return out;
};

/**
 * Estoque de produtos acabados (cantina consulta e registra perdas; administração registra entradas, inventário, ajustes
 * e cotas). Reserva não é saída: "Físico" é o que existe, "Reservado" o que pedidos já comprometeram e "Disponível" o que
 * ainda pode ser vendido hoje. Custos só aparecem para quem tem permissão (a API não os envia aos demais papéis).
 */
export function StockBoard({ user, canManage }: { user: User; canManage: boolean }) {
  const overview = useStockOverview(user);
  const [selected, setSelected] = useState<string | null>(null);
  const data = overview.data;
  const costs = data?.canSeeCosts ?? false;
  const alerts = (data?.items ?? []).flatMap((item) => alertsOf(item).map((text) => ({ item, text })));

  return (
    <section data-testid="stock-board">
      <h1>Estoque</h1>
      <p className="muted">
        Produtos acabados, sem ingredientes. <strong>Reservar não tira do estoque</strong>: a baixa só acontece na entrega ou na venda de balcão. Produto planejado só pode ser entregue depois de registrada a entrada correspondente.
      </p>
      {overview.status === "loading" && <p role="status">Carregando o estoque…</p>}
      {overview.status === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar o estoque agora. <button type="button" className="secondary" onClick={overview.reload}>Tentar de novo</button>
        </p>
      )}

      {alerts.length > 0 && (
        <div data-testid="stock-alerts">
          <h2>Atenção</h2>
          <ul>
            {alerts.map(({ item, text }) => (
              <li key={`${item.productId}-${text}`}>
                <strong>{item.name}</strong>: {text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && (
        <>
          <div className="row-actions">
            <h2>Produtos</h2>
            <button type="button" className="secondary" onClick={overview.reload}>
              Atualizar
            </button>
          </div>
          {data.items.length === 0 && <p className="muted">Nenhum produto cadastrado. Cadastre produtos em Produtos antes de controlar o estoque.</p>}
          <div className="table-scroll">
            <table className="data-table stock-table" data-testid="stock-table">
              <thead>
                <tr>
                  <th scope="col">Produto</th>
                  <th scope="col">Físico</th>
                  <th scope="col">Reservado</th>
                  <th scope="col">Disponível hoje</th>
                  <th scope="col">Alertas</th>
                  {costs && <th scope="col">Custo médio</th>}
                  {costs && <th scope="col">Valor em estoque</th>}
                  <th scope="col">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.productId} data-product={item.productId} data-selected={selected === item.productId}>
                    <th scope="row">
                      {item.name}
                      <br />
                      <span className="muted">
                        {MODE_LABEL[item.mode]}
                        {item.status === "inactive" ? " · desativado" : ""}
                      </span>
                    </th>
                    <td data-label="Físico" data-testid="stock-onhand">{item.onHand}</td>
                    <td data-label="Reservado" data-testid="stock-reserved">{item.reservedUnits}</td>
                    <td data-label="Disponível hoje" data-testid="stock-available">{item.availableUnits}</td>
                    <td data-label="Alertas">{alertsOf(item).join("; ") || "—"}</td>
                    {costs && <td data-label="Custo médio">{item.averageUnitMicros ? formatCost(item.averageUnitMicros) : "—"}</td>}
                    {costs && <td data-label="Valor em estoque">{formatCost(item.valueMicros ?? 0)}</td>}
                    <td>
                      <button type="button" className="secondary" aria-expanded={selected === item.productId} onClick={() => setSelected(selected === item.productId ? null : item.productId)}>
                        {selected === item.productId ? "Fechar" : "Abrir"}<span className="sr-only"> {item.name}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {selected && <StockDetail key={selected} user={user} productId={selected} canManage={canManage} onChanged={overview.reload} />}
    </section>
  );
}

function StockDetail({ user, productId, canManage, onChanged }: { user: User; productId: string; canManage: boolean; onChanged: () => void }) {
  const stock = useProductStock(user, productId);
  const view = stock.data;
  const changed = () => {
    stock.reload();
    onChanged();
  };

  if (!view) {
    return stock.status === "error" ? (
      <p role="alert" className="notice notice-error">
        Não foi possível abrir este produto. <button type="button" className="secondary" onClick={stock.reload}>Tentar de novo</button>
      </p>
    ) : (
      <p role="status">Carregando o produto…</p>
    );
  }
  const costs = view.canSeeCosts;
  const openLots = view.lots.filter((l) => l.remaining > 0);

  return (
    <div data-testid="stock-detail" data-product={productId}>
      <h2>{view.name}</h2>
      <p>
        {MODE_LABEL[view.mode]} · Físico <strong data-testid="detail-onhand">{view.onHand}</strong> · Reservado <strong>{view.reservedUnits}</strong>
        {costs && view.valueMicros !== undefined && (
          <>
            {" "}
            · Valor <strong>{formatCost(view.valueMicros)}</strong> · Custo médio <strong data-testid="detail-average">{view.averageUnitMicros ? formatCost(view.averageUnitMicros) : "—"}</strong>
          </>
        )}
        {view.minStock !== null && <> · Mínimo {view.minStock}</>}
      </p>

      <h3>Lotes e validade</h3>
      {openLots.length === 0 ? (
        <p className="muted">Nenhuma unidade em estoque.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table stock-table" data-testid="lots-table">
            <thead>
              <tr>
                <th scope="col">Lote</th>
                <th scope="col">Disponível desde</th>
                <th scope="col">Validade</th>
                <th scope="col">Restam</th>
                <th scope="col">Situação</th>
                {canManage && (
                  <th scope="col">
                    <span className="sr-only">Ações</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {openLots.map((lot) => (
                <tr key={lot.id}>
                  <th scope="row">{lot.lotCode ?? lot.id.slice(0, 12)}</th>
                  <td data-label="Disponível desde">{dayLabel(lot.availableOn)}</td>
                  <td data-label="Validade">{lot.validThrough === "9999-12-31" ? "sem validade" : dayLabel(lot.validThrough)}</td>
                  <td data-label="Restam">{lot.remaining}</td>
                  <td data-label="Situação">{lot.expired ? "Vencido: registre a perda" : "Válido"}</td>
                  {canManage && (
                    <td>
                      <ExtendControl user={user} productId={productId} lotId={lot.id} onDone={changed} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Reservas ativas (não são saída)</h3>
      {view.reservations.length === 0 ? (
        <p className="muted">Nenhuma reserva ativa.</p>
      ) : (
        <ul data-testid="reservations-list">
          {view.reservations.map((r) => (
            <li key={r.id}>
              {dayLabel(r.consumptionDate)} · {r.remaining} un. · pedido {r.orderRef}
            </li>
          ))}
        </ul>
      )}

      {view.mode === "planned" && (
        <>
          <h3>Cota por data e turno</h3>
          {view.capacities.length === 0 ? (
            <p className="muted">Nenhuma cota definida a partir de hoje. Sem cota, o produto planejado não aceita reservas.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table stock-table" data-testid="capacity-table">
                <thead>
                  <tr>
                    <th scope="col">Data</th>
                    <th scope="col">Cota</th>
                    <th scope="col">Reservado</th>
                    <th scope="col">Entregue</th>
                    <th scope="col">Ainda cabe</th>
                  </tr>
                </thead>
                <tbody>
                  {view.capacities.map((c) => (
                    <tr key={`${c.date}-${c.shiftId}`}>
                      <th scope="row">{dayLabel(c.date)}</th>
                      <td data-label="Cota">{c.capacity ?? "—"}</td>
                      <td data-label="Reservado">{c.reserved}</td>
                      <td data-label="Entregue">{c.delivered}</td>
                      <td data-label="Ainda cabe">{c.available}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h3>Registrar perda</h3>
      <LossForm user={user} view={view} onDone={changed} />

      {canManage && (
        <>
          <h3>Registrar entrada de produto acabado</h3>
          <EntryForm user={user} view={view} onDone={changed} />
          {view.mode === "planned" && (
            <>
              <h3>Definir cota</h3>
              <CapacityForm user={user} productId={productId} onDone={changed} />
            </>
          )}
          <h3>Inventário e ajuste</h3>
          <CountForm user={user} view={view} onDone={changed} />
          <ThresholdForm user={user} view={view} onDone={changed} />
        </>
      )}

      <h3>Movimentos</h3>
      {view.movements.length === 0 ? (
        <p className="muted">Sem movimentos.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table stock-table" data-testid="movements-table">
            <thead>
              <tr>
                <th scope="col">Nº</th>
                <th scope="col">Tipo</th>
                <th scope="col">Quantidade</th>
                <th scope="col">Saldo</th>
                <th scope="col">Motivo</th>
                {costs && <th scope="col">Custo total</th>}
                {costs && <th scope="col">Lucro bruto</th>}
              </tr>
            </thead>
            <tbody>
              {view.movements.map((m) => (
                <tr key={m.id}>
                  <th scope="row">{m.seq}</th>
                  <td data-label="Tipo">{MOVEMENT_LABEL[m.type] ?? m.type}</td>
                  <td data-label="Quantidade">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                  <td data-label="Saldo">{m.onHandAfter}</td>
                  <td data-label="Motivo">{m.reason ?? "—"}</td>
                  {costs && <td data-label="Custo total">{formatCost(Math.abs(m.totalCostMicros ?? 0))}</td>}
                  {costs && <td data-label="Lucro bruto">{m.grossProfitCents === null || m.grossProfitCents === undefined ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(m.grossProfitCents / 100)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {costs && view.receipts && (
        <>
          <h3>Entradas</h3>
          {view.receipts.length === 0 ? (
            <p className="muted">Nenhuma entrada registrada.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table stock-table" data-testid="receipts-table">
                <thead>
                  <tr>
                    <th scope="col">Tipo</th>
                    <th scope="col">Quantidade</th>
                    <th scope="col">Custo unitário</th>
                    <th scope="col">Total</th>
                    <th scope="col">Fornecedor / documento</th>
                    <th scope="col">Situação</th>
                    <th scope="col">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.receipts.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">{RECEIPT_KIND_LABEL[r.kind] ?? r.kind}</th>
                      <td data-label="Quantidade">{r.quantity}</td>
                      <td data-label="Custo unitário">{formatCost(r.unitCostMicros)}</td>
                      <td data-label="Total">{formatCost(r.totalCostMicros)}</td>
                      <td data-label="Fornecedor / documento">{[r.supplier, r.documentRef].filter(Boolean).join(" · ") || "—"}</td>
                      <td data-label="Situação">{r.status === "active" ? "Ativa" : "Estornada"}</td>
                      <td>{r.status === "active" && <ReverseControl user={user} receiptId={r.id} onDone={changed} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
