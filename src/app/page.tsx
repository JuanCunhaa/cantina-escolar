import Link from "next/link";
import { FoundationProbe } from "@/components/layout/foundation-probe";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 480, margin: "2rem auto", padding: "0 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Cantina Escolar</h1>
      <p>
        Áreas de demonstração: <Link href="/portal">portal da família</Link> · <Link href="/operacao">operação</Link>
      </p>
      <p>Prova técnica de fundação (F01): login, listener privado e comando de servidor.</p>
      <FoundationProbe />
    </main>
  );
}
