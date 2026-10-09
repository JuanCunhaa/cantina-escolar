"use client";

import { useParams } from "next/navigation";
import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { CashSessionDetail } from "@/modules/fees/components/cash-admin";

export default function OperacaoCaixaDetalhePage() {
  const session = useSession();
  const params = useParams<{ id: string }>();
  if (session.status !== "signedIn") return null;
  if (!can(session, "finance.manage")) {
    return (
      <section>
        <h1>Financeiro</h1>
        <p>Seu perfil não acessa o financeiro.</p>
      </section>
    );
  }
  return <CashSessionDetail user={session.user} sessionId={params.id} />;
}
