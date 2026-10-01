"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { signOut } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";
import { homeFor, navigationFor } from "@/modules/access/navigation";
import type { Role } from "@/modules/access/roles";
import { useSession } from "@/modules/access/use-session";
import { SignInForm } from "./sign-in-form";

const ROLE_LABEL: Record<Role, string> = {
  guardian: "Responsável",
  cantina: "Cantina",
  secretaria: "Secretaria",
  admin: "Administração",
};

/** Casca compartilhada do portal e da operação: pular para o conteúdo, cabeçalho, navegação por papel e área principal. */
export function AppShell({ area, children }: { area: "portal" | "operacao"; children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const role = session.status === "signedIn" ? session.role : null;
  const allowed = role !== null && (area === "portal" ? role === "guardian" : role !== "guardian");

  return (
    <>
      <a className="skip-link" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="shell-header">
        <span className="shell-brand">Cantina Escolar · demonstração</span>
        {session.status === "signedIn" && (
          <>
            <span className="shell-user">
              {session.user.email} · {ROLE_LABEL[session.role]}
            </span>
            <button type="button" className="secondary" onClick={() => void signOut(getFirebaseClient().auth)}>
              Sair
            </button>
          </>
        )}
      </header>
      {role && allowed && (
        <nav className="shell-nav" aria-label="Navegação principal">
          <ul>
            {navigationFor(role).map((item) => (
              <li key={item.href}>
                {item.ready ? (
                  <Link href={item.href} aria-current={pathname === item.href ? "page" : undefined}>
                    {item.label}
                  </Link>
                ) : (
                  <span className="nav-disabled" aria-disabled="true">
                    {item.label} (em breve)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </nav>
      )}
      <main id="conteudo" className="shell-main" tabIndex={-1}>
        {session.status === "loading" && <p role="status">Carregando…</p>}
        {session.status === "signedOut" && <SignInForm />}
        {session.status === "signedIn" && !allowed && (
          <section>
            <h1>Área indisponível para o seu perfil</h1>
            <p>
              <Link href={homeFor(session.role)}>Ir para a minha área</Link>
            </p>
          </section>
        )}
        {session.status === "signedIn" && allowed && children}
      </main>
    </>
  );
}
