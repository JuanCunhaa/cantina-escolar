"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { collection, onSnapshot } from "firebase/firestore";
import { api, errorText, newKey } from "@/lib/api-client";
import { getFirebaseClient } from "@/lib/firebase/client";
import { DEFAULT_CUTOFFS } from "../calendar";
import { useUnits } from "../use-units";

type Settings = { schoolName: string; weekdays: number[]; shiftPolicies: Record<string, { purchaseCutoff: string; cancelCutoff: string }>; version: number };
type Exception = { date: string; kind: "extra" | "closed"; reason: string };
type WindowDay = { date: string; operating: boolean; allowed: boolean; reason: string | null; purchaseCutoffAt: string | null; cancelCutoffAt: string | null };
type PurchaseWindow = { today: string; serverNow: string; cutoffs: { purchaseCutoff: string; cancelCutoff: string }; days: WindowDay[] };
type Message = { kind: "ok" | "error"; text: string } | null;

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const REASONS: Record<string, string> = {
  past_date: "Data passada",
  beyond_window: "Além de 7 dias",
  non_operating_day: "Sem funcionamento",
  after_cutoff: "Horário encerrado",
  invalid_date: "Data inválida",
};

const dateFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const dateLabel = (date: string) => dateFormat.format(new Date(`${date}T12:00:00-03:00`));

function Note({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"}>
      {message.text}
    </p>
  );
}

/** Administração: identidade da escola, dias de funcionamento, horários por turno e dias extras/fechados. */
export function SchoolCalendar({ user }: { user: User }) {
  return (
    <section>
      <h1>Calendário e horários</h1>
      <p className="muted">Datas e horários em America/Sao_Paulo. Alterações valem para novos pedidos; pedidos já feitos mantêm os horários informados na compra.</p>
      <SettingsForm user={user} />
      <Exceptions user={user} />
      <WindowPreview user={user} />
    </section>
  );
}

