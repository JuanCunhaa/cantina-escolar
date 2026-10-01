import type { Metadata } from "next";
import { RedeemInvitation } from "@/modules/guardians/components/redeem-invitation";

export const metadata: Metadata = {
  title: "Convite · Cantina Escolar",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** O token do convite vem no fragmento da URL (/convite#token): nunca chega ao servidor nem aos logs de acesso. */
export default function ConvitePage() {
  return <RedeemInvitation />;
}
