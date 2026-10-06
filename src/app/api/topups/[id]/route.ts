import { authenticatedRoute } from "@/modules/access/command-route";
import { readTopup } from "@/modules/payments/topup-queries";

export const dynamic = "force-dynamic";

/** Comprovante interno da recarga manual, com os estornos. `topup.register` ou `topup.reverse`. */
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "topup detail", async ({ actor, deps }) => readTopup(deps.db, actor, (await context.params).id));
