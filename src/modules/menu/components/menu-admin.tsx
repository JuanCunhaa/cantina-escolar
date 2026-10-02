"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import { addDays, localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import type { PublicProduct } from "@/modules/catalog/model";
import { useCatalog } from "@/modules/catalog/use-catalog";
import type { Unit } from "@/modules/school/use-units";
import { useUnits } from "@/modules/school/use-units";
import { dayLabel } from "../format";
import { MENU_LIMIT_MAX, MENU_MAX_FUTURE_DAYS, productMenuState, type DefaultRule, type MenuOverride } from "../model";
import { useDefaultRules, useMenuOverride, useOperatingDay, useUpcomingOverrides } from "../use-menu";

type Message = { kind: "ok" | "error"; text: string } | null;

function Note({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"}>
      {message.text}
    </p>
  );
}

/** Limite digitado → inteiro 1…5000; vazio = sem limite; inválido = undefined. */
function parseLimit(value: string): number | null | undefined {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d{1,4}$/.test(text)) return undefined;
  const limit = Number(text);
  return limit >= 1 && limit <= MENU_LIMIT_MAX ? limit : undefined;
}
const LIMIT_HELP = `Limite: número inteiro de 1 a ${MENU_LIMIT_MAX}.`;

/**
 * Operação: cardápio padrão por turno, exceções por data/turno (extra, ocultação, limite, suspensão) e próximas
 * exceções. Administração altera (comandos no servidor, com versão esperada e auditoria); cantina só consulta.
 * Alterações valem para novas compras: pedidos já confirmados não são cancelados nem alterados por esta tela.
 */
export function MenuAdmin({ user, canManage }: { user: User; canManage: boolean }) {
  const catalog = useCatalog(user.uid, { onlyActive: true });
  const units = useUnits();
  const defaults = useDefaultRules();
  const shifts = units.shifts.filter((s) => s.status === "active");
  const today = localDateOf(new Date());
  const [date, setDate] = useState(today);
  const [chosenShift, setChosenShift] = useState("");
  const shiftId = shifts.some((s) => s.id === chosenShift) ? chosenShift : (shifts[0]?.id ?? "");
  const loading = catalog.status === "loading" || units.status === "loading" || defaults.status === "loading";
  const failed = catalog.status === "error" || units.status === "error" || defaults.status === "error";

  return (
    <section>
      <h1>Cardápio</h1>
      <p className="muted">
        Cardápio padrão por turno e exceções por data. Alterações valem para novas compras; pedidos já confirmados não são cancelados nem alterados
        automaticamente.{!canManage && " Seu perfil pode consultar; alterações são da administração."}
      </p>
      {loading && <p role="status">Carregando o cardápio…</p>}
      {failed && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar o cardápio.
        </p>
      )}
      {!loading && !failed && shifts.length === 0 && <p className="muted">Cadastre turnos em “Turmas e turnos” para montar o cardápio.</p>}
      {!loading && !failed && shifts.length > 0 && (
        <>
          <DefaultMenu user={user} canManage={canManage} products={catalog.products} shifts={shifts} rules={defaults.rules} />
          <DayMenu
            user={user}
            canManage={canManage}
            today={today}
            date={date}
            onDate={setDate}
            shiftId={shiftId}
            onShift={setChosenShift}
            shifts={shifts}
            products={catalog.products}
            rules={defaults.rules}
          />
          <Upcoming
            today={today}
            shifts={units.shifts}
            onOpen={(nextDate, nextShift) => {
              setDate(nextDate);
              setChosenShift(nextShift);
              document.getElementById("menu-day")?.scrollIntoView({ block: "start" });
            }}
          />
        </>
      )}
    </section>
  );
}

