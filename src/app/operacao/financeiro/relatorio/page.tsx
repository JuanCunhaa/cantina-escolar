"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { FinanceReportPage } from "@/modules/reports/components/finance-report-view";

export default function OperacaoRelatorioPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "finance.manage")) {
    return (
      <section>
        <h1>Financeiro</h1>
        <p>Seu perfil não acessa o financeiro.</p>
      </section>
    );
  }
  return <FinanceReportPage user={session.user} />;
}
