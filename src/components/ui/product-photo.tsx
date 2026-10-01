"use client";

import { useEffect, useState } from "react";
import { getDownloadURL, ref } from "firebase/storage";
import { getFirebaseClient } from "@/lib/firebase/client";

type Resolved = { path: string; url: string | null };

/** Foto de produto em proporção fixa 4:3, com alt text, carregamento tardio e fallback discreto (sem foto ou erro). */
export function ProductPhoto({ photoPath, name }: { photoPath: string | null; name: string }) {
  // Resultado guardado junto do caminho: resultado de outro caminho é ignorado (sem setState síncrono no efeito).
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    if (!photoPath) return;
    let active = true;
    getDownloadURL(ref(getFirebaseClient().storage, photoPath)).then(
      (url) => active && setResolved({ path: photoPath, url }),
      () => active && setResolved({ path: photoPath, url: null }),
    );
    return () => {
      active = false;
    };
  }, [photoPath]);

  const url = photoPath && resolved?.path === photoPath ? resolved.url : null;
  if (url) {
    return (
      <div className="photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- URL do Storage com token; sem otimizador remoto configurado. */}
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
