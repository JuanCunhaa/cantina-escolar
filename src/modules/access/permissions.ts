import { EXTRA_PERMISSIONS, type ExtraPermission, type Role } from "./roles";

/** Capacidades por papel geral. Custos e lucro pertencem somente à administração (docs/domains/access.md). */
export const CAPABILITIES = [
  "students.search",
  "orders.operate",
  "pos.operate",
  "catalog.photos.manage",
  "topup.register",
  "topup.reverse",
  "costs.read",
  "profit.read",
  "audit.read",
  "users.manage",
  "students.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const BY_ROLE: Record<Role, readonly Capability[]> = {
  guardian: [],
  student: [],
  cantina: ["students.search", "orders.operate", "pos.operate", "catalog.photos.manage"],
  secretaria: ["students.search", "topup.register"],
  admin: CAPABILITIES,
};

export type Subject = { role?: Role | null; permissions?: readonly string[] };

/** Estorno manual da secretaria é configurado separadamente: exige a permissão extra explícita. */
export function can(subject: Subject, capability: Capability): boolean {
  const role = subject.role;
  if (!role) return false;
  if (BY_ROLE[role].includes(capability)) return true;
  const extra = capability as string as ExtraPermission;
  return role === "secretaria" && (EXTRA_PERMISSIONS as readonly string[]).includes(extra) && Boolean(subject.permissions?.includes(extra));
}
