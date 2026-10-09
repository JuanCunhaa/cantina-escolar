"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { CashDesk } from "@/modules/cash/components/cash-desk";

export default function OperacaoCaixaPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "cash.operate")) {
    return (
      <section>
        <h1>Caixa</h1>
        <p>Seu perfil não opera caixa.</p>
      </section>
    );
  }
  return <CashDesk user={session.user} />;
}
