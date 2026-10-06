import { authenticatedRoute } from "@/modules/access/command-route";
import { onlinePaymentConfig, onlineProviders } from "@/modules/payments/online/config";

export const dynamic = "force-dynamic";

/** Disponibilidade por canal e configuração PÚBLICA do componente de cartão (sem segredo). */
export const GET = (request: Request) =>
  authenticatedRoute(request, "topup online config", async () => {
    const config = onlinePaymentConfig();
    const providers = onlineProviders();
    return {
      pix: { available: config.pix.available, mode: config.pix.mode },
      card: { available: config.card.available, mode: config.card.mode, installments: 1, publicConfig: providers.card?.publicConfig ?? null },
    };
  });
