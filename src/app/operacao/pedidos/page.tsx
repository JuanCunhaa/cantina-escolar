"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { DayOrdersBoard } from "@/modules/orders/components/day-orders";

export default function OperacaoPedidosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "orders.operate")) {
    return (
      <section>
        <h1>Pedidos do dia</h1>
        <p>Seu perfil não opera pedidos.</p>
      </section>
    );
  }
  return <DayOrdersBoard user={session.user} canResolve={can(session, "orders.resolve")} canCancel={can(session, "orders.cancel")} canDiscard={can(session, "inventory.loss")} canAmend={can(session, "orders.amend")} />;
}
