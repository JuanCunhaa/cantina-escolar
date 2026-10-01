"use client";

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { getFirebaseClient } from "@/lib/firebase/client";
import { parseProfile } from "./profile";
import type { ExtraPermission, Role } from "./roles";

export type SignedOutNotice = "disabled" | null;

export type Session =
  | { status: "loading" }
  | { status: "signedOut"; notice: SignedOutNotice }
  | { status: "signedIn"; user: User; role: Role; permissions: readonly ExtraPermission[] }
  /** Autenticado, mas sem perfil de acesso válido: nada é liberado (a escola precisa conceder o acesso). */
  | { status: "denied"; user: User };

/**
 * Sessão do Firebase Web Auth + perfil de acesso ao vivo (`users/{uid}`). O papel só monta a navegação: a
 * autorização real é do servidor e das Rules, que leem o mesmo perfil. Mudança de papel atualiza a navegação;
 * desativação encerra a sessão local. Listener do perfil é desligado no logout e na desmontagem.
 */
export function useSession(): Session {
  const [session, setSession] = useState<Session>({ status: "loading" });
  const notice = useRef<SignedOutNotice>(null);

  useEffect(() => {
    const { auth, db } = getFirebaseClient();
    let stopProfile: (() => void) | null = null;
    const stopAuth = onAuthStateChanged(auth, (user) => {
      stopProfile?.();
      stopProfile = null;
      if (!user) {
        setSession({ status: "signedOut", notice: notice.current });
        notice.current = null;
        return;
      }
      setSession({ status: "loading" });
      stopProfile = onSnapshot(
        doc(db, "users", user.uid),
        (snap) => {
          const profile = snap.exists() ? parseProfile(snap.data()) : null;
          if (!profile) setSession({ status: "denied", user });
          else if (profile.status !== "active") {
            notice.current = "disabled";
            void signOut(auth);
          } else setSession({ status: "signedIn", user, role: profile.role, permissions: profile.permissions });
        },
        () => setSession({ status: "denied", user }),
      );
    });
    return () => {
      stopProfile?.();
      stopAuth();
    };
  }, []);

  return session;
}
