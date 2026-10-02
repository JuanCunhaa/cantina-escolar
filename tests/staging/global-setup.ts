import { request } from "@playwright/test";
import { ensureFixtures } from "../../scripts/staging/fixtures.ts";
import { printPreflight, runPreflight } from "../../scripts/staging/preflight.ts";
import { bypassSecret, loadTarget, PUBLISHED_STATE_FILE, type Target } from "../../scripts/staging/target.ts";

/**
 * Deployment publicado: troca o segredo de bypass pelo cookie da Vercel (escopo do host) e confirma que a proteção
 * continua ativa para quem não tem o cookie.
 */
async function preparePublished(target: Target): Promise<void> {
  const anonymous = await request.newContext({ maxRedirects: 0 });
  const blocked = await anonymous.get(`${target.baseUrl}/`);
  await anonymous.dispose();
  if (![302, 401, 403].includes(blocked.status())) throw new Error(`Deployment sem proteção: GET / anônimo respondeu ${blocked.status()}.`);

  const context = await request.newContext();
  const response = await context.get(`${target.baseUrl}/`, {
    headers: { "x-vercel-protection-bypass": bypassSecret(), "x-vercel-set-bypass-cookie": "true" },
  });
  if (!response.ok()) throw new Error(`Bypass da Vercel recusado (${response.status()}).`);
  await context.storageState({ path: PUBLISHED_STATE_FILE });
  await context.dispose();
  console.log(`deployment publicado: proteção ativa (anônimo ${blocked.status()}), bypass por cookie do host`);
}

/** Confirma o destino, exige o preflight verde e garante as fixtures duráveis antes de qualquer teste. */
export default async function globalSetup(): Promise<void> {
  const target = loadTarget();
  if (!printPreflight(target, await runPreflight(target))) throw new Error("Preflight falhou: veja as linhas FALHA acima.");
  if (target.published) await preparePublished(target);
  await ensureFixtures(target);
}
