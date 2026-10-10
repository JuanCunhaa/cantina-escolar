import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { requireActor } from "@/modules/access/actor";
import { commandErrorResponse } from "@/modules/access/command-route";
import { exportSales } from "@/modules/reports/sales-report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Exportação do período (`?view=summary|products|detail|losses|purchases|pending|cancellations|ledger&format=csv|xlsx` + os filtros do relatório).
 * Mesmo corte de papéis do relatório; texto neutralizado contra fórmulas; 409 `export_truncated` em vez de arquivo parcial.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const db = adminDb();
    const actor = await requireActor(adminAuth(), db, request);
    const out = await exportSales(db, actor, Object.fromEntries(new URL(request.url).searchParams));
    return new Response(out.body as BodyInit, {
      status: 200,
      headers: {
        "content-type": out.contentType,
        "content-disposition": `attachment; filename="${out.filename}"`,
        "cache-control": "no-store",
        "x-date-basis": out.dateBasis,
        "x-report-scope": out.scope,
        "x-fictitious-rules": String(out.fictitious),
      },
    });
  } catch (error) {
    return commandErrorResponse(error, "sales export");
  }
}
