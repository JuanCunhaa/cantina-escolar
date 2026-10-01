"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import { useUnits } from "@/modules/school/use-units";
import { normalizeName } from "../normalize";
import type { StudentRow } from "../queries";

const MAX_PAGES = 30;

async function fetchAllStudents(user: User): Promise<StudentRow[] | null> {
  const all: StudentRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: Awaited<ReturnType<typeof api<{ students: StudentRow[]; nextCursor: string | null }>>> = await api(user, "GET", `/api/students?limit=100${after ? `&after=${after}` : ""}`);
    if (!result.ok) return null;
    all.push(...result.data.students);
    after = result.data.nextCursor;
    if (!after) break;
  }
  return all;
}

/**
 * Diretório de alunos. A equipe busca pelo nome e vê turma/turno ao lado (diferencia homônimos). O servidor entrega
 * páginas ordenadas por nome; o filtro por trecho do nome é aplicado aqui sobre o que já foi carregado (a escola tem ~300 alunos).
 */
export function StudentsDirectory({ user, canManage }: { user: User; canManage: boolean }) {
  const units = useUnits();
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [text, setText] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [shiftFilter, setShiftFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void fetchAllStudents(user).then((all) => {
      if (!alive) return;
      if (all) setRows(all);
      setState(all ? "ready" : "error");
    });
    return () => {
      alive = false;
    };
  }, [user, reload]);

  const load = () => setReload((n) => n + 1);

  const className = useMemo(() => new Map(units.classes.map((u) => [u.id, u.name])), [units.classes]);
  const shiftName = useMemo(() => new Map(units.shifts.map((u) => [u.id, u.name])), [units.shifts]);
  const filtered = useMemo(() => {
    const needle = normalizeName(text);
    return rows.filter(
      (r) =>
        (!needle || normalizeName(r.name).includes(needle) || r.enrollment.toLowerCase().includes(needle)) &&
        (!classFilter || r.classId === classFilter) &&
        (!shiftFilter || r.shiftId === shiftFilter) &&
        (!statusFilter || r.status === statusFilter),
    );
  }, [rows, text, classFilter, shiftFilter, statusFilter]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setMessage(null);
    const result = await api(user, "POST", "/api/students", {
      key: newKey(),
      action: "create",
      enrollment: String(data.get("enrollment")),
      name: String(data.get("name")),
      classId: String(data.get("classId")),
      shiftId: String(data.get("shiftId")),
    });
    setBusy(false);
    if (result.ok) {
      setMessage({ kind: "ok", text: "Aluno cadastrado." });
      form.reset();
      load();
    } else setMessage({ kind: "error", text: errorText(result.error) });
  }

  const activeClasses = units.classes.filter((u) => u.status === "active");
  const activeShifts = units.shifts.filter((u) => u.status === "active");

  return (
    <section>
      <h1>Alunos</h1>
      <p className="muted">
        Busca por nome com turma e turno, que diferenciam alunos com o mesmo nome.
        {canManage && (
          <>
            {" "}
            <Link href="/operacao/alunos/importar">Importar CSV</Link>
          </>
        )}
      </p>

      {canManage && (
        <form onSubmit={(event) => void create(event)} className="form-grid" aria-label="Cadastrar aluno">
          <h2>Novo aluno</h2>
          <div className="field">
            <label htmlFor="new-enrollment">Matrícula (única)</label>
            <input id="new-enrollment" name="enrollment" type="text" required maxLength={40} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="new-name">Nome completo</label>
            <input id="new-name" name="name" type="text" required minLength={2} maxLength={120} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="new-class">Turma</label>
            <select id="new-class" name="classId" required defaultValue="">
              <option value="" disabled>
                Selecione
              </option>
              {activeClasses.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-shift">Turno</label>
            <select id="new-shift" name="shiftId" required defaultValue="">
              <option value="" disabled>
                Selecione
              </option>
              {activeShifts.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button type="submit" disabled={busy || activeClasses.length === 0 || activeShifts.length === 0}>
              Cadastrar aluno
            </button>
            {(activeClasses.length === 0 || activeShifts.length === 0) && units.status === "ready" && (
              <p className="muted">
                Cadastre ao menos uma turma e um turno em <Link href="/operacao/escola">Turmas e turnos</Link>.
              </p>
            )}
          </div>
        </form>
      )}
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"}>
          {message.text}
        </p>
      )}

      <h2>Lista</h2>
      <div className="toolbar" role="search">
        <div className="field">
          <label htmlFor="filter-text">Buscar por nome ou matrícula</label>
          <input id="filter-text" type="search" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="filter-class">Turma</label>
          <select id="filter-class" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
            <option value="">Todas</option>
            {units.classes.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-shift">Turno</label>
          <select id="filter-shift" value={shiftFilter} onChange={(e) => setShiftFilter(e.target.value)}>
            <option value="">Todos</option>
            {units.shifts.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-status">Situação</label>
          <select id="filter-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="active">Ativos</option>
            <option value="inactive">Arquivados</option>
            <option value="">Todos</option>
          </select>
        </div>
      </div>

      {state === "loading" && <p role="status">Carregando alunos…</p>}
      {state === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar os alunos. <button type="button" className="secondary" onClick={() => { setState("loading"); load(); }}>Tentar de novo</button>
        </p>
      )}
      {state === "ready" && (
        <>
          <p role="status" className="muted">
            {filtered.length} de {rows.length} alunos
          </p>
          {filtered.length === 0 ? (
            <p>Nenhum aluno encontrado com estes filtros.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="muted">Alunos cadastrados</caption>
                <thead>
                  <tr>
                    <th scope="col">Nome</th>
                    <th scope="col">Matrícula</th>
                    <th scope="col">Turma</th>
                    <th scope="col">Turno</th>
                    <th scope="col">Situação</th>
                    {canManage && <th scope="col">Ficha</th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} data-testid="student-row">
                      <td>{r.name}</td>
                      <td>{r.enrollment}</td>
                      <td>{className.get(r.classId) ?? "—"}</td>
                      <td>{shiftName.get(r.shiftId) ?? "—"}</td>
                      <td>
                        <span className={r.status === "active" ? "tag" : "tag tag-off"}>{r.status === "active" ? "Ativo" : "Arquivado"}</span>
                        {r.hasLogin && <span className="tag"> com login</span>}
                      </td>
                      {canManage && (
                        <td>
                          <Link href={`/operacao/alunos/${r.id}`} aria-label={`Abrir ficha de ${r.name}`}>
                            Abrir
                          </Link>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
