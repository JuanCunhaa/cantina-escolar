"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { PosTerminal } from "@/modules/pos/components/pos-terminal";

export default function OperacaoPdvPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "pos.operate")) {
    return (
      <section>
        <h1>PDV de balcão</h1>
        <p>Seu perfil não opera o balcão.</p>
      </section>
    );
  }
  return <PosTerminal user={session.user} />;
}
