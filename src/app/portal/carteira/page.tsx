"use client";

import { useSession } from "@/modules/access/use-session";
import { FamilyWallet } from "@/modules/wallet/components/family-wallet";

export default function PortalCarteiraPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (session.role !== "guardian") {
    return (
      <section>
        <h1>Carteira</h1>
        <p>A carteira é consultada e movimentada pelos responsáveis vinculados ao aluno.</p>
      </section>
    );
  }
  return <FamilyWallet user={session.user} />;
}
