import { firestoreRest } from "../../scripts/staging/admin.ts";
import { loadTarget } from "../../scripts/staging/target.ts";

/** Acesso REST ao Firestore COMO USUÁRIO (ID token): é o que as Security Rules publicadas realmente decidem. */
export async function fsRequest(
  idToken: string | null,
  method: "GET" | "PATCH" | "DELETE",
  path: string,
  fields?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = firestoreRest(loadTarget());
  const mask = method === "PATCH" && fields ? `?${Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&")}` : "";
  const response = await fetch(`${base}/${path}${mask}`, {
    method,
    headers: { "content-type": "application/json", ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) },
    body: fields ? JSON.stringify({ fields }) : undefined,
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

export const bearer = (idToken: string) => ({ authorization: `Bearer ${idToken}` });
export const newKey = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
