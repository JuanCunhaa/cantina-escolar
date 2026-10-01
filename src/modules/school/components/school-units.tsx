"use client";

import { useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import { useUnits, type Unit } from "../use-units";

type Kind = "class" | "shift";

/** Administração: turmas e turnos. Arquivar mantém o histórico; só unidades ativas aceitam novos alunos. */
export function SchoolUnits({ user }: { user: User }) {
  const units = useUnits();
  return (
    <section>
      <h1>Turmas e turnos</h1>
      <p className="muted">Cadastro usado nos alunos, na busca do balcão e na importação CSV. Arquivar não apaga o histórico.</p>
      {units.status === "loading" && <p role="status">Carregando…</p>}
      {units.status === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar turmas e turnos.
        </p>
      )}
      <UnitSection user={user} kind="class" title="Turmas" label="Nome da turma" units={units.classes} />
      <UnitSection user={user} kind="shift" title="Turnos" label="Nome do turno" units={units.shifts} />
    </section>
  );
}

function UnitSection({ user, kind, title, label, units }: { user: User; kind: Kind; title: string; label: string; units: Unit[] }) {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function run(body: Record<string, unknown>, okText: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const result = await api(user, "POST", "/api/school", { key: newKey(), kind, ...body });
    setBusy(false);
    setMessage(result.ok ? { kind: "ok", text: okText } : { kind: "error", text: errorText(result.error) });
    return result.ok;
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name")).trim();
    if (await run({ action: "create", name }, `${title.slice(0, -1)} criado.`)) form.reset();
  }

  async function rename(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name")).trim();
    if (await run({ action: "rename", id, name }, "Nome alterado.")) setEditing(null);
  }

  return (
    <div className="product-section" data-testid={`units-${kind}`}>
      <h2>{title}</h2>
      <form onSubmit={(event) => void create(event)} className="inline-form">
        <label htmlFor={`new-${kind}`}>{label}</label>
        <input id={`new-${kind}`} name="name" type="text" required maxLength={60} autoComplete="off" />
        <button type="submit" disabled={busy}>
          Adicionar
        </button>
      </form>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"}>
          {message.text}
        </p>
      )}
      {units.length === 0 ? (
        <p className="muted">Nenhum cadastro ainda.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="muted">{title} cadastrados</caption>
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Situação</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => (
                <tr key={unit.id}>
                  <td>
                    {editing === unit.id ? (
                      <form onSubmit={(event) => void rename(event, unit.id)} className="inline-form">
                        <label htmlFor={`rename-${unit.id}`} className="visually-hidden">
                          Novo nome de {unit.name}
                        </label>
                        <input id={`rename-${unit.id}`} name="name" type="text" required maxLength={60} defaultValue={unit.name} autoFocus />
                        <button type="submit" disabled={busy}>
                          Salvar
                        </button>
                        <button type="button" className="secondary" onClick={() => setEditing(null)}>
                          Cancelar
                        </button>
                      </form>
                    ) : (
                      unit.name
                    )}
                  </td>
                  <td>
                    <span className={unit.status === "active" ? "tag" : "tag tag-off"}>{unit.status === "active" ? "Ativa" : "Arquivada"}</span>
                  </td>
                  <td>
                    <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(unit.id)} aria-label={`Renomear ${unit.name}`}>
                      Renomear
                    </button>{" "}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void run({ action: unit.status === "active" ? "archive" : "restore", id: unit.id }, unit.status === "active" ? "Arquivado." : "Restaurado.")}
                      aria-label={`${unit.status === "active" ? "Arquivar" : "Restaurar"} ${unit.name}`}
                    >
                      {unit.status === "active" ? "Arquivar" : "Restaurar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
