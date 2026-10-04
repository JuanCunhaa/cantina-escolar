"use client";

import { useSession } from "@/modules/access/use-session";
import { Statement } from "@/modules/wallet/components/statement";

export default function PortalExtratoPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (session.role !== "guardian") {
    return (
      <section>
        <h1>Extrato</h1>
        <p>O extrato da carteira é consultado pelos responsáveis vinculados ao aluno.</p>
      </section>
    );
  }
  return <Statement user={session.user} />;
}
