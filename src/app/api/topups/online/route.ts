import { authenticatedRoute } from "@/modules/access/command-route";
import { onlineProviders } from "@/modules/payments/online/config";
import { createTopupIntent, listTopupIntents } from "@/modules/payments/online/intent-commands";

export const dynamic = "force-dynamic";

/** Últimas recargas online de um aluno (`?studentId=`): quem lê a carteira dele. */
export const GET = (request: Request) =>
  authenticatedRoute(request, "topup intents list", ({ actor, deps, url }) => listTopupIntents(deps.db, actor, Object.fromEntries(url.searchParams)));

/**
 * Inicia recarga online (Pix ou cartão 1x): intenção local + cobrança no provedor configurado. Responsável vinculado ativo,
 * idempotente por `key`. NÃO credita: o saldo só muda com a confirmação confiável (F19). Sem provedor = 503.
 */
export const POST = (request: Request) =>
  authenticatedRoute(request, "topup intent create", ({ actor, deps, body }) => createTopupIntent(deps.db, actor, body, { providers: onlineProviders() }));
