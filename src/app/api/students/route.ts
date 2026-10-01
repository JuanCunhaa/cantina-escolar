import { authenticatedRoute } from "@/modules/access/command-route";
import { runStudentCommand } from "@/modules/students/commands";
import { listStudents } from "@/modules/students/queries";

export const dynamic = "force-dynamic";

/** Diretório para a equipe (students.search): nome com turma/turno. */
export const GET = (request: Request) =>
  authenticatedRoute(request, "students list", ({ actor, deps, url }) =>
    listStudents(deps.db, actor, Object.fromEntries(url.searchParams)),
  );

/** Cadastro e alteração/arquivamento de alunos (administração). */
export const POST = (request: Request) =>
  authenticatedRoute(request, "student command", ({ actor, deps, body }) => runStudentCommand(deps.db, actor, body));
