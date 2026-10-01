"use client";

import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";
import { parseRole, type Role } from "./roles";

export type Session =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; user: User; role: Role };

/**
 * Sessão do Firebase Web Auth. O papel vem da claim do ID token e serve só para montar a navegação:
 * a autorização real é do servidor e das Rules. Sem claim = responsável (padrão provisório até F03).
 */
export function useSession(): Session {
  const [session, setSession] = useState<Session>({ status: "loading" });

  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(getFirebaseClient().auth, (user) => {
      if (!user) {
        setSession({ status: "signedOut" });
        return;
      }
      void user.getIdTokenResult().then(
        (token) => active && setSession({ status: "signedIn", user, role: parseRole(token.claims.role) ?? "guardian" }),
        () => active && setSession({ status: "signedOut" }),
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return session;
}
