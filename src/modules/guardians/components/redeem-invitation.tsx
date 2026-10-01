"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { SignInForm } from "@/components/layout/sign-in-form";
import { api, errorText } from "@/lib/api-client";
import { getFirebaseClient } from "@/lib/firebase/client";
import { useSession } from "@/modules/access/use-session";

/**
 * Página pública do convite. O link é a credencial (token secreto, uso único, com validade). Sem conta: cria a conta com
 * e-mail e senha. Com conta: entra e vincula a conta ao convite. O servidor revalida tudo; esta tela só conduz.
 */
function subscribeHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** O token vai no fragmento da URL (#...): o navegador não o envia ao servidor, então não entra em logs de acesso. */
export function RedeemInvitation() {
  const token = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash.slice(1),
    () => "",
  );
  const session = useSession();
  const [mode, setMode] = useState<"create" | "signin">("create");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();

  async function finish() {
    setDone(true);
    router.push("/portal");
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email")).trim();
    const password = String(data.get("password"));
    setBusy(true);
    setError(null);
    const contact = String(data.get("contact") ?? "").trim();
    const result = await api(null, "POST", "/api/invitations/redeem", {
      token,
      email,
      password,
      displayName: String(data.get("displayName")).trim(),
      ...(contact ? { contact } : {}),
    });
    if (!result.ok) {
      setBusy(false);
      setError(errorText(result.error));
      return;
    }
    setDone(true);
    try {
      await signInWithEmailAndPassword(getFirebaseClient().auth, email, password);
      router.push("/portal");
    } catch {
      setDone(false);
      setBusy(false);
      setError("Conta criada, mas não foi possível entrar agora. Use a tela de login.");
    }
  }

  async function linkSignedIn() {
    if (session.status !== "signedIn" && session.status !== "denied") return;
    setBusy(true);
    setError(null);
    const result = await api(session.user, "POST", "/api/invitations/redeem", { token });
    setBusy(false);
    if (!result.ok) setError(errorText(result.error));
    else await finish();
  }

  const user = session.status === "signedIn" || session.status === "denied" ? session.user : null;
  const validToken = /^[A-Za-z0-9_-]{43}$/.test(token);

  return (
    <main id="conteudo" className="shell-main" tabIndex={-1} style={{ maxWidth: "36rem" }}>
      <h1>Convite da Cantina Escolar</h1>
      {!validToken && session.status !== "loading" ? (
        <p role="alert" className="notice notice-error">
          Link de convite incompleto. Abra o link inteiro enviado pela escola ou peça um novo convite.
        </p>
      ) : done ? (
        <p role="status">Convite aceito. Abrindo o portal…</p>
      ) : session.status === "loading" ? (
        <p role="status">Carregando…</p>
      ) : user ? (
        <section>
          <p>
            Você está conectado como <strong>{user.email}</strong>. Aceitar o convite vincula esta conta ao acesso oferecido pela escola.
          </p>
          <button type="button" disabled={busy} onClick={() => void linkSignedIn()}>
            Aceitar convite com esta conta
          </button>{" "}
          <button type="button" className="secondary" disabled={busy} onClick={() => void signOut(getFirebaseClient().auth)}>
            Usar outra conta
          </button>
        </section>
      ) : mode === "create" ? (
        <section>
          <p className="muted">Crie sua conta para aceitar o convite. O link vale uma única vez e por tempo limitado.</p>
          <form onSubmit={(event) => void createAccount(event)} aria-label="Criar conta pelo convite">
            <div className="field">
              <label htmlFor="r-name">Seu nome completo</label>
              <input id="r-name" name="displayName" type="text" required minLength={2} maxLength={120} autoComplete="name" />
            </div>
            <div className="field">
              <label htmlFor="r-email">Email</label>
              <input id="r-email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="field">
              <label htmlFor="r-password">Senha (mínimo 8 caracteres)</label>
              <input id="r-password" name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
            </div>
            <div className="field">
              <label htmlFor="r-contact">Telefone para contato (opcional)</label>
              <input id="r-contact" name="contact" type="text" maxLength={60} autoComplete="tel" />
            </div>
            <button type="submit" disabled={busy}>
              Criar conta e aceitar convite
            </button>
          </form>
          <p>
            <button type="button" className="secondary" onClick={() => { setError(null); setMode("signin"); }}>
              Já tenho conta
            </button>
          </p>
        </section>
      ) : (
        <section>
          <p className="muted">Entre com a sua conta; depois confirme o convite.</p>
          <SignInForm notice={null} />
          <p>
            <button type="button" className="secondary" onClick={() => setMode("create")}>
              Criar uma conta nova
            </button>
          </p>
        </section>
      )}
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
    </main>
  );
}
