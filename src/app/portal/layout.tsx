import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <AppShell area="portal">{children}</AppShell>;
}
