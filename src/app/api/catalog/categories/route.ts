import { authenticatedRoute } from "@/modules/access/command-route";
import { changeCategory } from "@/modules/catalog/commands";

export const dynamic = "force-dynamic";

/** Categorias de produto (administração, `catalog.manage`). */
export const POST = (request: Request) =>
  authenticatedRoute(request, "catalog category command", ({ actor, deps, body }) => changeCategory(deps.db, actor, body));
