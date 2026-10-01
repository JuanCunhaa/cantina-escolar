"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, type DocumentData } from "firebase/firestore";
import { getFirebaseClient } from "@/lib/firebase/client";

export type DemoProduct = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  category: string;
  available: boolean;
  special: string | null;
  photoPath: string | null;
};

export type ProductsState = { status: "loading" | "ready" | "error"; products: DemoProduct[]; fromCache: boolean };

type Keyed = { uid: string } & ProductsState;

function toProduct(id: string, data: DocumentData): DemoProduct {
  return {
    id,
    name: String(data.name ?? ""),
    description: String(data.description ?? ""),
    priceCents: Number(data.priceCents ?? 0),
    category: String(data.category ?? "Outros"),
    available: data.available === true,
    special: typeof data.special === "string" ? data.special : null,
    photoPath: typeof data.photoPath === "string" ? data.photoPath : null,
  };
}

/**
 * Listener do catálogo de demonstração, ligado ao uid e desligado no cleanup (logout/troca de conta).
 * Dado de cache é sinalizado e nunca confirma compra. Estado de outro uid é tratado como "carregando".
 */
export function useDemoProducts(uid: string): ProductsState {
  const [state, setState] = useState<Keyed | null>(null);

  useEffect(() => {
    return onSnapshot(
      collection(getFirebaseClient().db, "demoProducts"),
      { includeMetadataChanges: true },
      (snap) =>
        setState({
          uid,
          status: "ready",
          products: snap.docs.map((d) => toProduct(d.id, d.data())).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
          fromCache: snap.metadata.fromCache,
        }),
      () => setState({ uid, status: "error", products: [], fromCache: false }),
    );
  }, [uid]);

  return state?.uid === uid ? state : { status: "loading", products: [], fromCache: false };
}
