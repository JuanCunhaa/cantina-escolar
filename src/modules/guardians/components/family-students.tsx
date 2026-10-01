"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import { useUnits } from "@/modules/school/use-units";
import { useFamilyStudents } from "../use-family-students";

type Message = { studentId: string; kind: "ok" | "error"; text: string };

/**
 * Portal do responsável: alunos vinculados, permissões de compra e convite de login do aluno. Os dados chegam por
 * listeners (Rules por vínculo); as alterações passam pelo servidor, que revalida o vínculo na transação e audita o autor.
 */
export function FamilyStudents({ user }: { user: User }) {
  const family = useFamilyStudents(user.uid);
  const units = useUnits();
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ studentId: string; url: string } | null>(null);
  const className = new Map(units.classes.map((u) => [u.id, u.name]));
  const shiftName = new Map(units.shifts.map((u) => [u.id, u.name]));

  async function setPolicy(studentId: string, change: { allowSitePurchase?: boolean; allowCounterPurchase?: boolean }) {
    setBusy(studentId);
    setMessage(null);
    const result = await api(user, "POST", "/api/policies", { key: newKey(), studentId, ...change });
    setBusy(null);
    setMessage(
      result.ok
        ? { studentId, kind: "ok", text: "Permissão atualizada para a conta do aluno." }
        : { studentId, kind: "error", text: errorText(result.error) },
    );
  }

  async function inviteStudent(studentId: string) {
    setBusy(studentId);
    setMessage(null);
    setIssued(null);
    const result = await api<{ token?: string }>(user, "POST", "/api/invitations", { key: newKey(), action: "create", kind: "student", studentId });
    setBusy(null);
    if (!result.ok) setMessage({ studentId, kind: "error", text: errorText(result.error) });
    else if (result.data.token) {
      setIssued({ studentId, url: `${window.location.origin}/convite#${result.data.token}` });
      setMessage({ studentId, kind: "ok", text: "Convite criado. Copie o link agora: ele não será mostrado de novo." });
    }
  }

  return (
    <section>
      <h1>Alunos vinculados</h1>
      <p className="muted">Todos os responsáveis vinculados têm o mesmo poder sobre a conta do aluno. Cada alteração é registrada com o seu nome.</p>
      {family.status === "loading" && <p role="status">Carregando…</p>}
      {family.status === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar os alunos. Verifique a conexão.
        </p>
      )}
      {family.status === "ready" && family.students.length === 0 && (
        <p>Nenhum aluno vinculado à sua conta ainda. A escola vincula alunos por convite; não é possível se vincular pesquisando o nome.</p>
      )}
      <ul className="plain-list">
        {family.students.map((s) => (
          <li key={s.id} className="student-block" data-testid="family-student">
            <h2>{s.name}</h2>
            <p className="muted">
              {className.get(s.classId) ?? "Turma"} · {shiftName.get(s.shiftId) ?? "Turno"} · matrícula {s.enrollment}
              {s.status !== "active" ? " · cadastro arquivado" : ""}
            </p>
            <fieldset disabled={busy === s.id}>
              <legend>Permissões de compra</legend>
              <p>
                <input id={`site-${s.id}`} type="checkbox" checked={s.allowSitePurchase} onChange={(e) => void setPolicy(s.id, { allowSitePurchase: e.target.checked })} />{" "}
                <label htmlFor={`site-${s.id}`}>Aluno pode comprar pelo site</label>
              </p>
              <p>
                <input
                  id={`counter-${s.id}`}
                  type="checkbox"
                  checked={s.allowCounterPurchase}
                  onChange={(e) => void setPolicy(s.id, { allowCounterPurchase: e.target.checked })}
                />{" "}
                <label htmlFor={`counter-${s.id}`}>Aluno pode comprar no balcão com saldo</label>
              </p>
              <p className="muted">Retirar uma permissão não cancela pedidos já feitos nem mexe no saldo.</p>
            </fieldset>
            <p>
              {s.hasLogin ? (
                <span className="tag">Aluno com login (somente consulta, salvo permissões acima)</span>
              ) : (
                <button type="button" className="secondary" disabled={busy === s.id || s.status !== "active"} onClick={() => void inviteStudent(s.id)}>
                  Convidar o aluno para ter login
                </button>
              )}
            </p>
            {issued?.studentId === s.id && (
              <div className="field" style={{ maxWidth: "40rem" }}>
                <label htmlFor={`link-${s.id}`}>Link do convite (uso único, válido por 3 dias)</label>
                <input id={`link-${s.id}`} type="text" readOnly value={issued.url} onFocus={(e) => e.currentTarget.select()} />
              </div>
            )}
            {message?.studentId === s.id && (
              <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"}>
                {message.text}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
