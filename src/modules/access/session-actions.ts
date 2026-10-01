import { signOut, type User } from "firebase/auth";
import { getFirebaseClient } from "@/lib/firebase/client";

/** "Sair de todos os dispositivos": o servidor revoga os refresh tokens; depois encerra a sessão deste navegador. */
export async function signOutEverywhere(user: User): Promise<void> {
  const response = await fetch("/api/session/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${await user.getIdToken()}` },
  });
  if (!response.ok) throw new Error("revoke_failed");
  await signOut(getFirebaseClient().auth);
}
