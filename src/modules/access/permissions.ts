import { EXTRA_PERMISSIONS, type ExtraPermission, type Role } from "./roles";

/**
 * Capacidades por papel geral. Custos e lucro pertencem somente à administração (docs/domains/access.md). Estoque (F10):
 * `inventory.read` = quantidades, lotes e reservas SEM custo (cantina e administração); `inventory.loss` = registrar perdas
 * (cantina e administração); `inventory.manage` = entradas com custo, estorno, contagem/ajuste e cotas (só administração).
 * Pedidos (F13): `orders.operate` = pedidos do dia, preparo, entrega e marcar não retirado (cantina e administração);
 * `orders.resolve` = resolver não retirado (só administração). Cancelamento (F14): `orders.cancel` = cancelamento OPERACIONAL com motivo, mesmo depois do prazo da família (cantina e administração);
 * o cancelamento da FAMÍLIA vem do vínculo ativo (ação `orders.cancel` sobre o aluno), não de capacidade.
 * Pagamentos online (F19): `payments.review` = revisar pagamentos em divergência, pendências de reembolso/chargeback e acionar a
 * conciliação com o provedor (só administração).
 * Taxas e caixa (F20): `finance.manage` = cadastrar meios/maquininhas e regras de taxa, conferir taxa/liquidação reais, rever divergências de
 * caixa, reabrir fechamentos e ver relatórios/exportação financeiros (SÓ administração); `cash.operate` = abrir/fechar o PRÓPRIO caixa
 * (secretaria, cantina e administração) — nunca o de outro operador e sem acesso a custos, lucro, regras de taxa ou caixas alheios.
 * Relatórios (F21): `reports.operational` = vendas, rankings por unidades/valor, perdas em quantidade, pedidos a realizar e cancelamentos SEM custo, margem, lucro, taxa
 * nem carteira (cantina e administração); custos, CMV, margens, resultado, compras e taxas exigem `finance.manage` + `costs.read` + `profit.read` (SÓ administração).
 * Reagendamento/antecipação e troca de produtos (F16): `orders.amend` (cantina e administração), sempre com motivo e auditoria;
 * a exceção operacional de horário só existe nesse comando da equipe. O responsável NÃO reagenda nem troca (cancela e compra de novo).
 */
export const CAPABILITIES = [
  "students.search",
  "orders.operate",
  "orders.resolve",
  "orders.cancel",
  "orders.amend",
  "pos.operate",
  "catalog.photos.manage",
  "catalog.manage",
  "menu.manage",
  "inventory.read",
  "inventory.loss",
  "inventory.manage",
  "topup.register",
  "topup.reverse",
  "payments.review",
  "finance.manage",
  "cash.operate",
  "reports.operational",
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
  cantina: ["students.search", "orders.operate", "orders.cancel", "orders.amend", "pos.operate", "catalog.photos.manage", "inventory.read", "inventory.loss", "cash.operate", "reports.operational"],
  secretaria: ["students.search", "topup.register", "cash.operate"],
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
