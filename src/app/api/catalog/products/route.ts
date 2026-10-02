import { authenticatedRoute } from "@/modules/access/command-route";
import { changeProduct } from "@/modules/catalog/commands";

export const dynamic = "force-dynamic";

/** Produtos (administração, `catalog.manage`): criar, editar, alterar preço com histórico, desativar/reativar. */
export const POST = (request: Request) =>
  authenticatedRoute(request, "catalog product command", ({ actor, deps, body }) => changeProduct(deps.db, actor, body));
