"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { FeeConfigPage } from "@/modules/fees/components/fee-config";

export default function OperacaoTaxasPage() {
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
  return <FeeConfigPage user={session.user} />;
}
