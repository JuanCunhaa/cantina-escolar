"use client";

import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";
import { SchoolCalendar } from "@/modules/school/components/school-calendar";

export default function CalendarioPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "students.manage")) {
    return (
      <section>
        <h1>Calendário e horários</h1>
        <p>Somente a administração altera o calendário e os horários.</p>
      </section>
    );
  }
  return <SchoolCalendar user={session.user} />;
}
