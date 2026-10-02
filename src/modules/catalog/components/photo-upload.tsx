"use client";

import { useState, type ChangeEvent } from "react";
import type { User } from "firebase/auth";
import { PHOTO_ACCEPT, validatePhoto } from "@/lib/validation/photo";

/**
 * Troca de foto de um produto (cantina e administração). Envia só os bytes; o servidor autoriza, inspeciona a imagem,
 * grava no armazenamento privado (R2) com chave nova e só então aponta o produto para ela.
 */
export function PhotoUpload({ user, productId, productName }: { user: User; productId: string; productName: string }) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const check = validatePhoto(file);
    if (!check.ok) {
      setFeedback({ kind: "error", text: check.message });
      input.value = "";
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/catalog/photo?productId=${encodeURIComponent(productId)}`, {
        method: "POST",
        headers: { "content-type": check.type, authorization: `Bearer ${await user.getIdToken()}` },
        body: file,
      });
      setFeedback(
        response.ok
          ? { kind: "ok", text: "Foto atualizada." }
          : {
              kind: "error",
              text:
                response.status === 403
                  ? "Seu perfil não tem permissão para trocar fotos."
                  : response.status === 503
                    ? "Armazenamento de fotos indisponível no momento. Tente mais tarde."
                    : "O servidor recusou a foto. Use uma imagem JPEG, PNG ou WebP válida de até 2 MB.",
            },
      );
    } catch {
      setFeedback({ kind: "error", text: "Não foi possível enviar a foto. Verifique a conexão e tente novamente." });
    } finally {
      setBusy(false);
      input.value = "";
    }
  }

  return (
    <div>
      <label htmlFor={`photo-${productId}`} className="muted">
        Enviar foto de {productName}
      </label>
      <br />
      <input id={`photo-${productId}`} type="file" accept={PHOTO_ACCEPT} disabled={busy} onChange={(event) => void upload(event)} />
      {feedback && (
        <p role={feedback.kind === "error" ? "alert" : "status"} className={feedback.kind === "error" ? "notice notice-error" : "notice"}>
          {feedback.text}
        </p>
      )}
    </div>
  );
}
