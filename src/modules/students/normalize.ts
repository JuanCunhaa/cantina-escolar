/** Normalização para busca e unicidade: sem acento, minúsculas, espaços colapsados. */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Matrícula: letras/dígitos/ponto/hífen, caixa alta, sem espaços. Vazio ou inválido = null. */
export function normalizeEnrollment(value: string): string | null {
  const compact = value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(compact) ? compact : null;
}

/** Chave de unicidade de turma/turno: só [a-z0-9-]; nome sem letras/dígitos = null. */
export function unitSlug(name: string): string | null {
  const slug = normalizeName(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/** Texto livre cadastrado (nomes): sem controles e sem início que vire fórmula em planilha exportada. */
export function isSafeLabel(value: string): boolean {
  return !/[\p{Cc}\p{Cf}]/u.test(value) && !/^[=+\-@]/.test(value);
}

export function stripFormulaPrefix(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
