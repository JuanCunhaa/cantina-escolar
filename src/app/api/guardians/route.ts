import { authenticatedRoute } from "@/modules/access/command-route";
import { listGuardians } from "@/modules/guardians/queries";

export const dynamic = "force-dynamic";

/** Diretório de responsáveis (administração). */
export const GET = (request: Request) => authenticatedRoute(request, "guardians list", ({ actor, deps }) => listGuardians(deps.db, actor));
