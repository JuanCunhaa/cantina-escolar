"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { ProductPhoto } from "@/components/ui/product-photo";
import { api, errorText, newKey } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { normalizeName } from "@/modules/students/normalize";
import { useUnits } from "@/modules/school/use-units";
import { CHANNEL_LABEL, MODE_LABEL, parseBRLInput, type PublicProduct } from "../model";
import { loadPriceHistory, useCatalog, useProductPrivate, type PriceEntry } from "../use-catalog";
import { CategoryManager } from "./category-manager";
import { PhotoUpload } from "./photo-upload";
import { ProductForm } from "./product-form";

type StatusFilter = "active" | "inactive" | "all";
type Panel = { kind: "new" } | { kind: "manage"; id: string } | null;

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

/**
 * Operação: catálogo de produtos. Administração cadastra/edita, altera preço (com motivo e histórico), desativa e
 * reativa; cantina consulta e troca fotos. Nada é apagado: produto desativado sai das novas vendas e mantém histórico.
 */
export function ProductCatalog({ user, canManage }: { user: User; canManage: boolean }) {
  const catalog = useCatalog(user.uid, { onlyActive: false });
  const units = useUnits();
  const privateData = useProductPrivate(canManage);
  const [status, setStatus] = useState<StatusFilter>("active");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const categoryName = useMemo(() => new Map(catalog.categories.map((c) => [c.id, c.name])), [catalog.categories]);
  const shiftName = useMemo(() => new Map(units.shifts.map((s) => [s.id, s.name])), [units.shifts]);
  const term = normalizeName(search);
  const rows = catalog.products.filter(
    (p) =>
      (status === "all" || p.status === status) &&
      (!categoryFilter || p.categoryId === categoryFilter) &&
      (!term || normalizeName(p.name).includes(term)),
  );
  const managed = panel?.kind === "manage" ? catalog.products.find((p) => p.id === panel.id) : undefined;

  const done = (text: string) => {
    setNotice(text);
    setPanel(null);
  };

  return (
    <section>
      <h1>Produtos</h1>
      <p className="muted">
        Preços em reais por unidade. Mudança de preço vale para novas vendas; pedidos já pagos guardam o valor da compra.
        {!canManage && " Seu perfil pode consultar e trocar fotos; cadastro e preços são da administração."}
      </p>
      {catalog.status === "loading" && <p role="status">Carregando produtos…</p>}
      {catalog.status === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar os produtos.
        </p>
      )}
      {catalog.fromCache && catalog.status === "ready" && <p role="status">Sem conexão: exibindo dados salvos, que podem estar desatualizados.</p>}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}

      {canManage && panel?.kind !== "new" && (
        <p>
          <button type="button" onClick={() => { setNotice(null); setPanel({ kind: "new" }); }}>
            Novo produto
          </button>
        </p>
      )}
      {canManage && panel?.kind === "new" && (
        <ProductForm
          user={user}
          categories={catalog.categories}
          shifts={units.shifts}
          onDone={() => done("Produto cadastrado.")}
          onCancel={() => setPanel(null)}
        />
      )}

      <div className="toolbar" role="search" aria-label="Filtrar produtos">
        <div className="field">
          <label htmlFor="product-search">Buscar por nome</label>
          <input id="product-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="product-category-filter">Categoria</label>
          <select id="product-category-filter" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">Todas</option>
            {catalog.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="product-status-filter">Situação</label>
          <select id="product-status-filter" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="active">Ativos</option>
            <option value="inactive">Desativados</option>
            <option value="all">Todos</option>
          </select>
        </div>
      </div>

      {catalog.status === "ready" && rows.length === 0 && <p className="muted">Nenhum produto com estes filtros.</p>}
      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table catalog-table">
            <caption className="muted">
              {rows.length} produto(s) · canais, turnos e modo de disponibilidade
            </caption>
            <thead>
              <tr>
                <th scope="col">Foto</th>
                <th scope="col">Produto</th>
                <th scope="col">Preço</th>
                <th scope="col">Canais e turnos</th>
                <th scope="col">Modo</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((product) => (
                <tr key={product.id} data-testid="photo-row" data-status={product.status}>
                  <td>
                    <ProductPhoto productId={product.id} photoPath={product.photoPath} name={product.name} />
                  </td>
                  <td>
                    <strong>{product.name}</strong>
                    <br />
                    <span className="muted">{categoryName.get(product.categoryId) ?? "Sem categoria"}</span>{" "}
                    {product.status === "inactive" && <span className="tag tag-off">Desativado</span>}
                  </td>
                  <td data-testid="product-price">{formatBRL(product.priceCents)}</td>
                  <td>
                    {product.channels.map((c) => CHANNEL_LABEL[c]).join(" e ")}
                    <br />
                    <span className="muted">{product.shiftIds.map((s) => shiftName.get(s) ?? "Turno removido").join(", ")}</span>
                  </td>
                  <td>{MODE_LABEL[product.availabilityMode]}</td>
                  <td>
                    <PhotoUpload user={user} productId={product.id} productName={product.name} />
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`${canManage ? "Gerenciar" : "Histórico de preço de"} ${product.name}`}
                      aria-expanded={panel?.kind === "manage" && panel.id === product.id}
                      onClick={() => { setNotice(null); setPanel(panel?.kind === "manage" && panel.id === product.id ? null : { kind: "manage", id: product.id }); }}
                    >
                      {canManage ? "Gerenciar" : "Histórico de preço"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {managed && (
        <ManagePanel
          key={`${managed.id}-${managed.version}`}
          user={user}
          product={managed}
          canManage={canManage}
          onDone={done}
          onClose={() => setPanel(null)}
          form={
            canManage ? (
              <ProductForm
                key={`${managed.id}-${managed.version}-${privateData.has(managed.id)}`}
                user={user}
                categories={catalog.categories}
                shifts={units.shifts}
                product={managed}
                privateData={privateData.get(managed.id)}
                onDone={() => done("Produto atualizado.")}
                onCancel={() => setPanel(null)}
              />
            ) : null
          }
        />
      )}

      {canManage && <CategoryManager user={user} categories={catalog.categories} products={catalog.products} />}
    </section>
  );
}

function ManagePanel({
  user,
  product,
  canManage,
  form,
  onDone,
  onClose,
}: {
  user: User;
  product: PublicProduct;
  canManage: boolean;
  form: ReactNode;
  onDone: (text: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PriceEntry[] | "error" | null>(null);

  useEffect(() => {
    let active = true;
    loadPriceHistory(product.id).then(
      (entries) => active && setHistory(entries),
      () => active && setHistory("error"),
    );
    return () => {
      active = false;
    };
  }, [product.id, product.priceVersion]);

  async function command(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    setError(null);
    const result = await api(user, "POST", "/api/catalog/products", { key: newKey(), id: product.id, ...body });
    setBusy(false);
    if (result.ok) onDone(okText);
    else setError(errorText(result.error));
  }

  function changePrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const priceCents = parseBRLInput(String(data.get("price")));
    if (priceCents === null) return setError("Informe um preço válido, por exemplo 9,00 (até R$ 500,00).");
    void command({ action: "setPrice", priceCents, expectedPriceVersion: product.priceVersion, reason: String(data.get("reason")).trim() }, "Preço alterado para novas vendas.");
  }

  function toggle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    void command(
      product.status === "active" ? { action: "deactivate", reason } : { action: "reactivate" },
      product.status === "active" ? "Produto desativado para novas vendas. O histórico foi mantido." : "Produto reativado.",
    );
  }

  return (
    <section className="product-section manage-panel" aria-labelledby="manage-title">
      <h2 id="manage-title">{product.name}</h2>
      <p>
        <button type="button" className="secondary" onClick={onClose}>
          Fechar
        </button>
      </p>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      {form}
      {canManage && (
        <form onSubmit={changePrice} className="form-grid" aria-labelledby="price-title">
          <h2 id="price-title">Alterar preço</h2>
          <p className="muted field-wide">
            Atual: <strong>{formatBRL(product.priceCents)}</strong>. Vale para novas vendas; pedidos pagos mantêm o preço da compra.
          </p>
          <div className="field">
            <label htmlFor="new-price">Novo preço (R$)</label>
            <input id="new-price" name="price" type="text" inputMode="decimal" required autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="price-reason">Motivo</label>
            <input id="price-reason" name="reason" type="text" required maxLength={200} autoComplete="off" />
          </div>
          <div className="field">
            <button type="submit" disabled={busy}>
              Salvar preço
            </button>
          </div>
        </form>
      )}
      <h3>Histórico de preço</h3>
      {history === null && <p role="status">Carregando histórico…</p>}
      {history === "error" && <p className="notice notice-error">Não foi possível carregar o histórico.</p>}
      {Array.isArray(history) && (
        <ol className="plain-list" data-testid="price-history">
          {history.map((entry) => (
            <li key={entry.priceVersion}>
              <strong>{formatBRL(entry.priceCents)}</strong>
              {entry.previousPriceCents !== null && <span className="muted"> (antes {formatBRL(entry.previousPriceCents)})</span>} · {entry.reason}
              <span className="muted"> · {entry.effectiveAt ? dateTime.format(entry.effectiveAt) : "agora"}</span>
            </li>
          ))}
        </ol>
      )}
      {canManage && (
        <form onSubmit={toggle} className="form-grid" aria-labelledby="status-title">
          <h2 id="status-title">{product.status === "active" ? "Desativar" : "Reativar"}</h2>
          <p className="muted field-wide">
            {product.status === "active"
              ? "Desativar tira o produto das novas vendas. Nada é apagado: pedidos e histórico continuam legíveis."
              : "Reativar devolve o produto às novas vendas com o preço atual."}
          </p>
          {product.status === "active" && (
            <div className="field">
              <label htmlFor="deactivate-reason">Motivo da desativação</label>
              <input id="deactivate-reason" name="reason" type="text" required maxLength={200} autoComplete="off" />
            </div>
          )}
          <div className="field">
            <button type="submit" className={product.status === "active" ? "danger" : undefined} disabled={busy}>
              {product.status === "active" ? "Desativar produto" : "Reativar produto"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
