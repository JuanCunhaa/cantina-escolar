"use client";

import { MenuView } from "@/modules/catalog/components/menu-view";
import { useSession } from "@/modules/access/use-session";

export default function CardapioPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  return <MenuView uid={session.user.uid} />;
}
