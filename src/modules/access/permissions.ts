import { EXTRA_PERMISSIONS, type ExtraPermission, type Role } from "./roles";

/**
 * Capacidades por papel geral. Custos e lucro pertencem somente à administração (docs/domains/access.md). Estoque (F10):
 * `inventory.read` = quantidades, lotes e reservas SEM custo (cantina e administração); `inventory.loss` = registrar perdas
 * (cantina e administração); `inventory.manage` = entradas com custo, estorno, contagem/ajuste e cotas (só administração).
 * Pedidos (F13): `orders.operate` = pedidos do dia, preparo, entrega e marcar não retirado (cantina e administração);
 * `orders.resolve` = resolver não retirado (só administração).
 */
export const CAPABILITIES = [
  "students.search",
  "orders.operate",
  "orders.resolve",
  "pos.operate",
  "catalog.photos.manage",
  "catalog.manage",
  "menu.manage",
  "inventory.read",
  "inventory.loss",
  "inventory.manage",
  "topup.register",
  "topup.reverse",
  "costs.read",
  "profit.read",
  "audit.read",
  "users.manage",
  "students.manage",
  "storage.maintain",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const BY_ROLE: Record<Role, readonly Capability[]> = {
  guardian: [],
  student: [],
  cantina: ["students.search", "orders.operate", "pos.operate", "catalog.photos.manage", "inventory.read", "inventory.loss"],
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
