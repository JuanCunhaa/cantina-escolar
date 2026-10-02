"use client";

import { ProductCatalog } from "@/modules/catalog/components/product-catalog";
import { can } from "@/modules/access/permissions";
import { useSession } from "@/modules/access/use-session";

export default function ProdutosPage() {
  const session = useSession();
  if (session.status !== "signedIn") return null;
  if (!can(session, "catalog.photos.manage") && !can(session, "catalog.manage")) {
    return (
      <section>
        <h1>Produtos</h1>
        <p>Seu perfil não pode gerenciar produtos.</p>
      </section>
    );
  }
  return <ProductCatalog user={session.user} canManage={can(session, "catalog.manage")} />;
}
