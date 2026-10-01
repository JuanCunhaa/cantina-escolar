"use client";

import { PhotoManager } from "@/modules/catalog/components/photo-manager";
import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";

export default function ProdutosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "catalog.photos.manage")) {
    return (
      <section>
        <h1>Produtos e fotos</h1>
        <p>Seu perfil não pode alterar fotos de produtos.</p>
      </section>
    );
  }
  return <PhotoManager uid={session.user.uid} idToken={() => session.user.getIdToken()} />;
}