function DefaultMenu({ user, canManage, products, shifts, rules }: { user: User; canManage: boolean; products: PublicProduct[]; shifts: Unit[]; rules: Map<string, DefaultRule> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  async function toggle(product: PublicProduct, shift: Unit, checked: boolean) {
    const rule = rules.get(product.id) ?? { productId: product.id, shiftIds: [], version: 0 };
    const kept = rule.shiftIds.filter((id) => id !== shift.id && product.shiftIds.includes(id));
    setBusy(product.id);
    setMessage(null);
    const result = await api(user, "POST", "/api/menu", {
      key: newKey(),
      action: "setDefault",
      productId: product.id,
      shiftIds: checked ? [...kept, shift.id] : kept,
      expectedVersion: rule.version,
    });
    setBusy(null);
    setMessage(
      result.ok
        ? { kind: "ok", text: `${product.name} ${checked ? "agora está no" : "saiu do"} cardápio padrão — ${shift.name}.` }
        : { kind: "error", text: errorText(result.error) },
    );
  }

  return (
    <div className="product-section" data-testid="menu-default">
      <h2 id="menu-default">Cardápio padrão</h2>
      <p className="muted">Produtos oferecidos em todo dia de funcionamento, por turno. Fora do padrão, o produto pode entrar como extra numa data.</p>
      <Note message={message} />
      {products.length === 0 ? (
        <p className="muted">Nenhum produto ativo. Cadastre produtos em “Produtos”.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Cardápio padrão por turno</caption>
            <thead>
              <tr>
                <th scope="col">Produto</th>
                {shifts.map((s) => (
                  <th scope="col" key={s.id}>
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const rule = rules.get(product.id);
                return (
                  <tr key={product.id} data-testid="default-row">
                    <th scope="row">
                      <span className="product-name">{product.name}</span> <span className="muted">· {formatBRL(product.priceCents)}</span>
                    </th>
                    {shifts.map((shift) => {
                      const sold = product.shiftIds.includes(shift.id);
                      const inMenu = sold && Boolean(rule?.shiftIds.includes(shift.id));
                      return (
                        <td key={shift.id}>
                          {!sold ? (
                            <span className="muted" title="O produto não é vendido neste turno">
                              —<span className="visually-hidden"> não vendido neste turno</span>
                            </span>
                          ) : canManage ? (
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={inMenu}
                                disabled={busy !== null}
                                onChange={(event) => void toggle(product, shift, event.target.checked)}
                              />
                              <span className="visually-hidden">
                                {product.name} no cardápio padrão — {shift.name}
                              </span>
                            </label>
                          ) : (
                            <span>{inMenu ? "No padrão" : "Fora"}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type DayProps = {
  user: User;
  canManage: boolean;
  today: string;
  date: string;
  onDate: (date: string) => void;
  shiftId: string;
  onShift: (shiftId: string) => void;
  shifts: Unit[];
  products: PublicProduct[];
  rules: Map<string, DefaultRule>;
};

function DayMenu({ user, canManage, today, date, onDate, shiftId, onShift, shifts, products, rules }: DayProps) {
  const { status, override } = useMenuOverride(date, shiftId);
  const operating = useOperatingDay(date);
  const [reason, setReason] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [extraId, setExtraId] = useState("");
  const [extraLimit, setExtraLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const shiftName = shifts.find((s) => s.id === shiftId)?.name ?? "";

  const rows = useMemo(
    () =>
      products
        .filter((p) => p.shiftIds.includes(shiftId))
        .map((product) => ({ product, state: productMenuState(product.id, shiftId, rules.get(product.id), override) }))
        .filter(({ state }) => state.inDefault || state.include === "extra"),
    [products, shiftId, rules, override],
  );
  const candidates = products.filter((p) => p.shiftIds.includes(shiftId) && !rules.get(p.id)?.shiftIds.includes(shiftId) && override?.items[p.id]?.include !== "extra");
  const editable = canManage && status === "ready" && override !== null && date >= today;

  async function send(body: Record<string, unknown>, okText: string): Promise<boolean> {
    if (!override) return false;
    setBusy(true);
    setMessage(null);
    const result = await api(user, "POST", "/api/menu", { key: newKey(), date, shiftId, expectedVersion: override.version, ...body });
    setBusy(false);
    setMessage(result.ok ? { kind: "ok", text: okText } : { kind: "error", text: errorText(result.error) });
    return result.ok;
  }

  /** Ocultar e suspender exigem motivo (auditoria); o servidor também recusa sem ele. */
  const withReason = (what: string, body: Record<string, unknown>, okText: string) => {
    if (!reason.trim()) return setMessage({ kind: "error", text: `Informe o motivo para ${what}.` });
    void send({ ...body, reason: reason.trim() }, okText);
  };

  async function saveLimit(product: PublicProduct, include: "default" | "extra", value: string | null) {
    const limit = value === null ? null : parseLimit(value);
    if (limit === undefined) return setMessage({ kind: "error", text: LIMIT_HELP });
    const done = await send(
      { action: "setItem", productId: product.id, include, limit, reason: reason.trim() },
      limit === null ? `${product.name}: sem limite nesta data.` : `${product.name}: limite de ${limit} nesta data.`,
    );
    // Limpa só se o campo ainda tem o valor enviado (o que foi digitado durante o envio não é descartado).
    if (done && value !== null) setDrafts((d) => (d[product.id] === value ? { ...d, [product.id]: "" } : d));
  }

  async function addExtra(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const product = products.find((p) => p.id === extraId);
    if (!product) return setMessage({ kind: "error", text: "Escolha o produto extra." });
    const limit = parseLimit(extraLimit);
    if (limit === undefined) return setMessage({ kind: "error", text: LIMIT_HELP });
    const sentLimit = extraLimit;
    const done = await send({ action: "setItem", productId: product.id, include: "extra", limit, reason: reason.trim() }, `${product.name}: extra em ${dayLabel(date)} (${shiftName}).`);
    // Limpa só o que ainda é o valor enviado (escolha feita durante o envio não é descartada).
    if (done) {
      setExtraId((current) => (current === product.id ? "" : current));
      setExtraLimit((current) => (current === sentLimit ? "" : current));
    }
  }

  return (
    <div className="product-section" data-testid="menu-day">
      <h2 id="menu-day">Exceções por data e turno</h2>
      <div className="toolbar">
        <div className="field">
          <label htmlFor="menu-date">Data</label>
          <input
            id="menu-date"
            type="date"
            value={date}
            min={today}
            max={addDays(today, MENU_MAX_FUTURE_DAYS)}
            onChange={(e) => {
              if (e.target.value) onDate(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="menu-shift">Turno</label>
          <select id="menu-shift" value={shiftId} onChange={(e) => onShift(e.target.value)}>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {date < today && <p className="muted">Data passada: consulta apenas.</p>}
      {operating === false && (
        <p className="notice notice-error" data-testid="day-closed">
          {dayLabel(date)} é dia sem funcionamento no calendário: nada é vendido nesta data, com ou sem exceção.
        </p>
      )}
      {status === "loading" && <p role="status">Carregando a data…</p>}
      {status === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar as exceções desta data.
        </p>
      )}

      {override && (
        <>
          <p data-testid="service-state">
            {override.suspended ? (
              <>
                <span className="tag tag-off">Atendimento suspenso</span> {override.serviceReason && <span className="muted">Motivo: {override.serviceReason}</span>}
              </>
            ) : (
              <span className="tag">Atendimento normal</span>
            )}
          </p>
          {editable && (
            <div className="inline-form">
              <label htmlFor="menu-reason">Motivo (fica na auditoria; não aparece para as famílias)</label>
              <input id="menu-reason" type="text" maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
              {override.suspended ? (
                <button type="button" className="secondary" disabled={busy} onClick={() => void send({ action: "setService", suspended: false, reason: reason.trim() }, "Atendimento retomado nesta data.")}>
                  Retomar atendimento
                </button>
              ) : (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => withReason("suspender o atendimento", { action: "setService", suspended: true }, "Atendimento suspenso nesta data e turno.")}
                >
                  Suspender atendimento
                </button>
              )}
            </div>
          )}
          <Note message={message} />

          <h3>
            Cardápio de {dayLabel(date)} — {shiftName}
          </h3>
          {rows.length === 0 ? (
            <p className="muted">Nenhum produto no cardápio padrão deste turno nem extra nesta data.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table day-table">
                <caption className="visually-hidden">Produtos da data e turno</caption>
                <thead>
                  <tr>
                    <th scope="col">Produto</th>
                    <th scope="col">Situação</th>
                    <th scope="col">Limite</th>
                    {editable && <th scope="col">Ações</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ product, state }) => {
                    const include = state.include === "extra" && !state.inDefault ? "extra" : "default";
                    const draft = drafts[product.id] ?? "";
                    return (
                      <tr key={product.id} data-testid="day-row">
                        <th scope="row">{product.name}</th>
                        <td>
                          {!state.offered ? (
                            <span className="tag tag-off">Oculto nesta data</span>
                          ) : state.source === "extra" ? (
                            <span className="tag">Extra</span>
                          ) : (
                            <span>Padrão</span>
                          )}
                        </td>
                        <td>{state.offered ? (state.limit !== null ? `${state.limit} un.` : "Sem limite") : "—"}</td>
                        {editable && (
                          <td>
                            <div className="day-actions">
                              {state.offered && (
                                <span className="limit-form">
                                  <input
                                    type="number"
                                    className="limit-input"
                                    inputMode="numeric"
                                    min={1}
                                    max={MENU_LIMIT_MAX}
                                    value={draft}
                                    placeholder="Limite"
                                    aria-label={`Novo limite de ${product.name}`}
                                    onChange={(e) => setDrafts((d) => ({ ...d, [product.id]: e.target.value }))}
                                  />
                                  <button
                                    type="button"
                                    className="secondary"
                                    disabled={busy || !draft.trim()}
                                    aria-label={`Salvar limite de ${product.name}`}
                                    onClick={() => void saveLimit(product, include, draft)}
                                  >
                                    Salvar limite
                                  </button>
                                  {state.limit !== null && (
                                    <button type="button" className="secondary" disabled={busy} aria-label={`Tirar limite de ${product.name}`} onClick={() => void saveLimit(product, include, null)}>
                                      Sem limite
                                    </button>
                                  )}
                                </span>
                              )}
                              {state.offered && state.source === "default" && (
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={busy}
                                  aria-label={`Ocultar ${product.name}`}
                                  onClick={() =>
                                    withReason("ocultar o produto", { action: "setItem", productId: product.id, include: "hidden", limit: null }, `${product.name}: oculto em ${dayLabel(date)}.`)
                                  }
                                >
                                  Ocultar
                                </button>
                              )}
                              {state.offered && state.source === "extra" && (
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={busy}
                                  aria-label={`Remover extra ${product.name}`}
                                  onClick={() => void send({ action: "setItem", productId: product.id, include: "default", limit: null, reason: reason.trim() }, `${product.name}: extra removido.`)}
                                >
                                  Remover extra
                                </button>
                              )}
                              {!state.offered && (
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={busy}
                                  aria-label={`Mostrar ${product.name}`}
                                  onClick={() => void send({ action: "setItem", productId: product.id, include: "default", limit: null, reason: reason.trim() }, `${product.name}: volta ao cardápio da data.`)}
                                >
                                  Mostrar
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {editable && (
            <form className="inline-form" onSubmit={(event) => void addExtra(event)} data-testid="add-extra">
              <label htmlFor="menu-extra">Adicionar produto extra nesta data e turno</label>
              <select id="menu-extra" value={extraId} onChange={(e) => setExtraId(e.target.value)}>
                <option value="">Escolha o produto…</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                className="limit-input"
                inputMode="numeric"
                min={1}
                max={MENU_LIMIT_MAX}
                value={extraLimit}
                placeholder="Sem limite"
                aria-label="Limite do extra (opcional)"
                onChange={(e) => setExtraLimit(e.target.value)}
              />
              <button type="submit" disabled={busy || !extraId}>
                Adicionar extra
              </button>
            </form>
          )}
          {editable && candidates.length === 0 && <p className="muted">Todos os produtos vendidos neste turno já estão no cardápio desta data.</p>}
        </>
      )}
    </div>
  );
}

function summary(o: MenuOverride): string {
  const values = Object.values(o.items);
  const parts: string[] = [];
  const extras = values.filter((i) => i.include === "extra").length;
  const hidden = values.filter((i) => i.include === "hidden").length;
  const limited = values.filter((i) => i.limit !== null).length;
  if (o.suspended) parts.push("atendimento suspenso");
  if (extras) parts.push(`${extras} extra${extras > 1 ? "s" : ""}`);
  if (hidden) parts.push(`${hidden} oculto${hidden > 1 ? "s" : ""}`);
  if (limited) parts.push(`${limited} com limite`);
  return parts.join(", ");
}

function Upcoming({ today, shifts, onOpen }: { today: string; shifts: Unit[]; onOpen: (date: string, shiftId: string) => void }) {
  const upcoming = useUpcomingOverrides(today);
  const names = new Map(shifts.map((s) => [s.id, s.name]));
  const list = upcoming.overrides.filter((o) => o.suspended || Object.keys(o.items).length > 0);
  return (
    <div className="product-section" data-testid="menu-upcoming">
      <h2>Próximas exceções</h2>
      {upcoming.status === "loading" && <p role="status">Carregando…</p>}
      {upcoming.status === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar as próximas exceções.
        </p>
      )}
      {upcoming.status === "ready" && list.length === 0 && <p className="muted">Nenhuma exceção a partir de hoje: vale o cardápio padrão.</p>}
      {list.length > 0 && (
        <ul className="plain-list">
          {list.map((o) => (
            <li key={`${o.date}__${o.shiftId}`}>
              <div className="row-actions">
                <span>
                  <strong>{dayLabel(o.date)}</strong> · {names.get(o.shiftId) ?? "Turno arquivado"} — {summary(o)}
                </span>
                <button type="button" className="secondary" onClick={() => onOpen(o.date, o.shiftId)} aria-label={`Abrir ${dayLabel(o.date)} ${names.get(o.shiftId) ?? ""}`}>
                  Abrir
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
