import type { Role } from "./roles";

export type NavItem = { href: string; label: string; roles: readonly Role[]; ready: boolean };

/** Itens de navegação por papel. `ready: false` = tela de tarefa futura, exibida como indisponível (sem link quebrado). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/portal", label: "Início", roles: ["guardian", "student"], ready: true },
  { href: "/portal/cardapio", label: "Cardápio", roles: ["guardian", "student"], ready: true },
  { href: "/portal/alunos", label: "Alunos", roles: ["guardian"], ready: true },
  { href: "/portal/pedidos", label: "Meus pedidos", roles: ["guardian", "student"], ready: true },
  { href: "/portal/carteira", label: "Carteira", roles: ["guardian"], ready: true },
  { href: "/portal/carteira/extrato", label: "Extrato", roles: ["guardian"], ready: true },
  { href: "/operacao", label: "Início", roles: ["cantina", "secretaria", "admin"], ready: true },
  { href: "/operacao/alunos", label: "Alunos", roles: ["cantina", "secretaria", "admin"], ready: true },
  { href: "/operacao/pedidos", label: "Pedidos do dia", roles: ["cantina", "admin"], ready: true },
  { href: "/operacao/preparacao", label: "O que preparar", roles: ["cantina", "admin"], ready: true },
  { href: "/operacao/pdv", label: "PDV", roles: ["cantina", "admin"], ready: true },
  { href: "/operacao/produtos", label: "Produtos", roles: ["cantina", "admin"], ready: true },
  { href: "/operacao/cardapio", label: "Cardápio", roles: ["cantina", "admin"], ready: true },
  { href: "/operacao/estoque", label: "Estoque", roles: ["cantina", "admin"], ready: true },
  { href: "/operacao/recebimentos", label: "Recebimentos", roles: ["secretaria", "admin"], ready: true },
  { href: "/operacao/responsaveis", label: "Responsáveis", roles: ["admin"], ready: true },
  { href: "/operacao/escola", label: "Turmas e turnos", roles: ["admin"], ready: true },
  { href: "/operacao/calendario", label: "Calendário e horários", roles: ["admin"], ready: true },
  { href: "/operacao/painel", label: "Painel", roles: ["admin"], ready: false },
];

export function navigationFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

/** Área de cada papel: família (responsável e aluno) no portal, equipe na operação. */
export function areaFor(role: Role): "portal" | "operacao" {
  return role === "guardian" || role === "student" ? "portal" : "operacao";
}

export function homeFor(role: Role): string {
  return areaFor(role) === "portal" ? "/portal" : "/operacao";
}
