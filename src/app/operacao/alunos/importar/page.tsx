"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { ImportStudents } from "@/modules/students/components/import-students";

export default function ImportarAlunosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "students.manage")) {
    return (
      <section>
        <h1>Importar alunos</h1>
        <p>Somente a administração importa alunos.</p>
      </section>
    );
  }
  return <ImportStudents user={session.user} />;
}
