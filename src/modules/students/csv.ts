import { isSafeLabel, normalizeEnrollment, normalizeName } from "./normalize";

export const CSV_MAX_BYTES = 256 * 1024;
export const CSV_MAX_ROWS = 500;

export type CsvParse = { ok: true; header: string[]; rows: string[][] } | { ok: false; error: string };

/** CSV RFC 4180 mínimo: aspas, "" escapado, quebras CRLF/LF, BOM e delimitador `,` ou `;` (planilhas pt-BR). */
export function parseCsv(input: string): CsvParse {
  if (new TextEncoder().encode(input).length > CSV_MAX_BYTES) return { ok: false, error: "file_too_large" };
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      records.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) return { ok: false, error: "unterminated_quote" };
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ""));
  const header = nonEmpty[0];
  if (!header) return { ok: false, error: "empty_file" };
  const rows = nonEmpty.slice(1);
  if (rows.length > CSV_MAX_ROWS) return { ok: false, error: "too_many_rows" };
  return { ok: true, header, rows };
}

const COLUMN_ALIASES: Record<"enrollment" | "name" | "class" | "shift", string[]> = {
  enrollment: ["matricula", "enrollment", "id"],
  name: ["nome", "aluno", "name"],
  class: ["turma", "class"],
  shift: ["turno", "shift"],
};

export type ImportColumns = Record<keyof typeof COLUMN_ALIASES, number>;

export function mapColumns(header: string[]): ImportColumns | null {
  const normalized = header.map((h) => normalizeName(h));
  const result: Partial<ImportColumns> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [keyof ImportColumns, string[]][]) {
    const index = normalized.findIndex((h) => aliases.includes(h));
    if (index < 0) return null;
    result[field] = index;
  }
  return result as ImportColumns;
}

export type ExistingStudent = {
  id: string;
  enrollment: string;
  name: string;
  classId: string;
  shiftId: string;
  status: string;
};
export type UnitLookup = Map<string, { id: string; name: string; active: boolean }>;
export type DuplicatePolicy = "skip" | "update";

export type PlanAction = "create" | "update" | "skip" | "unchanged" | "error";
export type PlanRow = {
  line: number;
  enrollment: string;
  name: string;
  className: string;
  shiftName: string;
  action: PlanAction;
  errors: string[];
  warnings: string[];
  classId: string | null;
  shiftId: string | null;
  /** Aluno existente (skip/update/unchanged). */
  studentId: string | null;
};

export type ImportPlan =
  | { ok: false; error: string }
  | { ok: true; rows: PlanRow[]; summary: Record<PlanAction, number> & { warnings: number } };

/** Prévia pura: valida cada linha e classifica (criar/atualizar/ignorar/erro) sem escrever nada. */
export function planImport(
  csv: string,
  ctx: { classes: UnitLookup; shifts: UnitLookup; existing: readonly ExistingStudent[]; onDuplicate: DuplicatePolicy },
): ImportPlan {
  const parsed = parseCsv(csv);
  if (!parsed.ok) return parsed;
  const columns = mapColumns(parsed.header);
  if (!columns) return { ok: false, error: "missing_columns" };

  const byEnrollment = new Map(ctx.existing.map((s) => [s.enrollment, s] as const));
  const seenSlot = new Map<string, number>();
  for (const s of ctx.existing) seenSlot.set(`${normalizeName(s.name)}|${s.classId}|${s.shiftId}`, (seenSlot.get(`${normalizeName(s.name)}|${s.classId}|${s.shiftId}`) ?? 0) + 1);
  const seenEnrollment = new Set<string>();

  const rows: PlanRow[] = parsed.rows.map((cells, index) => {
    const cell = (i: number) => (cells[i] ?? "").trim();
    const name = cell(columns.name).replace(/\s+/g, " ");
    const row: PlanRow = {
      line: index + 2,
      enrollment: "",
      name,
      className: cell(columns.class),
      shiftName: cell(columns.shift),
      action: "create",
      errors: [],
      warnings: [],
      classId: null,
      shiftId: null,
      studentId: null,
    };
    const enrollment = normalizeEnrollment(cell(columns.enrollment));
    if (!enrollment) row.errors.push("Matrícula ausente ou inválida.");
    else row.enrollment = enrollment;
    if (name.length < 2 || name.length > 120) row.errors.push("Nome deve ter de 2 a 120 caracteres.");
    else if (!isSafeLabel(name)) row.errors.push("Nome com caractere inicial ou de controle não permitido.");
    const cls = ctx.classes.get(normalizeName(row.className));
    if (!cls) row.errors.push("Turma não cadastrada.");
    else if (!cls.active) row.errors.push("Turma arquivada.");
    else row.classId = cls.id;
    const shift = ctx.shifts.get(normalizeName(row.shiftName));
    if (!shift) row.errors.push("Turno não cadastrado.");
    else if (!shift.active) row.errors.push("Turno arquivado.");
    else row.shiftId = shift.id;

    if (enrollment) {
      if (seenEnrollment.has(enrollment)) row.errors.push("Matrícula repetida no arquivo.");
      seenEnrollment.add(enrollment);
    }
    if (row.errors.length > 0) {
      row.action = "error";
      return row;
    }

    const existing = byEnrollment.get(enrollment!);
    if (existing) {
      row.studentId = existing.id;
      if (ctx.onDuplicate === "skip") {
        row.action = "skip";
        row.warnings.push("Matrícula já cadastrada: linha ignorada.");
      } else if (existing.name === name && existing.classId === row.classId && existing.shiftId === row.shiftId) row.action = "unchanged";
      else row.action = "update";
      return row;
    }
    const slot = `${normalizeName(name)}|${row.classId}|${row.shiftId}`;
    if (seenSlot.has(slot)) row.warnings.push("Possível duplicidade: já existe aluno com o mesmo nome, turma e turno.");
    seenSlot.set(slot, (seenSlot.get(slot) ?? 0) + 1);
    return row;
  });

  const summary = { create: 0, update: 0, skip: 0, unchanged: 0, error: 0, warnings: 0 };
  for (const r of rows) {
    summary[r.action]++;
    if (r.warnings.length > 0 && (r.action === "create" || r.action === "update")) summary.warnings++;
  }
  return { ok: true, rows, summary };
}
