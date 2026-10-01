import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";

export default function OperacaoLayout({ children }: { children: ReactNode }) {
  return <AppShell area="operacao">{children}</AppShell>;
}
