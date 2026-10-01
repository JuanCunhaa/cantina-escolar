"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { SchoolUnits } from "@/modules/school/components/school-units";

export default function EscolaPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "students.manage")) {
    return (
      <section>
        <h1>Turmas e turnos</h1>
        <p>Somente a administração cadastra turmas e turnos.</p>
      </section>
    );
  }
  return <SchoolUnits user={session.user} />;
}
