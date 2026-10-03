"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import type { InvitationRow } from "@/modules/guardians/invitations";
import type { StudentAccess } from "@/modules/guardians/queries";
import { useUnits } from "@/modules/school/use-units";

type Message = { kind: "ok" | "error"; text: string } | null;

const INVITATION_STATUS: Record<InvitationRow["status"], string> = { pending: "Pendente", used: "Usado", revoked: "Revogado", expired: "Expirado" };
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

/** Ficha administrativa do aluno: cadastro, responsáveis vinculados, convites e login do aluno. */
export function StudentDetail({ user, studentId }: { user: User; studentId: string }) {
  const units = useUnits();
  const [access, setAccess] = useState<StudentAccess | null>(null);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ kind: string; url: string } | null>(null);

  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      api<StudentAccess>(user, "GET", `/api/students/${studentId}`),
      api<{ invitations: InvitationRow[] }>(user, "GET", `/api/invitations?studentId=${studentId}`),
    ]).then(([a, i]) => {
      if (!alive) return;
      if (a.ok && i.ok) {
        setAccess(a.data);
        setInvitations(i.data.invitations);
        setState("ready");
      } else setState("error");
    });
    return () => {
      alive = false;
    };
  }, [user, studentId, reload]);

  const load = () => setReload((n) => n + 1);

  async function run(url: string, body: Record<string, unknown>, okText: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const result = await api(user, "POST", url, { key: newKey(), ...body });
    setBusy(false);
    setMessage(result.ok ? { kind: "ok", text: okText } : { kind: "error", text: errorText(result.error) });
    if (result.ok) load();
    return result.ok;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run("/api/students", { action: "update", studentId, name: String(data.get("name")), classId: String(data.get("classId")), shiftId: String(data.get("shiftId")), reason: String(data.get("reason")) }, "Cadastro atualizado.");
  }

  async function addGuardian(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (await run("/api/links", { action: "add", studentId, guardianEmail: String(data.get("email")).trim(), reason: "Vínculo cadastrado pela administração" }, "Responsável vinculado.")) form.reset();
  }

  async function invite(kind: "guardian" | "student") {
    setBusy(true);
    setMessage(null);
    setIssued(null);
    const result = await api<{ token?: string }>(user, "POST", "/api/invitations", { key: newKey(), action: "create", kind, studentId });
    setBusy(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: errorText(result.error) });
      return;
    }
    if (result.data.token) setIssued({ kind, url: `${window.location.origin}/convite#${result.data.token}` });
    setMessage({ kind: "ok", text: "Convite criado. Copie o link agora: ele não será mostrado de novo." });
    load();
  }

  if (state === "loading") return <p role="status">Carregando ficha…</p>;
  if (state === "error" || !access) {
    return (
      <p role="alert" className="notice notice-error">
        Não foi possível carregar a ficha deste aluno. <Link href="/operacao/alunos">Voltar à lista</Link>
      </p>
    );
  }
  const { student, links, policy } = access;
  const activeLinks = links.filter((l) => l.status === "active");

  return (
    <section>
      <p>
        <Link href="/operacao/alunos">← Alunos</Link>
      </p>
      <h1>{student.name}</h1>
      <p className="muted">
        Matrícula {student.enrollment} · {student.status === "active" ? "Ativo" : "Arquivado"}
      </p>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"}>
          {message.text}
        </p>
      )}

      <h2>Cadastro</h2>
      <form onSubmit={(event) => void save(event)} className="form-grid" key={`${student.name}-${student.classId}-${student.shiftId}`}>
        <div className="field">
          <label htmlFor="d-name">Nome completo</label>
          <input id="d-name" name="name" type="text" required minLength={2} maxLength={120} defaultValue={student.name} />
        </div>
        <div className="field">
          <label htmlFor="d-class">Turma</label>
          <select id="d-class" name="classId" defaultValue={student.classId}>
            {units.classes.filter((u) => u.status === "active" || u.id === student.classId).map((u) => (
              <option key={u.id} value={u.id}>{u.name}{u.status === "archived" ? " (arquivada)" : ""}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-shift">Turno</label>
          <select id="d-shift" name="shiftId" defaultValue={student.shiftId}>
            {units.shifts.filter((u) => u.status === "active" || u.id === student.shiftId).map((u) => (
              <option key={u.id} value={u.id}>{u.name}{u.status === "archived" ? " (arquivado)" : ""}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="d-reason">Motivo da alteração</label>
          <input id="d-reason" name="reason" type="text" required minLength={3} maxLength={300} defaultValue="Atualização de cadastro" />
        </div>
        <div>
          <button type="submit" disabled={busy}>Salvar alterações</button>
        </div>
      </form>
      <p className="muted">Mudar de turma ou turno não altera o turno de pedidos já pagos; pedidos futuros serão revisados na tela de pedidos (tarefa futura).</p>
      <p>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void run("/api/students", { action: "update", studentId, status: student.status === "active" ? "inactive" : "active", reason: student.status === "active" ? "Cadastro arquivado" : "Cadastro reativado" }, student.status === "active" ? "Aluno arquivado." : "Aluno reativado.")}
        >
          {student.status === "active" ? "Arquivar aluno" : "Reativar aluno"}
        </button>{" "}
        <span className="muted">Arquivar mantém vínculos, histórico e matrícula; bloqueia novas compras e só é possível com a carteira zerada.</span>
      </p>

      <h2>Responsáveis vinculados</h2>
      <p className="muted">Todos os responsáveis têm a mesma capacidade de administrar a conta do aluno; não há responsável principal.</p>
      {activeLinks.length === 0 ? (
        <p>Nenhum responsável vinculado.</p>
      ) : (
        <ul className="plain-list" data-testid="guardian-links">
          {activeLinks.map((l) => (
            <li key={l.guardianUid}>
              <span>{l.name} · {l.email}</span>{" "}
              <button type="button" className="secondary" disabled={busy} aria-label={`Revogar vínculo de ${l.name}`} onClick={() => void run("/api/links", { action: "revoke", studentId, guardianUid: l.guardianUid, reason: "Vínculo revogado pela administração" }, "Vínculo revogado.")}>
                Revogar
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void addGuardian(event)} className="inline-form">
        <label htmlFor="g-email">Vincular responsável já cadastrado (e-mail)</label>
        <input id="g-email" name="email" type="email" required autoComplete="off" />
        <button type="submit" disabled={busy}>Vincular</button>
      </form>

      <h2>Permissões de compra</h2>
      <p>
        Compra pelo site: <strong>{policy.allowSitePurchase ? "permitida" : "não permitida"}</strong> · Compra no balcão com saldo:{" "}
        <strong>{policy.allowCounterPurchase ? "permitida" : "não permitida"}</strong>
      </p>
      <p className="muted">Os responsáveis alteram estas permissões no portal; cada alteração é auditada com o autor.</p>

      <h2>Login do aluno</h2>
      {student.hasLogin ? (
        <p>
          O aluno acessa com <strong>{student.loginEmail ?? "conta vinculada"}</strong> (somente consulta, salvo permissão de compra).{" "}
          <button type="button" className="secondary" disabled={busy} onClick={() => void run("/api/links", { action: "revokeStudentLogin", studentId, reason: "Login do aluno removido pela administração" }, "Login do aluno removido.")}>
            Remover login
          </button>
        </p>
      ) : (
        <p className="muted">O aluno não tem login. Gere um convite de login abaixo.</p>
      )}

      <h2>Convites</h2>
      <p className="muted">Uso único, validade de 3 dias, no máximo 5 pendentes por aluno. A escola entrega o link; nenhum e-mail é enviado automaticamente.</p>
      <p>
        <button type="button" disabled={busy} onClick={() => void invite("guardian")}>Convidar responsável</button>{" "}
        <button type="button" className="secondary" disabled={busy || student.hasLogin || student.status !== "active"} onClick={() => void invite("student")}>
          Convidar para login do aluno
        </button>
      </p>
      {issued && (
        <div className="field" style={{ maxWidth: "40rem" }}>
          <label htmlFor="issued-link">Link do convite ({issued.kind === "guardian" ? "responsável" : "aluno"}) — copie agora</label>
          <input id="issued-link" type="text" readOnly value={issued.url} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(issued.url)}>Copiar link</button>
        </div>
      )}
      {invitations.length === 0 ? (
        <p className="muted">Nenhum convite criado.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="muted">Convites deste aluno</caption>
            <thead>
              <tr><th scope="col">Tipo</th><th scope="col">Situação</th><th scope="col">Validade</th><th scope="col">Ação</th></tr>
            </thead>
            <tbody>
              {invitations.map((i) => (
                <tr key={i.id} data-testid="invitation-row">
                  <td>{i.kind === "guardian" ? "Responsável" : "Login do aluno"}</td>
                  <td>{INVITATION_STATUS[i.status]}</td>
                  <td>{dateTime.format(new Date(i.expiresAt))}</td>
                  <td>
                    {i.status === "pending" && (
                      <button type="button" className="secondary" disabled={busy} onClick={() => void run("/api/invitations", { action: "revoke", invitationId: i.id }, "Convite revogado.")}>
                        Revogar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
