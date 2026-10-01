import { z } from "zod";
import { EXTRA_PERMISSIONS, ROLES, USER_STATUSES, type ExtraPermission, type Role, type UserStatus } from "./roles";

/** Perfil de acesso em `users/{uid}`. Escrito somente pelo servidor; o dono pode lê-lo (sessão e navegação). */
export const profileSchema = z.object({
  email: z.string().min(1).max(254),
  displayName: z.string().min(1).max(120),
  role: z.enum(ROLES),
  status: z.enum(USER_STATUSES),
  permissions: z.array(z.enum(EXTRA_PERMISSIONS)).max(EXTRA_PERMISSIONS.length).default([]),
  accessVersion: z.number().int().min(1),
});
export type AccessProfile = {
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  permissions: ExtraPermission[];
  accessVersion: number;
};

/** Perfil malformado vira "sem perfil": falha fechada. */
export function parseProfile(data: unknown): AccessProfile | null {
  const parsed = profileSchema.safeParse(data);
  return parsed.success ? (parsed.data as AccessProfile) : null;
}
