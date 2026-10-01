"use client";

import { use } from "react";
import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { StudentDetail } from "@/modules/students/components/student-detail";

export default function AlunoFichaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "students.manage")) {
    return (
      <section>
        <h1>Ficha do aluno</h1>
        <p>Somente a administração gerencia fichas, vínculos e convites.</p>
      </section>
    );
  }
  return <StudentDetail user={session.user} studentId={id} />;
}
