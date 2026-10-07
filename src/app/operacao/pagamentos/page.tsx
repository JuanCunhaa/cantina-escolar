"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { PaymentsReview } from "@/modules/payments/components/payments-review";

export default function OperacaoPagamentosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "payments.review")) {
    return (
      <section>
        <h1>Pagamentos online</h1>
        <p>Seu perfil não revisa pagamentos online.</p>
      </section>
    );
  }
  return <PaymentsReview user={session.user} />;
}
