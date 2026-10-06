"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { PosStudentRow } from "../queries";
import { homonymIds, MAX_SHOWN_STUDENTS, searchStudents } from "../view";

type Props = {
  rows: readonly PosStudentRow[];
  truncated: boolean;
  disabled: boolean;
  onPick: (row: PosStudentRow) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Prefixo de IDs/test IDs (o PDV usa "pos"; a secretaria, "topup"). */
  prefix?: string;
};

/**
 * Busca nominal em destaque: nome (qualquer ordem, sem acento) ou matrícula, com TURMA e TURNO em cada resultado, e destaque
 * para nomes repetidos. A lista é filtrada no navegador sobre os alunos ativos já carregados (nenhuma leitura por tecla).
 * Teclado: setas movem a seleção, Enter escolhe, Esc limpa.
 */
export function StudentPicker({ rows, truncated, disabled, onPick, inputRef, prefix = "pos" }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionsRef = useRef<HTMLUListElement>(null);
  const repeated = useMemo(() => homonymIds(rows), [rows]);
  const matches = useMemo(() => searchStudents(rows, query), [rows, query]);
  const shown = matches.slice(0, MAX_SHOWN_STUDENTS);
  const current = Math.min(active, Math.max(0, shown.length - 1));

  function pick(row: PosStudentRow | undefined) {
    if (!row || disabled) return;
    onPick(row);
    setQuery("");
    setActive(0);
  }

  return (
    <section aria-labelledby={`${prefix}-student-title`} className="pos-student-picker">
      <h2 id={`${prefix}-student-title`}>Aluno</h2>
      <div className="field">
        <label htmlFor={`${prefix}-student-search`}>Buscar aluno por nome ou matrícula</label>
        <input
          id={`${prefix}-student-search`}
          ref={inputRef}
          type="search"
          autoComplete="off"
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-activedescendant={shown[current] ? `${listId}-${shown[current]!.id}` : undefined}
          disabled={disabled}
          value={query}
          placeholder="Ex.: maria silva"
          data-testid={`${prefix}-student-search`}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(Math.min(current + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(Math.max(current - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(shown[current]);
            } else if (e.key === "Escape") {
              setQuery("");
            }
          }}
        />
      </div>
      {truncated && <p className="notice">A lista de alunos foi cortada no limite: busque pela matrícula e avise a administração.</p>}
      <p className="visually-hidden" role="status" aria-live="polite">
        {query.trim() ? `${matches.length} aluno(s) encontrado(s).` : ""}
      </p>
      {query.trim() && shown.length === 0 && <p className="muted">Nenhum aluno ativo encontrado. Confira a grafia ou use a matrícula.</p>}
      <ul id={listId} ref={optionsRef} role="listbox" aria-label="Alunos encontrados" className="plain-list pos-student-list" hidden={shown.length === 0}>
        {shown.map((row, index) => (
          <li key={row.id} id={`${listId}-${row.id}`} role="option" aria-selected={index === current} data-active={index === current} data-testid={`${prefix}-student-option`}>
            <button type="button" className="pos-option" disabled={disabled} onClick={() => pick(row)} tabIndex={-1} aria-label={`Escolher ${row.name}, turma ${row.className ?? "sem turma"}, turno ${row.shiftName ?? "sem turno"}`}>
              <strong>{row.name}</strong>
              <span>
                {row.className ?? "Sem turma"} · {row.shiftName ?? "Sem turno"} · matrícula {row.enrollment}
              </span>
              {repeated.has(row.id) && <span className="badge badge-warn">Nome repetido: confira turma e turno</span>}
            </button>
          </li>
        ))}
      </ul>
      {matches.length > shown.length && <p className="muted">Mostrando {shown.length} de {matches.length}. Digite mais do nome para afinar.</p>}
    </section>
  );
}
