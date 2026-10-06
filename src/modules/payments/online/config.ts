import "server-only";
import { demoCardProvider, demoPixProvider } from "./demo-provider";
import type { OnlineProviders } from "./provider";

/**
 * Provedor por canal, configurado no servidor (F18): `PAYMENTS_PIX_PROVIDER` e `PAYMENTS_CARD_PROVIDER`.
 * - ausente/vazio/`none`: canal INDISPONÍVEL (produção sem integração nunca credita nem simula);
 * - `demo`: só com APP_ENV=emulator; em homologação/produção é recusado e o canal fica indisponível;
 * - adapter real: ainda NÃO existe — o provedor não foi escolhido/aprovado (docs/status/payment-provider-research.md).
 * Valor desconhecido = indisponível (falha fechada).
 */
type Source = Record<string, string | undefined>;

export type ChannelConfig = { available: boolean; provider: string | null; mode: "demo" | "live" | null; reason: "not_configured" | "demo_outside_emulator" | "unknown_provider" | null };

function channel(value: string | undefined, appEnv: string | undefined): ChannelConfig {
  const v = (value ?? "").trim();
  if (v === "" || v === "none") return { available: false, provider: null, mode: null, reason: "not_configured" };
  if (v === "demo") {
    return appEnv === "emulator" ? { available: true, provider: "demo", mode: "demo", reason: null } : { available: false, provider: null, mode: null, reason: "demo_outside_emulator" };
  }
  return { available: false, provider: null, mode: null, reason: "unknown_provider" };
}

export function onlinePaymentConfig(source: Source = process.env): { pix: ChannelConfig; card: ChannelConfig } {
  return { pix: channel(source.PAYMENTS_PIX_PROVIDER, source.APP_ENV), card: channel(source.PAYMENTS_CARD_PROVIDER, source.APP_ENV) };
}

export function onlineProviders(source: Source = process.env): OnlineProviders {
  const config = onlinePaymentConfig(source);
  return { pix: config.pix.provider === "demo" ? demoPixProvider : null, card: config.card.provider === "demo" ? demoCardProvider : null };
}
