"use client";

import { useEffect, useState, type FormEvent } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebaseClient } from "@/lib/firebase/client";

type Snapshot = { balanceCents: number | null; fromCache: boolean };

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export function FoundationProbe() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const { auth } = getFirebaseClient();
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setReady(true);
    });
  }, []);

  // Listener privado: escopo do próprio uid; desligado no logout/troca de usuário pelo cleanup.
  const uid = user?.uid;
  useEffect(() => {
    if (!uid) return;
    const { db } = getFirebaseClient();
    const unsubscribe = onSnapshot(
      doc(db, "foundationProbes", uid),
      { includeMetadataChanges: true },
      (snap) => {
        const balance = snap.exists() ? Number(snap.get("balanceCents")) : 0;
        setSnapshot({ balanceCents: balance, fromCache: snap.metadata.fromCache });
      },
      () => setMessage("Falha ao ouvir os dados."),
    );
    return () => {
      unsubscribe();
      setSnapshot(null);
    };
  }, [uid]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage("");
    try {
      await signInWithEmailAndPassword(getFirebaseClient().auth, String(form.get("email")), String(form.get("password")));
    } catch {
      setMessage("Email ou senha inválidos.");
    }
  }

  async function runCommand() {
    if (!user) return;
    setMessage("");
    const token = await user.getIdToken();
    const response = await fetch("/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: crypto.randomUUID(), amountCents: 500 }),
    });
    setMessage(response.ok ? "Comando confirmado pelo servidor." : `Comando recusado (${response.status}).`);
  }

  if (!ready) return <p>Carregando…</p>;

  if (!user) {
    return (
      <form onSubmit={login}>
        <p>
          <label>
            Email <input name="email" type="email" autoComplete="username" required />
          </label>
        </p>
        <p>
          <label>
            Senha <input name="password" type="password" autoComplete="current-password" required />
          </label>
        </p>
        <button type="submit">Entrar</button>
        <p role="alert">{message}</p>
      </form>
    );
  }

  return (
    <section>
      <p>Conectado: {user.email}</p>
      <p data-testid="balance">
        Saldo de prova: {snapshot?.balanceCents == null ? "…" : formatBRL(snapshot.balanceCents)}
        {snapshot?.fromCache ? " (cache, não confirmado)" : ""}
      </p>
      <button type="button" onClick={() => void runCommand()}>
        Creditar R$ 5,00 (prova)
      </button>{" "}
      <button type="button" onClick={() => void signOut(getFirebaseClient().auth)}>
        Sair
      </button>
      <p role="status">{message}</p>
    </section>
  );
}
