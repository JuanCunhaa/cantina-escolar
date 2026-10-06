import { authenticatedRoute } from "@/modules/access/command-route";
import { getTopupIntent } from "@/modules/payments/online/intent-commands";

export const dynamic = "force-dynamic";

/** Acompanhamento da recarga online (QR, copia e cola, validade e estado). Só leitura. */
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "topup intent detail", async ({ actor, deps }) => getTopupIntent(deps.db, actor, (await context.params).id));
