"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Card Payment Brick OFICIAL do Mercado Pago (SDK `https://sdk.mercadopago.com/js/v2`): número, validade e CVV são digitados
 * em campos do próprio Mercado Pago e viram um token de uso único; nada disso passa pela nossa aplicação nem por logs. Só
 * crédito (débito e pré-pago excluídos) e exatamente 1 parcela. Ao enviar, a tela recebe token, bandeira e pagador e chama
 * a NOSSA API (que cobra com idempotência); o resultado mostrado vem da nossa resposta, nunca do componente.
 * Documentação: checkout-bricks/card-payment-brick e github.com/mercadopago/sdk-js docs/bricks/card-payment.md, consulta 06/10/2026.
 */
export type CardSubmission = {
  cardToken: string;
  paymentMethodId: string;
  payer: { email: string; identification: { type: "CPF" | "CNPJ"; number: string } };
};

type BrickController = { unmount(): void };
type FormData = { token?: string; payment_method_id?: string; payer?: { email?: string; identification?: { type?: string; number?: string } } };
type MercadoPagoCtor = new (publicKey: string, options?: { locale?: string }) => {
  bricks(): { create(kind: "cardPayment", containerId: string, settings: unknown): Promise<BrickController> };
};
declare global {
  interface Window {
    MercadoPago?: MercadoPagoCtor;
  }
}

const SDK_URL = "https://sdk.mercadopago.com/js/v2";
const CONTAINER = "mp-card-brick";
let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (typeof window !== "undefined" && window.MercadoPago) return Promise.resolve();
  sdkPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("sdk"));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

/** Só o necessário para a cobrança; o documento segue ao provedor e não é guardado por nós. */
export function toSubmission(formData: FormData, paymentTypeId: string | undefined): CardSubmission | null {
  const type = formData.payer?.identification?.type;
  const number = (formData.payer?.identification?.number ?? "").replace(/\D/g, "");
  if (paymentTypeId !== "credit_card" || !formData.token || !formData.payment_method_id || !formData.payer?.email) return null;
  if (type !== "CPF" && type !== "CNPJ") return null;
  return { cardToken: formData.token, paymentMethodId: formData.payment_method_id, payer: { email: formData.payer.email, identification: { type, number } } };
}

export function MercadoPagoCardBrick({ amountCents, publicKey, onSubmit }: { amountCents: number; publicKey: string; onSubmit: (card: CardSubmission) => Promise<void> }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const submit = useRef(onSubmit);
  useEffect(() => {
    submit.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    let cancelled = false;
    let controller: BrickController | null = null;
    loadSdk()
      .then(async () => {
        if (cancelled || !window.MercadoPago) return;
        const mp = new window.MercadoPago(publicKey, { locale: "pt-BR" });
        const created = await mp.bricks().create("cardPayment", CONTAINER, {
          initialization: { amount: amountCents / 100 },
          // Só crédito (lista de inclusão; o SDK grafa "prepaid-card"), 1 parcela; o servidor revalida tipo e parcelas.
          customization: {
            paymentMethods: { minInstallments: 1, maxInstallments: 1, types: { included: ["credit_card"] } },
            visual: { texts: { formTitle: "Cartão de crédito" } },
          },
          callbacks: {
            onReady: () => {
              if (!cancelled) setState("ready");
            },
            onSubmit: async (formData: FormData, additionalData?: { paymentTypeId?: string }) => {
              const card = toSubmission(formData, additionalData?.paymentTypeId);
              if (!card) throw new Error("card_not_supported"); // débito/pré-pago ou dados incompletos: o componente mostra erro
              await submit.current(card);
            },
            onError: () => {
              if (!cancelled) setState("error");
            },
          },
        });
        if (cancelled) created.unmount();
        else controller = created;
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
      controller?.unmount();
    };
  }, [publicKey, amountCents]);

  return (
    <div data-testid="mp-card-brick" data-state={state}>
      {state === "loading" && <p role="status">Carregando o formulário seguro do Mercado Pago…</p>}
      {state === "error" && (
        <p role="alert" className="notice notice-error">
          Não foi possível carregar o pagamento por cartão agora. Nada foi cobrado. Tente o Pix ou mais tarde.
        </p>
      )}
      <div id={CONTAINER} />
      <p className="muted">Os dados do cartão são digitados no formulário do Mercado Pago e não passam pela escola. Somente crédito, em 1 parcela.</p>
    </div>
  );
}
