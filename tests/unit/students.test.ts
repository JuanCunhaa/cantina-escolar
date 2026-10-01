import { describe, expect, it } from "vitest";
import { CSV_MAX_ROWS, mapColumns, parseCsv, planImport, type UnitLookup } from "@/modules/students/csv";
import { isSafeLabel, normalizeEnrollment, normalizeName, unitSlug } from "@/modules/students/normalize";
import { deterministicId, hashPayload } from "@/lib/firebase/command";

describe("normalização", () => {
  it("nome: sem acento, minúsculas, espaços colapsados", () => {
    expect(normalizeName("  JOÃO   da Conceição ")).toBe("joao da conceicao");
  });
  it("matrícula: caixa alta, sem espaços; vazia ou com símbolos é inválida", () => {
    expect(normalizeEnrollment(" ab 12-3 ")).toBe("AB12-3");
    for (const bad of ["", "   ", "a/b", "../x", "-1", "x".repeat(33)]) expect(normalizeEnrollment(bad)).toBeNull();
  });
  it("slug de turma/turno: ordinais e acentos viram ASCII; sem letras/números = nulo", () => {
    expect(unitSlug("5º Ano A")).toBe("5o-ano-a");
    expect(unitSlug("Manhã")).toBe("manha");
    expect(unitSlug("!!!")).toBeNull();
  });
  it("rótulos que viram fórmula em planilha ou têm controle são rejeitados", () => {
    for (const bad of ["=1+1", "+cmd", "-2", "@SUM(A1)", "a\u0000b", "a‮b"]) expect(isSafeLabel(bad)).toBe(false);
    expect(isSafeLabel("Maria-José O'Neil")).toBe(true);
  });
});

describe("IDs determinísticos", () => {
  it("estáveis por identidade e diferentes entre chaves/atores", () => {
    expect(deterministicId("stu", "u1", "k1")).toBe(deterministicId("stu", "u1", "k1"));
    expect(deterministicId("stu", "u1", "k1")).not.toBe(deterministicId("stu", "u1", "k2"));
    expect(deterministicId("stu", "u1", "k1")).not.toBe(deterministicId("stu", "u2", "k1"));
    expect(deterministicId("stu", "u1", "k1")).toMatch(/^stu_[0-9a-f]{20}$/);
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});

describe("CSV", () => {
  it("lê aspas, vírgula/ponto e vírgula, CRLF, BOM e linhas vazias", () => {
    const parsed = parseCsv('﻿matricula;nome;turma;turno\r\n1;"Silva; Ana ""A""";5A;Manhã\r\n\r\n2;Beto;5A;Tarde\r\n');
    expect(parsed).toMatchObject({ ok: true, rows: [["1", 'Silva; Ana "A"', "5A", "Manhã"], ["2", "Beto", "5A", "Tarde"]] });
    expect(parseCsv("matricula,nome\n1,A")).toMatchObject({ ok: true, header: ["matricula", "nome"] });
  });
  it("recusa vazio, aspas abertas, arquivo grande e excesso de linhas", () => {
    expect(parseCsv("")).toEqual({ ok: false, error: "empty_file" });
    expect(parseCsv('a;b\n"x')).toEqual({ ok: false, error: "unterminated_quote" });
    expect(parseCsv("x".repeat(300 * 1024))).toEqual({ ok: false, error: "file_too_large" });
    const rows = Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `${i};n;t;u`).join("\n");
    expect(parseCsv(`a;b;c;d\n${rows}`)).toEqual({ ok: false, error: "too_many_rows" });
  });
  it("mapeia cabeçalhos com acento/caixa e exige as quatro colunas", () => {
    expect(mapColumns(["Matrícula", "NOME", "Turma", "Turno"])).toEqual({ enrollment: 0, name: 1, class: 2, shift: 3 });
    expect(mapColumns(["nome", "turma"])).toBeNull();
  });
});

describe("prévia de importação", () => {
  const unit = (id: string, name: string, active = true) => [normalizeName(name), { id, name, active }] as const;
  const classes: UnitLookup = new Map([unit("c1", "5A"), unit("c2", "6B"), unit("c3", "Antiga", false)]);
  const shifts: UnitLookup = new Map([unit("s1", "Manhã"), unit("s2", "Tarde")]);
  const existing = [{ id: "e1", enrollment: "A1", name: "Ana Souza", classId: "c1", shiftId: "s1", status: "active" }];
  const plan = (csv: string, onDuplicate: "skip" | "update" = "skip") => {
    const result = planImport(`matricula;nome;turma;turno\n${csv}`, { classes, shifts, existing, onDuplicate });
    if (!result.ok) throw new Error(result.error);
    return result;
  };

  it("classifica criar, ignorar duplicada, atualizar, inalterada e erro", () => {
    expect(plan("A1;Ana Souza;5A;Manhã\nB2;Bia Lima;6B;Tarde").rows.map((r) => r.action)).toEqual(["skip", "create"]);
    expect(plan("a1;Ana S. Souza;5A;Manhã", "update").rows[0]).toMatchObject({ action: "update", studentId: "e1", classId: "c1" });
    expect(plan("A1;Ana Souza;5a;manha", "update").rows[0]!.action).toBe("unchanged");
  });

  it("homônimos em turmas diferentes não geram aviso; mesmo nome+turma+turno sim", () => {
    const rows = plan("B1;Ana Souza;6B;Manhã\nB2;Ana Souza;5A;Manhã\nB3;Caio Reis;5A;Tarde\nB4;Caio Reis;5A;Tarde").rows;
    expect(rows.map((r) => r.warnings.length)).toEqual([0, 1, 0, 1]);
    expect(rows.every((r) => r.action === "create")).toBe(true);
  });

  it("erros: campos vazios, unidades inexistentes/arquivadas, matrícula repetida, fórmula e tamanho", () => {
    const rows = plan(
      [";X Y;5A;Manhã", "C1;;5A;Manhã", "C2;Fulano;9Z;Manhã", "C3;Fulano;Antiga;Manhã", "C4;Fulano;5A;Noite", "C5;Fulano;5A;Manhã", "C5;Beltrano;5A;Manhã", "C6;=cmd|x;5A;Manhã", `C7;${"n".repeat(121)};5A;Manhã`].join("\n"),
    ).rows;
    expect(rows.map((r) => r.action)).toEqual(["error", "error", "error", "error", "error", "create", "error", "error", "error"]);
    expect(rows[3]!.errors).toContain("Turma arquivada.");
    expect(rows[6]!.errors).toContain("Matrícula repetida no arquivo.");
  });

  it("resumo conta ações e avisos", () => {
    const { summary } = plan("A1;Ana Souza;5A;Manhã\nB1;Ana Souza;5A;Manhã\nB2;Zé;6B;Tarde");
    expect(summary).toMatchObject({ skip: 1, create: 2, error: 0, warnings: 1 });
  });
});
