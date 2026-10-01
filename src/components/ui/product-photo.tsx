"use client";

import { useEffect, useState } from "react";
import { getFirebaseClient } from "@/lib/firebase/client";

type Resolved = { path: string; url: string | null };

/**
 * Foto de produto em proporção fixa 4:3, com alt text, carregamento tardio e fallback discreto (sem foto ou erro).
 * O bucket é privado: a imagem vem de GET /api/catalog/photo com o ID token atual e vira um blob local (um <img src>
 * não envia Authorization). O ETag da chave imutável permite revalidar sem baixar de novo.
 */
export function ProductPhoto({ productId, photoPath, name }: { productId: string; photoPath: string | null; name: string }) {
  // Resultado guardado junto do caminho: resultado de outro caminho é ignorado (sem setState síncrono no efeito).
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    if (!photoPath) return;
    let active = true;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const token = await getFirebaseClient().auth.currentUser?.getIdToken();
        if (!token) throw new Error("sem sessão");
        const response = await fetch(`/api/catalog/photo?productId=${encodeURIComponent(productId)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error("foto indisponível");
        objectUrl = URL.createObjectURL(await response.blob());
        if (active) setResolved({ path: photoPath, url: objectUrl });
        else URL.revokeObjectURL(objectUrl);
      } catch {
        if (active) setResolved({ path: photoPath, url: null });
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [productId, photoPath]);

  const url = photoPath && resolved?.path === photoPath ? resolved.url : null;
  if (url) {
    return (
      <div className="photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- blob local de resposta autenticada; sem otimizador remoto. */}
        <img
          src={url}
          alt={name}
          loading="lazy"
          decoding="async"
          width={240}
          height={180}
          onError={() => setResolved({ path: photoPath ?? "", url: null })}
        />
      </div>
    );
  }
  return (
    <div className="photo" role="img" aria-label={`${name} — sem foto disponível`} data-fallback="true">
      <span aria-hidden="true">Sem foto</span>
    </div>
  );
}
