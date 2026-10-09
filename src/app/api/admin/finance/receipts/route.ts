import { authenticatedRoute } from "@/modules/access/command-route";
import { getReceiptForAdmin, listPendingReconciliation } from "@/modules/fees/fee-queries";

export const dynamic = "force-dynamic";

/** Recebimentos com taxa ou liquidação a conferir; com `?ref=tipo:id`, um recebimento e seu histórico de conferências. Só administração. */
export const GET = (request: Request) =>
  authenticatedRoute(request, "finance receipts", ({ actor, deps, url }) => {
    const ref = url.searchParams.get("ref");
    return ref ? getReceiptForAdmin(deps.db, actor, ref) : listPendingReconciliation(deps.db, actor);
  });
