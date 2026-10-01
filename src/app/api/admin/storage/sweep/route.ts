import { z } from "zod";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { getObjectStore, StorageUnavailableError } from "@/lib/storage";
import { requireActor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { accessErrorResponse } from "@/modules/access/http";
import { sweepOrphanPhotos } from "@/modules/catalog/photo-sweep";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ apply: z.boolean().optional(), graceMinutes: z.number().int().min(0).max(24 * 60).optional() }).strict();

/** Manutenção: lista (e, com apply=true, remove) fotos órfãs. Somente administração (storage.maintain); dry-run por padrão. */
export async function POST(request: Request): Promise<Response> {
  try {
    const db = adminDb();
    const actor = await requireActor(adminAuth(), db, request);
    authorize(actor, "storage.maintain");
    const input = bodySchema.parse(await request.json().catch(() => ({})));
    const result = await sweepOrphanPhotos(
      { db, store: getObjectStore() },
      { apply: input.apply === true, graceMs: input.graceMinutes === undefined ? undefined : input.graceMinutes * 60_000 },
    );
    return Response.json(result);
  } catch (error) {
    const denied = accessErrorResponse(error);
    if (denied) return denied;
    if (error instanceof z.ZodError) return Response.json({ error: "invalid_input" }, { status: 400 });
    if (error instanceof StorageUnavailableError) return Response.json({ error: "storage_unavailable" }, { status: 503 });
    console.error("storage sweep failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
