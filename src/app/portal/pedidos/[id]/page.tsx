"use client";

import { useParams } from "next/navigation";
import { useSession } from "@/modules/access/use-session";
import { OrderDetailView } from "@/modules/orders/components/order-detail";

export default function PortalPedidoPage() {
  const session = useSession();
  const params = useParams<{ id: string }>();
  if (session.status !== "signedIn") return null;
  return <OrderDetailView user={session.user} orderId={params.id} />;
}
