import { z } from "zod";
import { authenticatedRoute } from "@/modules/access/command-route";
import { reconcileStock } from "@/modules/inventory/queries";

export const dynamic = "force-dynamic";

const querySchema = z.object({ productId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() });

/** Reconciliação saldo × livro × lotes × reservas × cotas (um produto ou todos); somente administração (`audit.read`). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "inventory reconcile", ({ actor, deps, url }) => {
    const { productId } = querySchema.parse({ productId: url.searchParams.get("productId") ?? undefined });
    return reconcileStock(deps.db, actor, productId);
  });
