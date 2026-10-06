import { authenticatedRoute } from "@/modules/access/command-route";
import { registerManualTopup } from "@/modules/payments/topup-commands";
import { listTopups } from "@/modules/payments/topup-queries";

export const dynamic = "force-dynamic";

/** Conferência das recargas manuais: do dia (`?date=`, padrão hoje; `mine=1` = só as minhas) ou de um aluno (`?studentId=`). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "topups list", ({ actor, deps, url }) => listTopups(deps.db, actor, Object.fromEntries(url.searchParams)));

/** Registra recebimento confirmado (dinheiro, Pix conferido, cartão aprovado) e credita o valor bruto. `topup.register`, idempotente por `key`. */
export const POST = (request: Request) => authenticatedRoute(request, "topups register", ({ actor, deps, body }) => registerManualTopup(deps.db, actor, body));
