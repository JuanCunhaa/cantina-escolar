"use client";

import { useState, type FormEvent } from "react";
import { FirebaseError } from "firebase/app";
import { sendPasswordResetEmail, signInWithEmailAndPassword } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";
import type { SignedOutNotice } from "@/modules/access/use-session";

const SIGN_IN_ERRORS: Record<string, string> = {
  "auth/user-disabled": "O acesso desta conta foi encerrado. Fale com a escola.",
  "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
  "auth/network-request-failed": "Sem conexão. Verifique a internet e tente de novo.",
};

/** Login por email/senha e recuperação de senha. Mensagens não revelam se um email está cadastrado. */
export function SignInForm({ notice }: { notice: SignedOutNotice }) {
  const [mode, setMode] = useState<"signin" | "reset">("signin");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email")).trim();
    setBusy(true);
    setMessage("");
    const { auth } = getFirebaseClient();
    try {
      if (mode === "signin") {
        await signInWithEmailAndPassword(auth, email, String(form.get("password")));
      } else {
        try {
          await sendPasswordResetEmail(auth, email);
        } catch (error) {
          const code = error instanceof FirebaseError ? error.code : "";
          if (code !== "auth/user-not-found" && code !== "auth/invalid-email") throw error;
        }
        setSent(true);
      }
    } catch (error) {
      const code = error instanceof FirebaseError ? error.code : "";
      setMessage(
        SIGN_IN_ERRORS[code] ??
          (mode === "signin" ? "Email ou senha inválidos." : "Não foi possível enviar agora. Tente novamente em instantes."),
      );
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: "signin" | "reset") {
    setMode(next);
    setMessage("");
    setSent(false);
  }

  const resetting = mode === "reset";
  return (
    <form onSubmit={submit} aria-labelledby="signin-title">
      <h1 id="signin-title">{resetting ? "Recuperar senha" : "Entrar"}</h1>
      {notice === "disabled" && !resetting && (
        <p role="status" className="notice">
          Seu acesso foi encerrado. Fale com a escola se precisar de ajuda.
        </p>
      )}
      <div className="field">
        <label htmlFor="signin-email">Email</label>
        <input id="signin-email" name="email" type="email" autoComplete="username" required />
      </div>
      {!resetting && (
        <div className="field">
          <label htmlFor="signin-password">Senha</label>
          <input id="signin-password" name="password" type="password" autoComplete="current-password" required />
        </div>
      )}
      <button type="submit" disabled={busy}>
        {resetting ? "Enviar instruções" : "Entrar"}
      </button>{" "}
      <button type="button" className="secondary" onClick={() => switchMode(resetting ? "signin" : "reset")}>
        {resetting ? "Voltar ao login" : "Esqueci minha senha"}
      </button>
      <p role="alert" className="notice notice-error">
        {message}
      </p>
      {sent && (
        <p role="status" className="notice">
          Se este email estiver cadastrado, você receberá as instruções para criar uma nova senha em instantes.
        </p>
      )}
    </form>
  );
}
