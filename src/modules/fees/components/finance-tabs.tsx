import Link from "next/link";

export const FINANCE_TABS = [
  { href: "/operacao/financeiro", label: "Caixas" },
  { href: "/operacao/financeiro/conferencia", label: "Conferência" },
  { href: "/operacao/financeiro/taxas", label: "Taxas e maquininhas" },
  { href: "/operacao/financeiro/relatorio", label: "Relatório" },
  { href: "/operacao/relatorios", label: "Vendas e margens" },
] as const;

/** Navegação das telas financeiras da administração (lista simples, a aba atual marcada com texto e `aria-current`). */
export function FinanceTabs({ current }: { current: (typeof FINANCE_TABS)[number]["href"] }) {
  return (
    <nav aria-label="Financeiro" className="order-tabs">
      {FINANCE_TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={t.href === current ? "page" : undefined} className={t.href === current ? "badge badge-pending" : "badge"}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
