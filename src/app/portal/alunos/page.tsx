"use client";

import { useSession } from "@/modules/access/use-session";
import { FamilyStudents } from "@/modules/guardians/components/family-students";

export default function PortalAlunosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (session.role !== "guardian") {
    return (
      <section>
        <h1>Alunos vinculados</h1>
        <p>Esta tela é dos responsáveis. O aluno com login consulta apenas o próprio cadastro.</p>
      </section>
    );
  }
  return <FamilyStudents user={session.user} />;
}
