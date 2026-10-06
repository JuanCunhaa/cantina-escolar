"use client";

import { useSession } from "@/modules/access/use-session";
import { OnlineTopup } from "@/modules/payments/components/online-topup";

export default function PortalRecargaPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (session.role !== "guardian") {
    return (
      <section>
        <h1>Recarregar carteira</h1>
        <p>A recarga online é feita pelos responsáveis vinculados ao aluno.</p>
      </section>
    );
  }
  return <OnlineTopup user={session.user} />;
}
