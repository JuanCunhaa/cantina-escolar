import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { parseServerEnv } from "@/lib/env";

const APP_NAME = "cantina-admin";

/** Admin SDK ignora Security Rules: usar apenas em handlers que autenticam e autorizam o ator. */
function getAdminApp(): App {
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return existing;
  const env = parseServerEnv(process.env);
  if (env.APP_ENV === "emulator") {
    return initializeApp({ projectId: env.FIREBASE_PROJECT_ID }, APP_NAME);
  }
  return initializeApp(
    {
      projectId: env.FIREBASE_PROJECT_ID,
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    },
    APP_NAME,
  );
}

export function adminDb(): Firestore {
  return getFirestore(getAdminApp());
}

export function adminAuth(): Auth {
  return getAuth(getAdminApp());
}
