"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { addDays, localDateOf, weekEndOf, weekStartOf } from "@/lib/dates/school-time";
import { api, errorText, newKey } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { parseBRLToCents } from "@/lib/money/parse";
import type { Category, PublicProduct } from "@/modules/catalog/model";
import type { FamilyStudent } from "@/modules/guardians/use-family-students";
import { dayLabel, dayMonth } from "@/modules/menu/format";
import { MAX_ADVANCE_DAYS } from "@/modules/school/calendar";
import type { SetPolicyResult } from "../commands";
import { useStudentUsage } from "../use-usage";

type Message = { kind: "ok" | "error"; text: string };

const centsToInput = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","));

/**
 * Limites diário/semanal por DATA DO CONSUMO, bloqueios por categoria/produto, comprometimento já existente e
 * autorizações de exceção de um aluno. O servidor decide e audita; esta tela só envia comandos e mostra a leitura ao
 * vivo. Reduzir limite ou bloquear NÃO cancela pedidos já feitos: a tela mostra o que ficou acima do novo teto.
 */
export function PolicyPanel({ user, student, categories, products }: { user: User; student: FamilyStudent; categories: Category[]; products: PublicProduct[] }) {
  const usage = useStudentUsage(student.id);
  const [daily, setDaily] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [existing, setExisting] = useState<SetPolicyResult["existingCommitments"]>([]);
  const [authDate, setAuthDate] = useState("");
  const [authValue, setAuthValue] = useState("");

  const today = localDateOf(new Date());
  const dates = Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));
  const weeks = [...new Set(dates.map(weekStartOf))];
  const dailyText = daily ?? centsToInput(student.dailyLimitCents);
  const weeklyText = weekly ?? centsToInput(student.weeklyLimitCents);

  async function save(change: Record<string, unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    const result = await api<SetPolicyResult>(user, "POST", "/api/policies", { key: newKey(), studentId: student.id, expectedConfigVersion: student.configVersion, ...change });
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: errorText(result.error) });
      return;
    }
    setExisting(result.data.existingCommitments);
    setDaily(null);
    setWeekly(null);
    setMessage({ kind: "ok", text: success });
  }

  function saveLimits(event: React.FormEvent) {
    event.preventDefault();
    const parse = (text: string): number | null | undefined => (text.trim() === "" ? null : (parseBRLToCents(text) ?? undefined));
    const dailyCents = parse(dailyText);
    const weeklyCents = parse(weeklyText);
    if (dailyCents === undefined || weeklyCents === undefined) {
      setMessage({ kind: "error", text: "Informe valores em reais, como 10,00, ou deixe em branco para não ter limite." });
      return;
    }
    void save({ dailyLimitCents: dailyCents, weeklyLimitCents: weeklyCents }, "Limites salvos. Valem para novas compras; pedidos já feitos não foram alterados.");
  }

  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  const blockedProducts = new Set(student.blockedProductIds);
  const blockedCategories = new Set(student.blockedCategoryIds);
  const nameOfProduct = new Map(products.map((p) => [p.id, p.name]));

  async function authorize(event: React.FormEvent) {
    event.preventDefault();
    const cents = parseBRLToCents(authValue);
    if (!authDate || cents === null) {
      setMessage({ kind: "error", text: "Escolha a data do consumo e informe o valor máximo em reais." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await api(user, "POST", "/api/policies/exceptions", { key: newKey(), action: "create", studentId: student.id, consumptionDate: authDate, maxCents: cents, reason: "Autorização do responsável" });
    setBusy(false);
    if (!result.ok) setMessage({ kind: "error", text: errorText(result.error) });
    else {
      setAuthDate("");
      setAuthValue("");
      setMessage({ kind: "ok", text: "Autorização criada: vale para uma única compra autônoma dessa data, até o valor informado." });
    }
  }
  async function revoke(exceptionId: string) {
    setBusy(true);
    setMessage(null);
    const result = await api(user, "POST", "/api/policies/exceptions", { key: newKey(), action: "revoke", studentId: student.id, exceptionId, reason: "Revogada pelo responsável" });
    setBusy(false);
    setMessage(result.ok ? { kind: "ok", text: "Autorização revogada." } : { kind: "error", text: errorText(result.error) });
  }

  const limit = (cents: number | null) => (cents === null ? "sem limite" : formatBRL(cents));
  const remaining = (committed: number, cap: number | null) => (cap === null ? "—" : formatBRL(Math.max(0, cap - committed)));
  const sessionNote = usage.status === "error" ? "Não foi possível carregar o comprometimento agora." : usage.status === "loading" ? "Carregando comprometimento…" : null;

  return (
    <div data-testid="policy-panel" data-student={student.id}>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid="policy-message">
          {message.text}
        </p>
      )}
      <h3>Limites por data de consumo</h3>
      <p className="muted">
        O limite vale para a data em que o aluno consome, não para o dia do pagamento. Sem limite significa sem teto definido por você; o saldo da carteira continua sendo exigido. A semana vai de segunda a
        domingo.
      </p>
      <form onSubmit={saveLimits} className="form-grid" aria-label={`Limites de ${student.name}`}>
        <div className="field">
          <label htmlFor={`daily-${student.id}`}>Limite diário (R$)</label>
          <input id={`daily-${student.id}`} inputMode="decimal" placeholder="sem limite" value={dailyText} onChange={(e) => setDaily(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`weekly-${student.id}`}>Limite semanal (R$)</label>
          <input id={`weekly-${student.id}`} inputMode="decimal" placeholder="sem limite" value={weeklyText} onChange={(e) => setWeekly(e.target.value)} />
        </div>
        <div className="field">
          <button type="submit" disabled={busy || student.status !== "active"}>
            Salvar limites
          </button>
        </div>
      </form>

      {existing.length > 0 && (
        <div role="status" className="notice" data-testid="existing-commitments">
          <p>
            <strong>Compromissos já existentes acima do novo limite — mantidos, nada foi cancelado:</strong>
          </p>
          <ul>
            {existing.map((c) => (
              <li key={`${c.scope}-${c.key}`}>
                {c.scope === "day" ? `Dia ${dayLabel(c.key)}` : `Semana ${dayMonth(c.key)} a ${dayMonth(weekEndOf(c.key))}`}: {formatBRL(c.committedCents)} comprometidos (limite {formatBRL(c.limitCents)}, excesso{" "}
            {formatBRL(c.excessCents)}). Novas compras autônomas nesse período ficam bloqueadas.
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>Comprometimento por data</h3>
      <p className="muted">Pedidos antecipados ativos, valores já entregues e compras de balcão do dia. Reembolso libera o valor devido.</p>
      {sessionNote && (
        <p role={usage.status === "error" ? "alert" : "status"} className={usage.status === "error" ? "notice notice-error" : "muted"}>
          {sessionNote}
        </p>
      )}
      <div className="table-scroll">
        <table className="data-table" data-testid="usage-days">
          <caption className="muted" style={{ textAlign: "left" }}>
            Próximos dias (hoje até {dayMonth(dates[dates.length - 1]!)})
          </caption>
          <thead>
            <tr>
              <th scope="col">Data</th>
              <th scope="col">Comprometido</th>
              <th scope="col">Limite diário</th>
              <th scope="col">Ainda cabe</th>
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => {
              const used = usage.days[d] ?? 0;
              return (
                <tr key={d} data-date={d}>
                  <th scope="row">{dayLabel(d)}</th>
                  <td>{formatBRL(used)}</td>
                  <td>{limit(student.dailyLimitCents)}</td>
                  <td>{remaining(used, student.dailyLimitCents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-scroll">
        <table className="data-table" data-testid="usage-weeks">
          <caption className="muted" style={{ textAlign: "left" }}>
            Semanas (segunda a domingo)
          </caption>
          <thead>
            <tr>
              <th scope="col">Semana</th>
              <th scope="col">Comprometido</th>
              <th scope="col">Limite semanal</th>
              <th scope="col">Ainda cabe</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => {
              const used = usage.weeks[w] ?? 0;
              return (
                <tr key={w} data-week={w}>
                  <th scope="row">
                    {dayMonth(w)} a {dayMonth(weekEndOf(w))}
                  </th>
                  <td>{formatBRL(used)}</td>
                  <td>{limit(student.weeklyLimitCents)}</td>
                  <td>{remaining(used, student.weeklyLimitCents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>Bloqueios</h3>
      <p className="muted">
        Valem para compras do aluno no site e no balcão. Você, responsável, pode comprar mesmo assim, confirmando na tela; a compra continua contando como consumo. Bloquear não cancela pedidos já feitos.
      </p>
      <fieldset disabled={busy || student.status !== "active"}>
        <legend>Categorias bloqueadas</legend>
        {categories.filter((c) => c.status === "active").length === 0 && <p className="muted">Nenhuma categoria cadastrada.</p>}
        <ul className="plain-list">
          {categories
            .filter((c) => c.status === "active" || blockedCategories.has(c.id))
            .map((c) => (
              <li key={c.id}>
                <input
                  id={`cat-${student.id}-${c.id}`}
                  type="checkbox"
                  checked={blockedCategories.has(c.id)}
                  onChange={(e) => void save({ blockedCategoryIds: toggle(student.blockedCategoryIds, c.id, e.target.checked) }, "Bloqueios atualizados.")}
                />{" "}
                <label htmlFor={`cat-${student.id}-${c.id}`}>{c.name}</label>
              </li>
            ))}
        </ul>
      </fieldset>
      <fieldset disabled={busy || student.status !== "active"}>
        <legend>Produtos bloqueados{student.blockedProductIds.length > 0 ? ` (${student.blockedProductIds.length})` : ""}</legend>
        {student.blockedProductIds.length > 0 && (
          <p className="muted" data-testid="blocked-products">
            Bloqueados: {student.blockedProductIds.map((id) => nameOfProduct.get(id) ?? "produto indisponível").join(", ")}.
          </p>
        )}
        <ul className="plain-list">
          {products.map((p) => (
            <li key={p.id}>
              <input
                id={`prd-${student.id}-${p.id}`}
                type="checkbox"
                checked={blockedProducts.has(p.id)}
                onChange={(e) => void save({ blockedProductIds: toggle(student.blockedProductIds, p.id, e.target.checked) }, "Bloqueios atualizados.")}
              />{" "}
              <label htmlFor={`prd-${student.id}-${p.id}`}>
                {p.name} <span className="muted">· {formatBRL(p.priceCents)}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <h3>Autorizar uma compra específica</h3>
      <p className="muted">
        Permite uma única compra autônoma do aluno (inclusive no balcão) acima dos limites ou de um bloqueio, para a data e o valor máximo que você informar. Não substitui a permissão de compra, nem vale para outras
        datas.
      </p>
      <form onSubmit={(e) => void authorize(e)} className="form-grid" aria-label={`Autorizar compra de ${student.name}`}>
        <div className="field">
          <label htmlFor={`auth-date-${student.id}`}>Data do consumo</label>
          <select id={`auth-date-${student.id}`} value={authDate} onChange={(e) => setAuthDate(e.target.value)}>
            <option value="">Escolha a data</option>
            {dates.map((d) => (
              <option key={d} value={d}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`auth-value-${student.id}`}>Valor máximo (R$)</label>
          <input id={`auth-value-${student.id}`} inputMode="decimal" value={authValue} onChange={(e) => setAuthValue(e.target.value)} />
        </div>
        <div className="field">
          <button type="submit" className="secondary" disabled={busy || student.status !== "active"}>
            Autorizar
          </button>
        </div>
      </form>
      {usage.exceptions.length > 0 && (
        <ul className="plain-list" data-testid="active-exceptions">
          {usage.exceptions.map((e) => (
            <li key={e.id}>
              {dayLabel(e.consumptionDate)} · até {formatBRL(e.maxCents)} · {e.kind === "admin" ? "exceção da administração" : "autorização do responsável"}{" "}
              <button type="button" className="secondary" disabled={busy} onClick={() => void revoke(e.id)}>
                Revogar
              </button>
            </li>
          ))}
        </ul>
      )}

    </div>
  );
}
