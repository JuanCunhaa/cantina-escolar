"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { MenuAdmin } from "@/modules/menu/components/menu-admin";

export default function OperacaoCardapioPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  // Administração altera; cantina (opera pedidos) consulta. Secretaria não usa o cardápio.
  if (!can(session, "menu.manage") && !can(session, "orders.operate")) {
    return (
      <section>
        <h1>Cardápio</h1>
        <p>Seu perfil não consulta o cardápio da operação.</p>
      </section>
    );
  }
  return <MenuAdmin user={session.user} canManage={can(session, "menu.manage")} />;
}
