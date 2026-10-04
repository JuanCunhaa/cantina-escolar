"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { PreparationBoard } from "@/modules/orders/components/preparation-panel";

export default function OperacaoPreparacaoPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "orders.operate")) {
    return (
      <section>
        <h1>O que preparar</h1>
        <p>Seu perfil não consulta a preparação.</p>
      </section>
    );
  }
  return <PreparationBoard user={session.user} />;
}
