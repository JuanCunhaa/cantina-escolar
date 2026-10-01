import { authenticatedRoute } from "@/modules/access/command-route";
import { changeSchoolUnit } from "@/modules/school/commands";

export const dynamic = "force-dynamic";

/** Turmas e turnos (administração). */
export const POST = (request: Request) =>
  authenticatedRoute(request, "school command", ({ actor, deps, body }) => changeSchoolUnit(deps.db, actor, body));
