"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { TopupDesk } from "@/modules/payments/components/topup-desk";

export default function OperacaoRecebimentosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "topup.register")) {
    return (
      <section>
        <h1>Recebimentos e recargas</h1>
        <p>Seu perfil não registra recebimentos.</p>
      </section>
    );
  }
  return <TopupDesk user={session.user} />;
}
