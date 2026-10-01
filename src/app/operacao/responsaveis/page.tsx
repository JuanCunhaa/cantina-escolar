"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { GuardiansList } from "@/modules/guardians/components/guardians-list";

export default function ResponsaveisPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "students.manage")) {
    return (
      <section>
        <h1>Responsáveis</h1>
        <p>Somente a administração consulta o cadastro de responsáveis.</p>
      </section>
    );
  }
  return <GuardiansList user={session.user} />;
}
