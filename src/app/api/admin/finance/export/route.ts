import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { requireActor } from "@/modules/access/actor";
import { commandErrorResponse } from "@/modules/access/command-route";
import { exportFinance } from "@/modules/reports/finance-report";

export const dynamic = "force-dynamic";

/** Exportação CSV mensal (`?month=AAAA-MM&view=detail|summary`), UTF-8 com BOM, `;`, texto neutralizado contra fórmula. Só administração. */
export async function GET(request: Request): Promise<Response> {
  try {
    const db = adminDb();
    const actor = await requireActor(adminAuth(), db, request);
    const url = new URL(request.url);
    const out = await exportFinance(db, actor, { month: url.searchParams.get("month"), view: url.searchParams.get("view") ?? "detail" });
    return new Response(out.csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${out.filename}"`,
        "cache-control": "no-store",
        "x-date-basis": out.dateBasis,
        "x-fictitious-rules": String(out.fictitiousCount),
      },
    });
  } catch (error) {
    return commandErrorResponse(error, "finance export");
  }
}
