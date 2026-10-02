"use client";

import { useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey } from "@/lib/api-client";
import type { Unit } from "@/modules/school/use-units";
import { AVAILABILITY_MODES, CHANNEL_LABEL, CHANNELS, MODE_LABEL, parseBRLInput, type Category, type PublicProduct } from "../model";
import type { ProductPrivate } from "../use-catalog";

type Props = {
  user: User;
  categories: Category[];
  shifts: Unit[];
  /** Ausente = novo produto. */
  product?: PublicProduct;
  privateData?: ProductPrivate;
  onDone: (id: string) => void;
  onCancel: () => void;
};

/**
 * Cadastro/edição do produto (administração). Preço só no cadastro: depois muda pelo comando próprio, com motivo e
 * histórico. Fornecedor/observações são internos e vão para documento separado, invisível às famílias.
 */
export function ProductForm({ user, categories, shifts, product, privateData, onDone, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(product);
  const prefix = product ? `edit-${product.id}` : "new-product";
  const selectableCategories = categories.filter((c) => c.status === "active" || c.id === product?.categoryId);
  const selectableShifts = shifts.filter((s) => s.status === "active" || product?.shiftIds.includes(s.id));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const channels = data.getAll("channels").map(String);
    const shiftIds = data.getAll("shiftIds").map(String);
    if (channels.length === 0) return setError("Escolha ao menos um canal de venda.");
    if (shiftIds.length === 0) return setError("Escolha ao menos um turno.");
    const body: Record<string, unknown> = {
      key: newKey(),
      name: String(data.get("name")).trim(),
      description: String(data.get("description") ?? "").trim(),
      categoryId: String(data.get("categoryId")),
      channels,
      shiftIds,
      availabilityMode: String(data.get("availabilityMode")),
      defaultSupplier: String(data.get("defaultSupplier") ?? "").trim(),
      internalNotes: String(data.get("internalNotes") ?? "").trim(),
    };
    if (product) {
      Object.assign(body, { action: "update", id: product.id, expectedVersion: product.version });
    } else {
      const priceCents = parseBRLInput(String(data.get("price")));
      if (priceCents === null) return setError("Informe um preço válido, por exemplo 8,50 (até R$ 500,00).");
      Object.assign(body, { action: "create", priceCents });
    }
    setBusy(true);
    setError(null);
    const result = await api<{ id: string }>(user, "POST", "/api/catalog/products", body);
    setBusy(false);
    if (result.ok) onDone(result.data.id);
    else setError(errorText(result.error));
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="form-grid" aria-labelledby={`${prefix}-title`}>
      <h2 id={`${prefix}-title`}>{product ? `Editar ${product.name}` : "Novo produto"}</h2>
      <div className="field">
        <label htmlFor={`${prefix}-name`}>Nome</label>
        <input id={`${prefix}-name`} name="name" type="text" required maxLength={80} defaultValue={product?.name} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-category`}>Categoria</label>
        <select id={`${prefix}-category`} name="categoryId" required defaultValue={product?.categoryId ?? ""}>
          <option value="" disabled>
            Escolha…
          </option>
          {selectableCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.status === "archived" ? " (arquivada)" : ""}
            </option>
          ))}
        </select>
      </div>
      {!editing && (
        <div className="field">
          <label htmlFor={`${prefix}-price`}>Preço (R$)</label>
          <input id={`${prefix}-price`} name="price" type="text" inputMode="decimal" required placeholder="8,50" autoComplete="off" />
        </div>
      )}
      <div className="field field-wide">
        <label htmlFor={`${prefix}-description`}>Descrição curta</label>
        <textarea id={`${prefix}-description`} name="description" rows={2} maxLength={280} defaultValue={product?.description} />
      </div>
      <fieldset className="field choice-group">
        <legend>Canais de venda</legend>
        {CHANNELS.map((c) => (
          <label key={c}>
            <input type="checkbox" name="channels" value={c} defaultChecked={product ? product.channels.includes(c) : true} /> {CHANNEL_LABEL[c]}
          </label>
        ))}
      </fieldset>
      <fieldset className="field choice-group">
        <legend>Turnos</legend>
        {selectableShifts.length === 0 && <span className="muted">Nenhum turno ativo. Cadastre em Turmas e turnos.</span>}
        {selectableShifts.map((s) => (
          <label key={s.id}>
            <input type="checkbox" name="shiftIds" value={s.id} defaultChecked={product ? product.shiftIds.includes(s.id) : true} /> {s.name}
          </label>
        ))}
      </fieldset>
      <fieldset className="field choice-group">
        <legend>Modo de disponibilidade</legend>
        {AVAILABILITY_MODES.map((m) => (
          <label key={m}>
            <input type="radio" name="availabilityMode" value={m} required defaultChecked={(product?.availabilityMode ?? "physical") === m} /> {MODE_LABEL[m]}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={`${prefix}-supplier`}>Fornecedor padrão (interno)</label>
        <input id={`${prefix}-supplier`} name="defaultSupplier" type="text" maxLength={80} defaultValue={privateData?.defaultSupplier} autoComplete="off" />
      </div>
      <div className="field field-wide">
        <label htmlFor={`${prefix}-notes`}>Observações internas</label>
        <textarea id={`${prefix}-notes`} name="internalNotes" rows={2} maxLength={500} defaultValue={privateData?.internalNotes} />
      </div>
      <p className="muted field-wide">Fornecedor e observações são visíveis só para a administração.</p>
      {error && (
        <p role="alert" className="notice notice-error field-wide">
          {error}
        </p>
      )}
      <div className="field-wide">
        <button type="submit" disabled={busy}>
          {product ? "Salvar alterações" : "Cadastrar produto"}
        </button>{" "}
        <button type="button" className="secondary" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
