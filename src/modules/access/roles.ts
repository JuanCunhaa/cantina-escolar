/** Papéis provisórios de F02, lidos da custom claim `role` (definida apenas pelo servidor). F03 formaliza papéis. */
export const ROLES = ["guardian", "cantina", "secretaria", "admin"] as const;
export type Role = (typeof ROLES)[number];

export function parseRole(value: unknown): Role | null {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value) ? (value as Role) : null;
}

/** Funcionários que podem enviar/alterar fotos de produto (espelha firebase/storage.rules). */
export function canManagePhotos(role: Role | null | undefined): boolean {
  return role === "admin" || role === "cantina";
}
