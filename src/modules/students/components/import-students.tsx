"use client";

import Link from "next/link";
import { useState, type ChangeEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import { CSV_MAX_BYTES, type PlanAction, type PlanRow } from "../csv";
import type { ImportResult } from "../import";

type Preview = { plan: { rows: PlanRow[]; summary: Record<PlanAction, number> & { warnings: number } }; digest: string };

const ACTION_LABEL: Record<PlanAction, string> = { create: "Criar", update: "Atualizar", skip: "Ignorar (já cadastrada)", unchanged: "Sem mudança", error: "Erro" };

/** Importação CSV em duas etapas: prévia (nada é gravado) e confirmação (servidor recalcula e confere o resumo aprovado). */
export function ImportStudents({ user }: { user: User }) {
  const [csv, setCsv] = useState("");
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "update">("skip");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitKey, setCommitKey] = useState(newKey);

  function reset(next: string) {
    setCsv(next);
    setPreview(null);
    setResult(null);
    setError(null);
    setAcceptWarnings(false);
    setCommitKey(newKey());
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (file.size > CSV_MAX_BYTES) {
      reset("");
      setError(errorText("file_too_large"));
      return;
    }
    reset(await file.text());
  }

  async function makePreview() {
    setBusy(true);
    setError(null);
    setResult(null);
    const response = await api<{ ok: boolean; error?: string } & Partial<Preview>>(user, "POST", "/api/students/import", { mode: "preview", csv, onDuplicate });
    setBusy(false);
    if (!response.ok) setError(errorText(response.error));
    else if (!response.data.ok || !response.data.plan || !response.data.digest) {
      setPreview(null);
      setError(errorText(response.data.error ?? "internal"));
    } else setPreview({ plan: response.data.plan, digest: response.data.digest });
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const response = await api<ImportResult>(user, "POST", "/api/students/import", { mode: "commit", key: commitKey, csv, onDuplicate, digest: preview.digest, acceptWarnings });
    setBusy(false);
    if (!response.ok) setError(errorText(response.error));
    else {
      setResult(response.data);
      setPreview(null);
    }
  }

  const summary = preview?.plan.summary;
  const hasErrors = (summary?.error ?? 0) > 0;
  const needsAck = (summary?.warnings ?? 0) > 0 && !acceptWarnings;
  const writable = (summary?.create ?? 0) + (summary?.update ?? 0);

  return (
    <section>
      <p>
        <Link href="/operacao/alunos">← Alunos</Link>
      </p>
      <h1>Importar alunos (CSV)</h1>
      <p className="muted">
        Colunas obrigatórias: matrícula, nome, turma e turno (separador vírgula ou ponto e vírgula; até 500 linhas e 256 KB). Turmas e turnos precisam estar cadastrados.
        A prévia não grava nada.
      </p>

      <div className="field">
        <label htmlFor="csv-file">Arquivo CSV</label>
        <input id="csv-file" type="file" accept=".csv,text/csv" onChange={(event) => void onFile(event)} />
      </div>
      <div className="field" style={{ maxWidth: "40rem" }}>
        <label htmlFor="csv-text">Ou cole o conteúdo</label>
        <textarea id="csv-text" rows={6} value={csv} onChange={(e) => reset(e.target.value)} spellCheck={false} placeholder={"matrícula;nome;turma;turno\n2026001;Nome do Aluno;5º A;Manhã"} />
      </div>
      <div className="field">
        <label htmlFor="csv-dup">Matrícula já cadastrada</label>
        <select id="csv-dup" value={onDuplicate} onChange={(e) => { setOnDuplicate(e.target.value as "skip" | "update"); setPreview(null); }}>
          <option value="skip">Ignorar a linha</option>
          <option value="update">Atualizar nome, turma e turno</option>
        </select>
      </div>
      <button type="button" disabled={busy || csv.trim() === ""} onClick={() => void makePreview()}>
        Gerar prévia
      </button>

      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}

      {preview && summary && (
        <>
          <h2>Prévia</h2>
          <p role="status" data-testid="import-summary">
            {summary.create} a criar · {summary.update} a atualizar · {summary.skip} ignoradas · {summary.unchanged} sem mudança · {summary.error} com erro · {summary.warnings} com aviso
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <caption className="muted">Linhas do arquivo</caption>
              <thead>
                <tr>
                  <th scope="col">Linha</th>
                  <th scope="col">Matrícula</th>
                  <th scope="col">Nome</th>
                  <th scope="col">Turma</th>
                  <th scope="col">Turno</th>
                  <th scope="col">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {preview.plan.rows.map((row) => (
                  <tr key={row.line} data-action={row.action}>
                    <td>{row.line}</td>
                    <td>{row.enrollment || "—"}</td>
                    <td>{row.name}</td>
                    <td>{row.className}</td>
                    <td>{row.shiftName}</td>
                    <td>
                      <strong>{ACTION_LABEL[row.action]}</strong>
                      {[...row.errors, ...row.warnings].map((text) => (
                        <div key={text} className={row.errors.includes(text) ? "notice-error" : "muted"}>
                          {text}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasErrors && <p className="notice notice-error">Corrija as linhas com erro no arquivo e gere a prévia novamente.</p>}
          {(summary.warnings ?? 0) > 0 && !hasErrors && (
            <p>
              <input id="ack" type="checkbox" checked={acceptWarnings} onChange={(e) => setAcceptWarnings(e.target.checked)} />{" "}
              <label htmlFor="ack">Confirmo que as linhas com aviso de possível duplicidade são alunos diferentes.</label>
            </p>
          )}
          <button type="button" disabled={busy || hasErrors || needsAck || writable === 0} onClick={() => void commit()}>
            Confirmar importação
          </button>
        </>
      )}

      {result && (
        <div role="status" data-testid="import-result">
          <h2>Importação concluída</h2>
          <p>
            {result.created} criados · {result.updated} atualizados · {result.skipped} ignorados · {result.failed} com falha
            {result.replayed ? " (resultado já registrado anteriormente)" : ""}
          </p>
          {result.failed > 0 && <p className="notice notice-error">Algumas linhas falharam. Gere uma nova prévia: linhas já criadas serão tratadas como cadastradas.</p>}
        </div>
      )}
    </section>
  );
}
