"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { api } from "@/lib/api-client";
import type { GuardianRow } from "../queries";

/** Administração: responsáveis cadastrados e quantidade de alunos vinculados. Vínculos são geridos na ficha do aluno. */
export function GuardiansList({ user }: { user: User }) {
  const [guardians, setGuardians] = useState<GuardianRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    void api<{ guardians: GuardianRow[] }>(user, "GET", "/api/guardians").then((result) => {
      if (!alive) return;
      if (result.ok) {
        setGuardians(result.data.guardians);
        setState("ready");
      } else setState("error");
    });
    return () => {
      alive = false;
    };
  }, [user]);

  return (
    <section>
      <h1>Responsáveis</h1>
      <p className="muted">
        Contas de responsáveis. Para criar uma conta, convide o responsável pela <Link href="/operacao/alunos">ficha do aluno</Link>; o vínculo só existe por convite
        validado ou cadastro da administração.
      </p>
      {state === "loading" && <p role="status">Carregando…</p>}
      {state === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar os responsáveis.
        </p>
      )}
      {state === "ready" &&
        (guardians.length === 0 ? (
          <p>Nenhum responsável cadastrado ainda.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="muted">Responsáveis cadastrados</caption>
              <thead>
                <tr>
                  <th scope="col">Nome</th>
                  <th scope="col">E-mail</th>
                  <th scope="col">Contato</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Alunos vinculados</th>
                </tr>
              </thead>
              <tbody>
                {guardians.map((g) => (
                  <tr key={g.uid} data-testid="guardian-row">
                    <td>{g.name}</td>
                    <td>{g.email}</td>
                    <td>{g.contact ?? "—"}</td>
                    <td>
                      <span className={g.status === "active" ? "tag" : "tag tag-off"}>{g.status === "active" ? "Ativo" : "Desativado"}</span>
                    </td>
                    <td>{g.studentIds.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
