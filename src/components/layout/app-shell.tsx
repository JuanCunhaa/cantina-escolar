"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { signOut } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";
import { areaFor, homeFor, navigationFor } from "@/modules/access/navigation";
import type { Role } from "@/modules/access/roles";
import { signOutEverywhere } from "@/modules/access/session-actions";
import { useSession } from "@/modules/access/use-session";
import { SignInForm } from "./sign-in-form";

const ROLE_LABEL: Record<Role, string> = {
  guardian: "Responsável",
  student: "Aluno",
  cantina: "Cantina",
  secretaria: "Secretaria",
  admin: "Administração",
};

/** Casca compartilhada do portal e da operação: pular para o conteúdo, cabeçalho, navegação por papel e área principal. */
/** Item atual: igualdade exata ou o item de caminho MAIS longo que contém a página (detalhe /portal/pedidos/{id} acende "Meus pedidos"). */
function isCurrent(pathname: string, href: string, all: readonly string[]): boolean {
  if (pathname === href) return true;
  const parent = all.filter((h) => pathname.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
  return parent === href;
}

export function AppShell({ area, children }: { area: "portal" | "operacao"; children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const [everywhereError, setEverywhereError] = useState(false);
  const role = session.status === "signedIn" ? session.role : null;
  const allowed = role !== null && areaFor(role) === area;
  const user = session.status === "signedIn" || session.status === "denied" ? session.user : null;

  async function leaveEverywhere() {
    if (!user) return;
    setEverywhereError(false);
    try {
      await signOutEverywhere(user);
    } catch {
      setEverywhereError(true);
    }
  }

  return (
    <>
      <a className="skip-link" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="shell-header">
        <span className="shell-brand">Cantina Escolar · demonstração</span>
        {user && (
          <>
            <span className="shell-user">
              {user.email}
              {role ? ` · ${ROLE_LABEL[role]}` : ""}
            </span>
            <button type="button" className="secondary" onClick={() => void signOut(getFirebaseClient().auth)}>
              Sair
            </button>
            <button type="button" className="secondary" onClick={() => void leaveEverywhere()}>
              Sair de todos os dispositivos
            </button>
          </>
        )}
      </header>
      {everywhereError && (
        <p role="alert" className="notice notice-error shell-main">
          Não foi possível encerrar as outras sessões agora. Tente novamente.
        </p>
      )}
      {role && allowed && (
        <nav className="shell-nav" aria-label="Navegação principal">
          <ul>
            {navigationFor(role).map((item) => (
              <li key={item.href}>
                {item.ready ? (
                  <Link href={item.href} aria-current={isCurrent(pathname, item.href, navigationFor(role).map((n) => n.href)) ? "page" : undefined}>
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
        {session.status === "signedOut" && <SignInForm notice={session.notice} />}
        {session.status === "denied" && (
          <section>
            <h1>Acesso ainda não liberado</h1>
            <p>Sua conta existe, mas a escola ainda não liberou um perfil de acesso. Fale com a secretaria.</p>
          </section>
        )}
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
