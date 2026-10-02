// Admin SDK do harness de homologação (fixtures, preflight, testes). Staging: conta de serviço do projeto confirmado.
// Emulador (ensaio): sem credencial, apontando para os emuladores definidos no ambiente (firebase emulators:exec).
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { loadTarget, type Target } from "./target.ts";

export type Admin = { target: Target; app: App; auth: Auth; db: Firestore };
let cached: Admin | undefined;

export function admin(target: Target = loadTarget()): Admin {
  if (cached && cached.target.projectId === target.projectId) return cached;
  const name = `staging-harness-${target.projectId}`;
  const app =
    getApps().find((a) => a.name === name) ??
    initializeApp(
      target.adminCredential
        ? {
            projectId: target.projectId,
            credential: cert({
              projectId: target.projectId,
              clientEmail: target.adminCredential.clientEmail,
              privateKey: target.adminCredential.privateKey.replace(/\n/g, "\n"),
            }),
          }
        : { projectId: target.projectId },
      name,
    );
  cached = { target, app, auth: getAuth(app), db: getFirestore(app) };
  return cached;
}

/** Login por e-mail/senha (Identity Toolkit real ou do emulador): devolve ID token verdadeiro do alvo. */
export async function signIn(target: Target, email: string, password: string): Promise<{ uid: string; idToken: string }> {
  const base =
    target.kind === "staging"
      ? "https://identitytoolkit.googleapis.com/v1"
      : `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099"}/identitytoolkit.googleapis.com/v1`;
  const response = await fetch(`${base}/accounts:signInWithPassword?key=${encodeURIComponent(target.apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!response.ok) {
    const detail = ((await response.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "";
    throw new Error(`signIn falhou: ${response.status} ${detail}`.trim());
  }
  const body = (await response.json()) as { localId: string; idToken: string };
  return { uid: body.localId, idToken: body.idToken };
}

/** Base REST do Firestore do alvo (regras valem para Bearer de usuário; Admin SDK não passa por aqui). */
export function firestoreRest(target: Target): string {
  const root = target.kind === "staging" ? "https://firestore.googleapis.com" : `http://${process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080"}`;
  return `${root}/v1/projects/${target.projectId}/databases/(default)/documents`;
}
