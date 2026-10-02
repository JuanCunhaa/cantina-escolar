"use client";

import { useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import type { Category, PublicProduct } from "../model";

/** Administração: categorias. Arquivar só sem produtos ativos; nada é apagado (pedidos antigos mantêm a referência). */
export function CategoryManager({ user, categories, products }: { user: User; categories: Category[]; products: PublicProduct[] }) {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function run(body: Record<string, unknown>, okText: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const result = await api(user, "POST", "/api/catalog/categories", { key: newKey(), ...body });
    setBusy(false);
    setMessage(result.ok ? { kind: "ok", text: okText } : { kind: "error", text: errorText(result.error) });
    return result.ok;
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await run({ action: "create", name: String(new FormData(form).get("name")).trim() }, "Categoria criada.")) form.reset();
  }

  async function rename(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    if (await run({ action: "rename", id, name: String(new FormData(event.currentTarget).get("name")).trim() }, "Nome alterado.")) setEditing(null);
  }

  const activeCount = (id: string) => products.filter((p) => p.categoryId === id && p.status === "active").length;

  return (
    <section className="product-section" aria-labelledby="categorias" data-testid="categories">
      <h2 id="categorias">Categorias</h2>
      <form onSubmit={(event) => void create(event)} className="inline-form">
        <label htmlFor="new-category">Nova categoria</label>
        <input id="new-category" name="name" type="text" required maxLength={60} autoComplete="off" />
        <button type="submit" disabled={busy}>
          Adicionar categoria
        </button>
      </form>
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"}>
          {message.text}
        </p>
      )}
      {categories.length === 0 ? (
        <p className="muted">Nenhuma categoria ainda. Crie uma antes de cadastrar produtos.</p>
      ) : (
        <ul className="plain-list">
          {categories.map((category) => (
            <li key={category.id} className="row-actions">
              {editing === category.id ? (
                <form onSubmit={(event) => void rename(event, category.id)} className="inline-form">
                  <label htmlFor={`rename-${category.id}`} className="visually-hidden">
                    Novo nome de {category.name}
                  </label>
                  <input id={`rename-${category.id}`} name="name" type="text" required maxLength={60} defaultValue={category.name} autoFocus />
                  <button type="submit" disabled={busy}>
                    Salvar
                  </button>
                  <button type="button" className="secondary" onClick={() => setEditing(null)}>
                    Cancelar
                  </button>
                </form>
              ) : (
                <>
                  <span>
                    {category.name} <span className="muted">· {activeCount(category.id)} ativo(s)</span>{" "}
                    {category.status === "archived" && <span className="tag tag-off">Arquivada</span>}
                  </span>
                  <span>
                    <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(category.id)} aria-label={`Renomear ${category.name}`}>
                      Renomear
                    </button>{" "}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      aria-label={`${category.status === "active" ? "Arquivar" : "Restaurar"} ${category.name}`}
                      onClick={() =>
                        void run(
                          { action: category.status === "active" ? "archive" : "restore", id: category.id },
                          category.status === "active" ? "Categoria arquivada." : "Categoria restaurada.",
                        )
                      }
                    >
                      {category.status === "active" ? "Arquivar" : "Restaurar"}
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
