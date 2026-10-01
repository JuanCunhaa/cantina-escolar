"use client";

import { useState, type ChangeEvent } from "react";
import { ref, uploadBytes } from "firebase/storage";
import { ProductPhoto } from "@/components/ui/product-photo";
import { formatBRL } from "@/lib/money/format";
import { getFirebaseClient } from "@/lib/firebase/client";
import { PHOTO_ACCEPT, productPhotoPath, validatePhoto } from "@/lib/validation/photo";
import { useDemoProducts } from "../use-demo-products";

type Feedback = { productId: string; kind: "ok" | "error"; text: string };

/** Operação: troca de foto de produto. Envia ao Storage (Rules validam papel/tipo/tamanho) e o servidor registra o metadado. */
export function PhotoManager({ uid, idToken }: { uid: string; idToken: () => Promise<string> }) {
  const { status, products } = useDemoProducts(uid);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function upload(productId: string, event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const check = validatePhoto(file);
    if (!check.ok) {
      setFeedback({ productId, kind: "error", text: check.message });
      input.value = "";
      return;
    }
    setBusy(productId);
    setFeedback(null);
    try {
      const path = productPhotoPath(productId, crypto.randomUUID().replaceAll("-", ""), check.extension);
      await uploadBytes(ref(getFirebaseClient().storage, path), file, { contentType: check.type });
      const response = await fetch("/api/catalog/photo", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await idToken()}` },
        body: JSON.stringify({ productId, path }),
      });
      setFeedback(
        response.ok
          ? { productId, kind: "ok", text: "Foto atualizada." }
          : { productId, kind: "error", text: "O servidor recusou a foto. Use uma imagem JPEG, PNG ou WebP válida de até 2 MB." },
      );
    } catch {
      setFeedback({ productId, kind: "error", text: "Não foi possível enviar a foto. Seu perfil pode não ter permissão." });
    } finally {
      setBusy(null);
      input.value = "";
    }
  }

  return (
    <section>
      <h1>Produtos e fotos</h1>
      <p className="muted">Catálogo de demonstração (fictício). JPEG, PNG ou WebP, até 2 MB.</p>
      {status === "loading" && <p role="status">Carregando produtos…</p>}
      {status === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar os produtos.
        </p>
      )}
      <div className="table-scroll">
        <table className="data-table">
          <caption className="muted">Foto atual e envio de nova foto por produto</caption>
          <thead>
            <tr>
              <th scope="col">Foto</th>
              <th scope="col">Produto</th>
              <th scope="col">Preço</th>
              <th scope="col">Nova foto</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id} data-testid="photo-row">
                <td>
                  <ProductPhoto photoPath={product.photoPath} name={product.name} />
                </td>
                <td>{product.name}</td>
                <td>{formatBRL(product.priceCents)}</td>
                <td>
                  <label htmlFor={`photo-${product.id}`} className="muted">
                    Enviar foto de {product.name}
                  </label>
                  <br />
                  <input
                    id={`photo-${product.id}`}
                    type="file"
                    accept={PHOTO_ACCEPT}
                    disabled={busy !== null}
                    onChange={(event) => void upload(product.id, event)}
                  />
                  {feedback?.productId === product.id && (
                    <p role={feedback.kind === "error" ? "alert" : "status"} className={feedback.kind === "error" ? "notice notice-error" : "notice"}>
                      {feedback.text}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
