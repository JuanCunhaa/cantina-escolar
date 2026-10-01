"use client";

import { PhotoManager } from "@/modules/catalog/components/photo-manager";
import { canManagePhotos } from "@/modules/access/roles";
import { useSession } from "@/modules/access/use-session";

export default function ProdutosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!canManagePhotos(session.role)) {
    return (
      <section>
        <h1>Produtos e fotos</h1>
        <p>Seu perfil não pode alterar fotos de produtos.</p>
      </section>
    );
  }
  return <PhotoManager uid={session.user.uid} idToken={() => session.user.getIdToken()} />;
}
