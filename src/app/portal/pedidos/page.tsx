"use client";

import { useSession } from "@/modules/access/use-session";
import { MyOrders } from "@/modules/orders/components/my-orders";

export default function PortalPedidosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  return <MyOrders user={session.user} role={session.role} />;
}
