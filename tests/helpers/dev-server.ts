import type { APIRequestContext } from "@playwright/test";

/**
 * Compila no servidor de desenvolvimento (`next dev`) as rotas que um spec usa ANTES de abrir páginas. Compilar no meio do
 * fluxo muda o hash da compilação; quando outra página abre ou recarrega, o Next 16 publica SYNC a todos os clientes e o
 * cliente com hash antigo recarrega a página inteira (next/dist/server/dev/hot-middleware.js `onHMR` +
 * next/dist/client/dev/hot-reloader/app/web-socket.js), perdendo o estado da tela. Também evita `net::ERR_ABORTED` quando a
 * compilação acontece durante um `page.goto`. As chamadas vão juntas (o Next agrupa as entradas pedidas numa compilação);
 * sem token as APIs respondem 401/405, sem efeito. Contra o deployment publicado não há compilação: só respostas rápidas.
 */
export async function warmRoutes(request: APIRequestContext, routes: { post?: readonly string[]; get?: readonly string[] }): Promise<void> {
  await Promise.all([...(routes.post ?? []).map((url) => request.post(url, { data: {} })), ...(routes.get ?? []).map((url) => request.get(url))]);
}
