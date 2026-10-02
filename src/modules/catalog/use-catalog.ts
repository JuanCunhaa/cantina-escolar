"use client";

import { useEffect, useState } from "react";
import { collection, getDocs, limit, onSnapshot, orderBy, query, where, type Query } from "firebase/firestore";
import { getFirebaseClient } from "@/lib/firebase/client";
import { parseProduct, type Category, type PublicProduct } from "./model";

export type CatalogState = {
  status: "loading" | "ready" | "error";
  products: PublicProduct[];
  categories: Category[];
  fromCache: boolean;
};

type Keyed = { uid: string } & CatalogState;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "pt-BR");

/**
 * Catálogo ao vivo (categorias + cadastro público de produtos), ligado ao uid e desligado no cleanup (logout/troca
 * de conta). `onlyActive` restringe a consulta a produtos ativos (portal). Dado de cache é sinalizado e nunca
 * confirma compra: preço e disponibilidade finais são do servidor no checkout.
 */
export function useCatalog(uid: string, options: { onlyActive: boolean }): CatalogState {
  const [state, setState] = useState<Keyed | null>(null);
  const { onlyActive } = options;

  useEffect(() => {
    const { db } = getFirebaseClient();
    let products: PublicProduct[] | null = null;
    let categories: Category[] | null = null;
    let productsCache = false;
    let categoriesCache = false;
    const publish = () => {
      if (products && categories) setState({ uid, status: "ready", products, categories, fromCache: productsCache || categoriesCache });
    };
    const fail = () => setState({ uid, status: "error", products: [], categories: [], fromCache: false });
    const productQuery: Query = onlyActive ? query(collection(db, "products"), where("status", "==", "active")) : collection(db, "products");
    const stopProducts = onSnapshot(
      productQuery,
      { includeMetadataChanges: true },
      (snap) => {
        products = snap.docs.flatMap((d) => parseProduct(d.id, d.data()) ?? []).sort(byName);
        productsCache = snap.metadata.fromCache;
        publish();
      },
      fail,
    );
    const stopCategories = onSnapshot(
      collection(db, "categories"),
      { includeMetadataChanges: true },
      (snap) => {
        categories = snap.docs
          .map((d) => ({ id: d.id, name: String(d.data().name ?? ""), status: d.data().status === "archived" ? ("archived" as const) : ("active" as const) }))
          .sort(byName);
        categoriesCache = snap.metadata.fromCache;
        publish();
      },
      fail,
    );
    return () => {
      stopProducts();
      stopCategories();
    };
  }, [uid, onlyActive]);

  return state?.uid === uid ? state : { status: "loading", products: [], categories: [], fromCache: false };
}

export type ProductPrivate = { defaultSupplier: string; internalNotes: string };

/** Dados internos (fornecedor/observações) — só a administração lê (Rules); outros papéis nem abrem o listener. */
export function useProductPrivate(enabled: boolean): Map<string, ProductPrivate> {
  const [data, setData] = useState<Map<string, ProductPrivate>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    return onSnapshot(
      collection(getFirebaseClient().db, "productPrivate"),
      (snap) =>
        setData(
          new Map(
            snap.docs.map((d) => [d.id, { defaultSupplier: String(d.data().defaultSupplier ?? ""), internalNotes: String(d.data().internalNotes ?? "") }]),
          ),
        ),
      () => setData(new Map()),
    );
  }, [enabled]);
  return enabled ? data : new Map();
}

export type PriceEntry = { priceVersion: number; priceCents: number; previousPriceCents: number | null; reason: string; effectiveAt: Date | null };

/** Histórico de preço sob demanda (cantina/administração), do mais recente ao mais antigo; limitado. */
export async function loadPriceHistory(productId: string): Promise<PriceEntry[]> {
  const snap = await getDocs(query(collection(getFirebaseClient().db, `products/${productId}/priceHistory`), orderBy("priceVersion", "desc"), limit(50)));
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      priceVersion: Number(data.priceVersion),
      priceCents: Number(data.priceCents),
      previousPriceCents: typeof data.previousPriceCents === "number" ? data.previousPriceCents : null,
      reason: String(data.reason ?? ""),
      effectiveAt: typeof data.effectiveAt?.toDate === "function" ? (data.effectiveAt.toDate() as Date) : null,
    };
  });
}
