"use client";

import { useMemo, useState } from "react";
import { formatBRL } from "@/lib/money/format";
import { ProductPhoto } from "@/components/ui/product-photo";
import type { PosProduct } from "../queries";
import { filterProducts, frequentProducts, parseQuickAdd, type CartLine } from "../view";

type Props = {
  products: readonly PosProduct[];
  cart: readonly CartLine[];
  disabled: boolean;
  /** IDs bloqueados para o aluno escolhido (produto ou categoria) e se há autorização registrada para superá-los. */
  blockedIds: ReadonlySet<string>;
  frequent: Record<string, number>;
  onAdd: (productId: string, quantity: number) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
};

const QUICK = [1, 5, 10];

/**
 * Produtos de hoje no balcão: busca por nome (Enter adiciona o primeiro resultado; "10 bala" já traz a quantidade), filtro por
 * categoria, atalhos de frequentes deste dispositivo e botões +1/+5/+10. Preço e unidades livres sempre visíveis; produto
 * bloqueado para o aluno fica desabilitado com o motivo (o servidor revalida na confirmação).
 */
export function ProductPicker({ products, cart, disabled, blockedIds, frequent, onAdd, searchRef }: Props) {
  const [term, setTerm] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const parsed = parseQuickAdd(term);
  const categories = useMemo(() => [...new Map(products.map((p) => [p.categoryId, p.categoryName])).entries()].sort((a, b) => a[1].localeCompare(b[1], "pt-BR")), [products]);
  const shown = filterProducts(products, parsed.term, categoryId);
  const inCart = new Map(cart.map((l) => [l.productId, l.quantity]));
  const favorites = frequentProducts(products, frequent);
  const addable = (p: PosProduct) => !disabled && !blockedIds.has(p.id) && p.availableUnits > (inCart.get(p.id) ?? 0);

  return (
    <section aria-labelledby="pos-products-title" className="pos-products">
      <h2 id="pos-products-title">Produtos de hoje</h2>
      <div className="field">
        <label htmlFor="pos-product-search">Buscar produto (Enter adiciona o primeiro; “10 bala” já leva 10)</label>
        <input
          id="pos-product-search"
          ref={searchRef}
          type="search"
          autoComplete="off"
          value={term}
          disabled={disabled}
          data-testid="pos-product-search"
          onChange={(e) => {
            setTerm(e.target.value);
            setNotice(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const first = shown.find(addable);
            if (!first) return;
            const room = Math.max(1, first.availableUnits - (inCart.get(first.id) ?? 0));
            const quantity = Math.min(parsed.quantity, room);
            onAdd(first.id, quantity);
            // Nunca reduzir em silêncio: o operador precisa saber que o pedido foi maior que o estoque livre.
            setNotice(quantity < parsed.quantity ? `Só ${quantity} de ${first.name} estavam livres: foram adicionadas ${quantity}, não ${parsed.quantity}. Confira o carrinho.` : null);
            setTerm("");
          }}
        />
      </div>

      {notice && (
        <p role="alert" className="notice notice-error" data-testid="pos-clamp-notice">
          {notice}
        </p>
      )}

      {favorites.length > 0 && (
        <div className="pos-shortcuts" role="group" aria-label="Produtos frequentes neste dispositivo">
          <span className="muted">Frequentes:</span>
          {favorites.map((p) => (
            <button key={p.id} type="button" className="secondary" disabled={!addable(p)} onClick={() => onAdd(p.id, 1)} data-testid="pos-frequent">
              {p.name}
            </button>
          ))}
        </div>
      )}

      {categories.length > 1 && (
        <div className="pos-shortcuts" role="group" aria-label="Filtrar por categoria">
          <button type="button" className="secondary" aria-pressed={categoryId === ""} onClick={() => setCategoryId("")}>
            Todas
          </button>
          {categories.map(([id, name]) => (
            <button key={id} type="button" className="secondary" aria-pressed={categoryId === id} onClick={() => setCategoryId(id)}>
              {name || "Sem categoria"}
            </button>
          ))}
        </div>
      )}

      {products.length === 0 && <p className="muted">Nenhum produto do balcão no cardápio de hoje para este turno.</p>}
      {products.length > 0 && shown.length === 0 && <p className="muted">Nenhum produto encontrado.</p>}
      <ul className="product-list pos-product-list">
        {shown.map((p) => {
          const blocked = blockedIds.has(p.id);
          const soldOut = p.availableUnits <= 0;
          return (
            <li key={p.id} className="product-item pos-product" data-unavailable={blocked || soldOut} data-testid="pos-product">
              <div className="photo pos-photo">
                <ProductPhoto productId={p.id} photoPath={p.photoPath} name={p.name} />
              </div>
              <div className="product-body">
                <span className="product-name">{p.name}</span>
                <span className="product-meta">
                  <span className="product-price">{formatBRL(p.priceCents)}</span>
                  <span className={soldOut ? "tag tag-off" : "tag"}>{soldOut ? "Sem estoque livre" : `${p.availableUnits} livre${p.availableUnits === 1 ? "" : "s"}`}</span>
                  {p.mode === "planned" && <span className="tag">Planejado</span>}
                  {blocked && <span className="tag tag-off">Bloqueado pelo responsável</span>}
                  {(inCart.get(p.id) ?? 0) > 0 && <span className="tag">No carrinho: {inCart.get(p.id)}</span>}
                </span>
                <span className="day-actions">
                  {QUICK.map((q) => (
                    <button key={q} type="button" className="secondary" disabled={!addable(p) || (inCart.get(p.id) ?? 0) + q > p.availableUnits} onClick={() => onAdd(p.id, q)} aria-label={`Adicionar ${q} ${p.name}`} data-testid={`pos-add-${q}`}>
                      +{q}
                    </button>
                  ))}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