function SettingsForm({ user }: { user: User }) {
  const units = useUnits();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  const [reloads, setReloads] = useState(0);
  const load = useCallback(() => setReloads((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    void api<Settings>(user, "GET", "/api/school/settings").then((result) => {
      if (!alive) return;
      if (result.ok) setSettings(result.data);
      setLoadError(!result.ok);
    });
    return () => {
      alive = false;
    };
  }, [user, reloads]);

  const shifts = units.shifts.filter((s) => s.status === "active");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    const form = new FormData(event.currentTarget);
    const weekdays = WEEKDAYS.map((_, i) => i).filter((i) => form.get(`weekday-${i}`) === "on");
    const shiftPolicies: Settings["shiftPolicies"] = {};
    for (const shift of shifts) {
      const purchaseCutoff = String(form.get(`purchase-${shift.id}`) ?? "");
      const cancelCutoff = String(form.get(`cancel-${shift.id}`) ?? "");
      if (purchaseCutoff && cancelCutoff) shiftPolicies[shift.id] = { purchaseCutoff, cancelCutoff };
    }
    setBusy(true);
    setMessage(null);
    const result = await api<{ version: number }>(user, "POST", "/api/school/settings", {
      key: newKey(),
      expectedVersion: settings.version,
      schoolName: String(form.get("schoolName")).trim(),
      weekdays,
      shiftPolicies,
    });
    setBusy(false);
    if (result.ok) {
      setMessage({ kind: "ok", text: "Configurações salvas. Valem para novos pedidos." });
      load();
    } else {
      setMessage({ kind: "error", text: result.error === "stale_settings" ? "Outra pessoa alterou as configurações. Os dados foram recarregados; revise e salve de novo." : errorText(result.error) });
      if (result.error === "stale_settings") load();
    }
  }

  if (loadError) return <p role="alert" className="notice notice-error">Não foi possível carregar as configurações.</p>;
  if (!settings || units.status === "loading") return <p role="status">Carregando…</p>;

  return (
    <form key={settings.version} onSubmit={(event) => void save(event)} className="product-section" data-testid="school-settings">
      <h2>Escola, dias e horários</h2>
      <p>
        <label htmlFor="schoolName">Nome da escola</label>{" "}
        <input id="schoolName" name="schoolName" type="text" required maxLength={80} defaultValue={settings.schoolName} autoComplete="off" />
      </p>
      <fieldset>
        <legend>Dias de funcionamento</legend>
        {WEEKDAYS.map((name, i) => (
          <label key={name} style={{ marginRight: "1rem", whiteSpace: "nowrap" }}>
            <input type="checkbox" name={`weekday-${i}`} defaultChecked={settings.weekdays.includes(i)} /> {name}
          </label>
        ))}
      </fieldset>
      <h3>Horários por turno</h3>
      <p className="muted">A compra antecipada do próprio dia encerra e o cancelamento familiar encerra exatamente no horário indicado (agora ≥ limite).</p>
      {shifts.length === 0 ? (
        <p className="muted">Cadastre turnos em “Turmas e turnos” para definir horários.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Horários por turno</caption>
            <thead>
              <tr>
                <th scope="col">Turno</th>
                <th scope="col">Fecha compra no dia</th>
                <th scope="col">Fecha cancelamento</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((shift) => {
                const slug = shift.name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
                const policy = settings.shiftPolicies[shift.id] ?? DEFAULT_CUTOFFS[slug];
                return (
                  <tr key={shift.id}>
                    <th scope="row">{shift.name}</th>
                    <td>
                      <input type="time" name={`purchase-${shift.id}`} aria-label={`Fecha compra — ${shift.name}`} defaultValue={policy?.purchaseCutoff ?? ""} />
                    </td>
                    <td>
                      <input type="time" name={`cancel-${shift.id}`} aria-label={`Fecha cancelamento — ${shift.name}`} defaultValue={policy?.cancelCutoff ?? ""} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p>
        <button type="submit" disabled={busy}>
          Salvar configurações
        </button>
      </p>
      <Note message={message} />
    </form>
  );
}

function Exceptions({ user }: { user: User }) {
  const [days, setDays] = useState<Exception[] | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const { db } = getFirebaseClient();
    return onSnapshot(
      collection(db, "calendarDays"),
      (snap) =>
        setDays(
          snap.docs
            .map((d) => ({ date: d.id, kind: d.data().kind === "closed" ? ("closed" as const) : ("extra" as const), reason: String(d.data().reason ?? "") }))
            .sort((a, b) => a.date.localeCompare(b.date)),
        ),
      () => setMessage({ kind: "error", text: "Não foi possível carregar os dias extras e fechados." }),
    );
  }, []);

  async function run(body: Record<string, unknown>, okText: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const result = await api(user, "POST", "/api/school/calendar", { key: newKey(), ...body });
    setBusy(false);
    setMessage(result.ok ? { kind: "ok", text: okText } : { kind: "error", text: errorText(result.error) });
    return result.ok;
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const ok = await run({ action: "set", date: String(data.get("date")), kind: String(data.get("kind")), reason: String(data.get("reason")).trim() }, "Dia salvo. Vale para novos pedidos.");
    if (ok) form.reset();
  }

  return (
    <div className="product-section" data-testid="calendar-days">
      <h2>Dias letivos extras e dias fechados</h2>
      <form onSubmit={(event) => void add(event)} className="inline-form">
        <label htmlFor="day-date">Data</label>
        <input id="day-date" name="date" type="date" required />
        <label htmlFor="day-kind">Tipo</label>
        <select id="day-kind" name="kind" defaultValue="extra">
          <option value="extra">Dia letivo extra</option>
          <option value="closed">Sem funcionamento</option>
        </select>
        <label htmlFor="day-reason">Motivo</label>
        <input id="day-reason" name="reason" type="text" maxLength={120} autoComplete="off" />
        <button type="submit" disabled={busy}>
          Salvar dia
        </button>
      </form>
      <Note message={message} />
      {days === null ? (
        <p role="status">Carregando…</p>
      ) : days.length === 0 ? (
        <p className="muted">Nenhum dia extra ou fechado cadastrado.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Dias extras e fechados</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Tipo</th>
                <th scope="col">Motivo</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td>{dateLabel(d.date)} · {d.date.split("-").reverse().join("/")}</td>
                  <td>
                    <span className={d.kind === "extra" ? "tag" : "tag tag-off"}>{d.kind === "extra" ? "Letivo extra" : "Fechado"}</span>
                  </td>
                  <td>{d.reason || "—"}</td>
                  <td>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void run({ action: "clear", date: d.date }, "Dia removido.")} aria-label={`Remover ${d.date}`}>
                      Remover
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">Dias passados não podem ser alterados. Pedidos futuros já feitos não são alterados por estas datas; revisão explícita dos afetados chega com os pedidos.</p>
    </div>
  );
}

function WindowPreview({ user }: { user: User }) {
  const units = useUnits();
  const [shiftId, setShiftId] = useState("");
  const [window, setWindow] = useState<PurchaseWindow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shifts = units.shifts.filter((s) => s.status === "active");

  useEffect(() => {
    if (!shiftId) return;
    let alive = true;
    void api<PurchaseWindow>(user, "GET", `/api/school/calendar?shiftId=${encodeURIComponent(shiftId)}`).then((result) => {
      if (!alive) return;
      setWindow(result.ok ? result.data : null);
      setError(result.ok ? null : errorText(result.error));
    });
    return () => {
      alive = false;
    };
  }, [shiftId, user]);

  return (
    <div className="product-section" data-testid="purchase-window">
      <h2>Janela de compra (hoje até hoje+7)</h2>
      <p>
        <label htmlFor="window-shift">Turno</label>{" "}
        <select id="window-shift" value={shiftId} onChange={(event) => setShiftId(event.target.value)}>
          <option value="">Selecione…</option>
          {shifts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </p>
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      {window && (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Janela de compra do turno</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Compra</th>
                <th scope="col">Fecha compra</th>
                <th scope="col">Fecha cancelamento</th>
              </tr>
            </thead>
            <tbody>
              {window.days.map((d) => (
                <tr key={d.date}>
                  <td>{dateLabel(d.date)}</td>
                  <td>
                    <span className={d.allowed ? "tag" : "tag tag-off"}>{d.allowed ? "Permitida" : (REASONS[d.reason ?? ""] ?? "Indisponível")}</span>
                  </td>
                  <td>{d.purchaseCutoffAt ? timeFormat.format(new Date(d.purchaseCutoffAt)) : "—"}</td>
                  <td>{d.cancelCutoffAt ? timeFormat.format(new Date(d.cancelCutoffAt)) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
