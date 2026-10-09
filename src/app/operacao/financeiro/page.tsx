"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { CashAdmin } from "@/modules/fees/components/cash-admin";

export default function OperacaoFinanceiroPage() {
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
  return <CashAdmin user={session.user} />;
}
