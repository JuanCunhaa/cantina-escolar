import { ZodError } from "zod";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { getObjectStore, StorageUnavailableError } from "@/lib/storage";
import { PayloadTooLargeError, readBodyLimited } from "@/lib/storage/body";
import { requireActor } from "@/modules/access/actor";
import { accessErrorResponse } from "@/modules/access/http";
import {
  PhotoRejectedError,
  PhotoUnavailableError,
  ProductNotFoundError,
  readProductPhoto,
  uploadProductPhoto,
} from "@/modules/catalog/photo";

export const dynamic = "force-dynamic";

// Catálogo de demonstração (F02): indisponível em produção até o catálogo real (F06).
const demoCatalogDisabled = (): boolean => process.env.APP_ENV === "production" || !process.env.APP_ENV;

function errorResponse(error: unknown, what: string): Response {
  const denied = accessErrorResponse(error);
  if (denied) return denied;
  if (error instanceof ZodError) return Response.json({ error: "invalid_input" }, { status: 400 });
  if (error instanceof ProductNotFoundError) return Response.json({ error: "product_not_found" }, { status: 404 });
  if (error instanceof PhotoUnavailableError) return Response.json({ error: "photo_unavailable" }, { status: 404 });
  if (error instanceof PayloadTooLargeError) return Response.json({ error: "photo_too_large" }, { status: 413 });
  if (error instanceof PhotoRejectedError) return Response.json({ error: "photo_rejected" }, { status: 422 });
  if (error instanceof StorageUnavailableError) {
    console.error(`${what}: storage unavailable`);
    return Response.json({ error: "storage_unavailable" }, { status: 503 });
  }
  console.error(`${what} failed`, error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "internal" }, { status: 500 });
}

/**
 * Troca de foto. Corpo = bytes da imagem (Content-Type = tipo declarado), `?productId=`. Papel e UID vêm do token
 * verificado + perfil atual; a chave do objeto é gerada no servidor. Limite real: 2 MB (a Vercel aceita até 4,5 MB).
 */
export async function POST(request: Request): Promise<Response> {
  if (demoCatalogDisabled()) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const actor = await requireActor(adminAuth(), adminDb(), request);
    const declaredType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
    const result = await uploadProductPhoto({ db: adminDb(), store: getObjectStore() }, actor, {
      productId: new URL(request.url).searchParams.get("productId"),
      declaredType,
      readBody: (limit) => readBodyLimited(request, limit),
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error, "photo upload");
  }
}

/** Leitura autenticada da foto atual do produto (`?productId=`); o bucket é privado e nunca exposto ao navegador. */
export async function GET(request: Request): Promise<Response> {
  if (demoCatalogDisabled()) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const actor = await requireActor(adminAuth(), adminDb(), request);
    const photo = await readProductPhoto(
      { db: adminDb(), store: getObjectStore() },
      actor,
      new URL(request.url).searchParams.get("productId"),
      request.headers.get("if-none-match"),
    );
    const headers = {
      etag: photo.etag,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
    };
    if (photo.kind === "not-modified") return new Response(null, { status: 304, headers });
    return new Response(photo.body as BodyInit, {
      headers: {
        ...headers,
        "content-type": photo.contentType,
        "content-length": String(photo.body.byteLength),
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return errorResponse(error, "photo read");
  }
}
