import { authenticatedRoute } from "@/modules/access/command-route";
import { mercadoPagoEnv, onlinePaymentConfig, onlineProviders } from "@/modules/payments/online/config";

export const dynamic = "force-dynamic";

/** Disponibilidade por canal, ambiente do provedor (sandbox = teste) e configuração PÚBLICA do componente de cartão (sem segredo). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "topup online config", async () => {
    const config = onlinePaymentConfig();
    const providers = onlineProviders();
    const live = config.pix.mode === "live" || config.card.mode === "live";
    return {
      providerEnv: live ? mercadoPagoEnv() : null,
      pix: { available: config.pix.available, mode: config.pix.mode },
      card: { available: config.card.available, mode: config.card.mode, installments: 1, publicConfig: providers.card?.publicConfig ?? null },
    };
  });
