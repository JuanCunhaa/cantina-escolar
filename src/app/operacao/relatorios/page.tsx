"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { SalesReportPage } from "@/modules/reports/components/sales-report-view";

export default function OperacaoRelatoriosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "reports.operational")) {
    return (
      <section>
        <h1>Relatórios</h1>
        <p>Seu perfil não acessa os relatórios de vendas.</p>
      </section>
    );
  }
  // A administração vê também custos, margens e resultado (decidido pelo servidor); as abas do Financeiro só aparecem para ela.
  return <SalesReportPage user={session.user} tabs={can(session, "finance.manage")} />;
}
