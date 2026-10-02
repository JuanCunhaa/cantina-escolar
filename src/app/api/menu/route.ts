import { authenticatedRoute } from "@/modules/access/command-route";
import { changeMenu } from "@/modules/menu/commands";
import { getMenuWeek } from "@/modules/menu/queries";

export const dynamic = "force-dynamic";

/**
 * Cardápio resolvido no servidor para um aluno na janela de compra (hoje … hoje+7): responsável vinculado, o próprio
 * aluno (sem `studentId`) ou equipe. `date` opcional restringe a um dia da janela.
 */
export const GET = (request: Request) =>
  authenticatedRoute(request, "menu week", ({ actor, deps, url }) =>
    getMenuWeek(deps.db, actor, { studentId: url.searchParams.get("studentId"), date: url.searchParams.get("date") }),
  );

/** Cardápio padrão, exceções por data/turno e suspensão (administração, `menu.manage`). */
export const POST = (request: Request) =>
  authenticatedRoute(request, "menu command", ({ actor, deps, body }) => changeMenu(deps.db, actor, body));
