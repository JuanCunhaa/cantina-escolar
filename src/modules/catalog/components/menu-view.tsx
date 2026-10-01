"use client";

import { useMemo, useState } from "react";
import { ProductPhoto } from "@/components/ui/product-photo";
import { formatBRL } from "@/lib/money/format";
import { useDemoProducts, type DemoProduct } from "../use-demo-products";

function groupByCategory(products: DemoProduct[]): [string, DemoProduct[]][] {
  const groups = new Map<string, DemoProduct[]>();
  for (const product of products) groups.set(product.category, [...(groups.get(product.category) ?? []), product]);
  return [...groups.entries()];
}

/** Cardápio de demonstração (dados fictícios persistidos). Prévia de quantidade: a compra real chega com o checkout (F11). */
export function MenuView({ uid }: { uid: string }) {
  const { status, products, fromCache } = useDemoProducts(uid);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const groups = useMemo(() => groupByCategory(products), [products]);

  const change = (id: string, delta: number) =>
    setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(20, (current[id] ?? 0) + delta)) }));
  const selected = products.filter((p) => (quantities[p.id] ?? 0) > 0);
  const totalCents = selected.reduce((sum, p) => sum + p.priceCents * (quantities[p.id] ?? 0), 0);
  const itemCount = selected.reduce((sum, p) => sum + (quantities[p.id] ?? 0), 0);

  return (
    <div className="menu-layout">
      <div>
        <h1>Cardápio</h1>
        <p className="muted">Exemplo fictício para demonstração — produtos e preços não são reais.</p>
        {status === "loading" && <p role="status">Carregando o cardápio…</p>}
        {status === "error" && (
          <p role="alert" className="notice notice-error">
            Não foi possível carregar o cardápio. Verifique a conexão e tente novamente.
          </p>
        )}
        {fromCache && status === "ready" && <p role="status">Sem conexão: exibindo dados salvos, que podem estar desatualizados.</p>}
        {status === "ready" && products.length === 0 && <p>Nenhum produto cadastrado ainda.</p>}
        {groups.map(([category, items]) => (
          <section key={category} className="product-section" aria-labelledby={`cat-${category}`}>
            <h2 id={`cat-${category}`}>{category}</h2>
            <ul className="product-list">
              {items.map((product) => {
                const quantity = quantities[product.id] ?? 0;
                return (
                  <li key={product.id} className="product-item" data-testid="product" data-unavailable={!product.available}>
                    <ProductPhoto productId={product.id} photoPath={product.photoPath} name={product.name} />
                    <div className="product-body">
                      <span className="product-name">{product.name}</span>
                      <span className="muted">{product.description}</span>
                      <div className="product-meta">
                        <span className="product-price">{formatBRL(product.priceCents)}</span>
                        {product.special && <span className="tag">{product.special}</span>}
                        {!product.available && <span className="tag tag-off">Indisponível</span>}
                        {product.available && (
                          <span className="qty" role="group" aria-label={`Quantidade de ${product.name}`}>
                            <button type="button" className="secondary" aria-label={`Diminuir ${product.name}`} disabled={quantity === 0} onClick={() => change(product.id, -1)}>
                              −
                            </button>
                            <output aria-live="polite">{quantity}</output>
                            <button type="button" className="secondary" aria-label={`Aumentar ${product.name}`} onClick={() => change(product.id, 1)}>
                              +
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <aside className="summary" aria-label="Resumo da seleção">
        <p>
          <strong data-testid="summary-total">{formatBRL(totalCents)}</strong>{" "}
          <span className="muted">· {itemCount} {itemCount === 1 ? "item" : "itens"}</span>
        </p>
        <p className="muted">Prévia: o pagamento com a carteira do aluno será habilitado na etapa de checkout.</p>
      </aside>
    </div>
  );
}
