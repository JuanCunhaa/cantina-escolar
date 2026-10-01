import { authenticatedRoute } from "@/modules/access/command-route";
import { getStudentAccess } from "@/modules/guardians/queries";

export const dynamic = "force-dynamic";

/** Ficha administrativa do aluno: responsáveis vinculados, política e login (administração). */
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) =>
  authenticatedRoute(request, "student access", async ({ actor, deps }) => getStudentAccess(deps.db, actor, (await context.params).id));
