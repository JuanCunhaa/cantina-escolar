"use client";

import { useState, type FormEvent } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";

export function SignInForm() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      await signInWithEmailAndPassword(getFirebaseClient().auth, String(form.get("email")), String(form.get("password")));
    } catch {
      setMessage("Email ou senha inválidos.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby="signin-title">
      <h1 id="signin-title">Entrar</h1>
      <div className="field">
        <label htmlFor="signin-email">Email</label>
        <input id="signin-email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="field">
        <label htmlFor="signin-password">Senha</label>
        <input id="signin-password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <button type="submit" disabled={busy}>
        Entrar
      </button>
      <p role="alert" className="notice notice-error">
        {message}
      </p>
    </form>
  );
}
