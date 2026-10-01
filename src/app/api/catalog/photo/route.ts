import { ZodError } from "zod";
import { adminAuth, adminBucket, adminDb } from "@/lib/firebase/admin";
import { requireActor } from "@/modules/access/actor";
import { accessErrorResponse } from "@/modules/access/http";
import { PhotoRejectedError, ProductNotFoundError, registerProductPhoto } from "@/modules/catalog/photo";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Catálogo de demonstração (F02): indisponível em produção até o catálogo real (F06).
  if (process.env.APP_ENV === "production" || !process.env.APP_ENV) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const actor = await requireActor(adminAuth(), adminDb(), request);
    const body: unknown = await request.json().catch(() => null);
    return Response.json(await registerProductPhoto({ db: adminDb(), bucket: adminBucket() }, actor, body));
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;
    if (error instanceof ZodError) return Response.json({ error: "invalid_input" }, { status: 400 });
    if (error instanceof ProductNotFoundError) return Response.json({ error: "product_not_found" }, { status: 404 });
    if (error instanceof PhotoRejectedError) return Response.json({ error: "photo_rejected" }, { status: 422 });
    console.error("photo registration failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
