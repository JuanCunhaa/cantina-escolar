"use client";

import { useSession } from "@/modules/access/use-session";
import { FamilyMenu } from "@/modules/menu/components/family-menu";

export default function CardapioPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  return <FamilyMenu user={session.user} role={session.role} />;
}
