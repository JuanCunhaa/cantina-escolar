import { authenticatedRoute } from "@/modules/access/command-route";
import { transferBetweenWallets } from "@/modules/wallet/commands";

export const dynamic = "force-dynamic";

/** Transferência entre duas carteiras de alunos vinculados ao responsável; idempotente por `key`. */
export const POST = (request: Request) =>
  authenticatedRoute(request, "wallet transfer", ({ actor, deps, body }) => transferBetweenWallets(deps.db, actor, body));
