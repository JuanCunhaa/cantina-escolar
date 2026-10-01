"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { StudentsDirectory } from "@/modules/students/components/students-directory";

export default function AlunosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "students.search")) {
    return (
      <section>
        <h1>Alunos</h1>
        <p>Seu perfil não pode consultar o cadastro de alunos.</p>
      </section>
    );
  }
  return <StudentsDirectory user={session.user} canManage={can(session, "students.manage")} />;
}
