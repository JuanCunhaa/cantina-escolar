import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { parseServerEnv, type ServerEnv } from "@/lib/env";

const APP_NAME = "cantina-admin";

function storageBucketName(env: ServerEnv): string {
  return env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? `${env.FIREBASE_PROJECT_ID}.appspot.com`;
}

/** Admin SDK ignora Security Rules: usar apenas em handlers que autenticam e autorizam o ator. */
function getAdminApp(): App {
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return existing;
  const env = parseServerEnv(process.env);
  if (env.APP_ENV === "emulator") {
    return initializeApp({ projectId: env.FIREBASE_PROJECT_ID, storageBucket: storageBucketName(env) }, APP_NAME);
  }
  return initializeApp(
    {
      projectId: env.FIREBASE_PROJECT_ID,
      storageBucket: storageBucketName(env),
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

export function adminBucket() {
  return getStorage(getAdminApp()).bucket();
}
