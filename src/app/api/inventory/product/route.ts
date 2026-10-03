import { z } from "zod";
import { authenticatedRoute } from "@/modules/access/command-route";
import { readProductStock } from "@/modules/inventory/queries";

export const dynamic = "force-dynamic";

const querySchema = z.object({ productId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

/** Detalhe de estoque de um produto: lotes, reservas, cotas e movimentos (sem custo para a cantina). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "inventory product", ({ actor, deps, url }) => {
    const { productId } = querySchema.parse({ productId: url.searchParams.get("productId") });
    return readProductStock(deps.db, actor, productId);
  });
