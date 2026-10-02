"use client";

import { useMemo, useState } from "react";
import { ProductPhoto } from "@/components/ui/product-photo";
import { formatBRL } from "@/lib/money/format";
import { useUnits } from "@/modules/school/use-units";
import type { Category, PublicProduct } from "../model";
import { useCatalog } from "../use-catalog";

function groupByCategory(products: PublicProduct[], categories: Category[]): [string, string, PublicProduct[]][] {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const groups = new Map<string, PublicProduct[]>();
  for (const product of products) groups.set(product.categoryId, [...(groups.get(product.categoryId) ?? []), product]);
  return [...groups.entries()]
    .map(([id, items]): [string, string, PublicProduct[]] => [id, names.get(id) ?? "Outros", items])
    .sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
}

/**
 * Catálogo para a família: só o cadastro público (nome, descrição, preço, canais, turnos, foto) de produtos ativos.
 * O cardápio por data/turno chega na F07 e a compra com a carteira na F11; a quantidade aqui é só uma prévia e o
 * preço final é sempre recalculado pelo servidor no checkout.
 */
export function MenuView({ uid }: { uid: string }) {
  const { status, products, categories, fromCache } = useCatalog(uid, { onlyActive: true });
  const units = useUnits();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const groups = useMemo(() => groupByCategory(products, categories), [products, categories]);
  const activeShifts = units.shifts.filter((s) => s.status === "active");
  const shiftName = new Map(units.shifts.map((s) => [s.id, s.name]));

  const change = (id: string, delta: number) =>
    setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(20, (current[id] ?? 0) + delta)) }));
  const selected = products.filter((p) => p.channels.includes("advance") && (quantities[p.id] ?? 0) > 0);
  const totalCents = selected.reduce((sum, p) => sum + p.priceCents * (quantities[p.id] ?? 0), 0);
  const itemCount = selected.reduce((sum, p) => sum + (quantities[p.id] ?? 0), 0);

  /** Indicação pequena de turno quando o produto não é oferecido em todos os turnos ativos. */
  const shiftTag = (product: PublicProduct): string | null => {
    if (activeShifts.length === 0 || activeShifts.every((s) => product.shiftIds.includes(s.id))) return null;
    const names = product.shiftIds.map((id) => shiftName.get(id)).filter(Boolean);
    return names.length > 0 ? `Só ${names.join(", ")}` : null;
  };

  return (
    <div className="menu-layout">
      <div>
        <h1>Cardápio</h1>
        <p className="muted">Produtos da cantina. A escolha por data e turno e o pagamento com a carteira chegam nas próximas etapas.</p>
        {status === "loading" && <p role="status">Carregando o cardápio…</p>}
        {status === "error" && (
          <p role="alert" className="notice notice-error">
            Não foi possível carregar o cardápio. Verifique a conexão e tente novamente.
          </p>
        )}
        {fromCache && status === "ready" && <p role="status">Sem conexão: exibindo dados salvos, que podem estar desatualizados.</p>}
        {status === "ready" && products.length === 0 && <p>Nenhum produto disponível no momento.</p>}
        {groups.map(([categoryId, categoryName, items]) => (
          <section key={categoryId} className="product-section" aria-labelledby={`cat-${categoryId}`}>
            <h2 id={`cat-${categoryId}`}>{categoryName}</h2>
            <ul className="product-list">
              {items.map((product) => {
                const quantity = quantities[product.id] ?? 0;
                const online = product.channels.includes("advance");
                const tag = shiftTag(product);
                return (
                  <li key={product.id} className="product-item" data-testid="product" data-unavailable={!online}>
                    <ProductPhoto productId={product.id} photoPath={product.photoPath} name={product.name} />
                    <div className="product-body">
                      <span className="product-name">{product.name}</span>
                      {product.description && <span className="muted">{product.description}</span>}
                      <div className="product-meta">
                        <span className="product-price">{formatBRL(product.priceCents)}</span>
                        {tag && <span className="tag">{tag}</span>}
                        {!online && <span className="tag tag-off">Só no balcão</span>}
                        {online && (
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
