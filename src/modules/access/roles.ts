/**
 * Papéis gerais (F03). O papel mora em `users/{uid}` no Firestore (fonte atual lida pelo servidor e pelas Rules);
 * vínculos e políticas mutáveis (guardianStudentLinks, studentPolicies) são autorizados à parte, em authorize.ts.
 */
export const ROLES = ["guardian", "student", "cantina", "secretaria", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const STAFF_ROLES = ["cantina", "secretaria", "admin"] as const;

/** Permissões extras concedidas individualmente pela administração (hoje só estorno manual da secretaria). */
export const EXTRA_PERMISSIONS = ["topup.reverse"] as const;
export type ExtraPermission = (typeof EXTRA_PERMISSIONS)[number];

export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export function parseRole(value: unknown): Role | null {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value) ? (value as Role) : null;
}

export function isStaff(role: Role | null | undefined): boolean {
  return role === "cantina" || role === "secretaria" || role === "admin";
}
