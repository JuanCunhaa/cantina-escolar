"use client";

import Link from "next/link";
import { navigationFor } from "@/modules/access/navigation";
import { useSession } from "@/modules/access/use-session";

/** Início de cada área: lista aberta das telas disponíveis ao papel, sem repetir a navegação em cards. */
export function AreaHome({ title }: { title: string }) {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  const items = navigationFor(session.role).filter((item) => !item.href.endsWith("/portal") && item.href !== "/operacao");
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">Ambiente de demonstração com dados fictícios.</p>
      <h2>Disponível agora</h2>
      <ul>
        {items.filter((i) => i.ready).map((i) => (
          <li key={i.href}>
            <Link href={i.href}>{i.label}</Link>
          </li>
        ))}
      </ul>
      <h2>Em breve</h2>
      <ul className="muted">
        {items.filter((i) => !i.ready).map((i) => (
          <li key={i.href}>{i.label}</li>
        ))}
      </ul>
    </section>
  );
}
