import { ZodError } from "zod";
import { adminAuth, adminBucket, adminDb } from "@/lib/firebase/admin";
import { requireActor, UnauthenticatedError } from "@/modules/access/actor";
import { ForbiddenError, PhotoRejectedError, ProductNotFoundError, registerProductPhoto } from "@/modules/catalog/photo";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Catálogo de demonstração (F02): indisponível em produção até o catálogo real (F06).
  if (process.env.APP_ENV === "production" || !process.env.APP_ENV) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const actor = await requireActor(adminAuth(), request);
    const body: unknown = await request.json().catch(() => null);
    return Response.json(await registerProductPhoto({ db: adminDb(), bucket: adminBucket() }, actor, body));
  } catch (error) {
    if (error instanceof UnauthenticatedError) return Response.json({ error: "unauthenticated" }, { status: 401 });
    if (error instanceof ForbiddenError) return Response.json({ error: "forbidden" }, { status: 403 });
    if (error instanceof ZodError) return Response.json({ error: "invalid_input" }, { status: 400 });
    if (error instanceof ProductNotFoundError) return Response.json({ error: "product_not_found" }, { status: 404 });
    if (error instanceof PhotoRejectedError) return Response.json({ error: "photo_rejected" }, { status: 422 });
    console.error("photo registration failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
