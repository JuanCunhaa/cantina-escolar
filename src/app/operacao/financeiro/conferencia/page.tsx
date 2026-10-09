"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { ReconcilePage } from "@/modules/fees/components/reconcile-list";

export default function OperacaoConferenciaPage() {
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
  return <ReconcilePage user={session.user} />;
}
