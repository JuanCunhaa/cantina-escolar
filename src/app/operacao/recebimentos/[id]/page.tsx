"use client";

import { useParams } from "next/navigation";
import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { TopupReceipt } from "@/modules/payments/components/topup-receipt";

export default function OperacaoRecebimentoPage() {
  const session = useSession();
  const params = useParams<{ id: string }>();
  if (session.status !== "signedIn") return null;
  if (!can(session, "topup.register") && !can(session, "topup.reverse")) {
    return (
      <section>
        <h1>Comprovante de recarga</h1>
        <p>Seu perfil não consulta recebimentos.</p>
      </section>
    );
  }
  return <TopupReceipt user={session.user} role={session.role} permissions={session.permissions} topupId={params.id} />;
}
