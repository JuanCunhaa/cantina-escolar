import "server-only";
import { demoCardProvider, demoPixProvider } from "./demo-provider";
import { mercadoPagoCard, mercadoPagoPix, type MercadoPagoConfig } from "./mercadopago";
import type { OnlineProviders } from "./provider";

/**
 * Provedor por canal, configurado no servidor (F18): `PAYMENTS_PIX_PROVIDER` e `PAYMENTS_CARD_PROVIDER`.
 * - ausente/vazio/`none`: canal INDISPONÍVEL (produção sem integração nunca credita nem simula);
 * - `demo`: só com APP_ENV=emulator; em homologação/produção é recusado e o canal fica indisponível;
 * - `mercadopago` (aprovado em 06/10/2026): exige `MERCADOPAGO_ACCESS_TOKEN` (segredo do servidor), `MERCADOPAGO_PUBLIC_KEY`
 *   (só para o cartão; chave pública do componente) e `MERCADOPAGO_ENV`. Fora de APP_ENV=production o ambiente TEM de ser
 *   `sandbox`; em APP_ENV=production TEM de ser `production` (nenhuma credencial de teste em produção, nenhuma real fora dela).
 * Valor desconhecido, credencial ausente ou combinação proibida = indisponível (falha fechada). Valores nunca são registrados.
 */
type Source = Record<string, string | undefined>;

type Reason = "not_configured" | "demo_outside_emulator" | "unknown_provider" | "missing_credentials" | "env_mismatch";
export type ChannelConfig = { available: boolean; provider: string | null; mode: "demo" | "live" | null; reason: Reason | null };

const TOKEN = /^[A-Za-z0-9_-]{20,300}$/;
const off = (reason: Reason): ChannelConfig => ({ available: false, provider: null, mode: null, reason });

function mercadoPago(source: Source, needsPublicKey: boolean): { config: MercadoPagoConfig | null; reason: Reason | null } {
  const env = source.MERCADOPAGO_ENV;
  const accessToken = (source.MERCADOPAGO_ACCESS_TOKEN ?? "").trim();
  const publicKey = (source.MERCADOPAGO_PUBLIC_KEY ?? "").trim();
  if (!TOKEN.test(accessToken) || (needsPublicKey && !TOKEN.test(publicKey)) || (env !== "sandbox" && env !== "production")) return { config: null, reason: "missing_credentials" };
  if ((source.APP_ENV === "production") !== (env === "production")) return { config: null, reason: "env_mismatch" };
  return { config: { accessToken, publicKey, env }, reason: null };
}

function channel(value: string | undefined, source: Source, needsPublicKey: boolean): ChannelConfig {
  const v = (value ?? "").trim();
  if (v === "" || v === "none") return off("not_configured");
  if (v === "demo") return source.APP_ENV === "emulator" ? { available: true, provider: "demo", mode: "demo", reason: null } : off("demo_outside_emulator");
  if (v === "mercadopago") {
    const mp = mercadoPago(source, needsPublicKey);
    return mp.config ? { available: true, provider: "mercadopago", mode: "live", reason: null } : off(mp.reason!);
  }
  return off("unknown_provider");
}

export function onlinePaymentConfig(source: Source = process.env): { pix: ChannelConfig; card: ChannelConfig } {
  return { pix: channel(source.PAYMENTS_PIX_PROVIDER, source, false), card: channel(source.PAYMENTS_CARD_PROVIDER, source, true) };
}

/** Ambiente do provedor real em uso ("sandbox" na homologação), para a tela avisar que é teste. */
export function mercadoPagoEnv(source: Source = process.env): "sandbox" | "production" | null {
  return source.MERCADOPAGO_ENV === "sandbox" || source.MERCADOPAGO_ENV === "production" ? source.MERCADOPAGO_ENV : null;
}

export function onlineProviders(source: Source = process.env): OnlineProviders {
  const config = onlinePaymentConfig(source);
  const pix = config.pix.provider === "demo" ? demoPixProvider : config.pix.provider === "mercadopago" ? mercadoPagoPix(mercadoPago(source, false).config!) : null;
  const card = config.card.provider === "demo" ? demoCardProvider : config.card.provider === "mercadopago" ? mercadoPagoCard(mercadoPago(source, true).config!) : null;
  return { pix, card };
}
