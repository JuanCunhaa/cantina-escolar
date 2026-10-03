"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { StockBoard } from "@/modules/inventory/components/stock-board";

export default function OperacaoEstoquePage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  // Cantina consulta e registra perdas; administração registra entradas, inventário, ajustes e cotas (e vê custos).
  if (!can(session, "inventory.read")) {
    return (
      <section>
        <h1>Estoque</h1>
        <p>Seu perfil não consulta o estoque.</p>
      </section>
    );
  }
  return <StockBoard user={session.user} canManage={can(session, "inventory.manage")} />;
}
