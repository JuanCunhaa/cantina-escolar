import { ensureFixtures } from "../../scripts/staging/fixtures.ts";
import { printPreflight, runPreflight } from "../../scripts/staging/preflight.ts";
import { loadTarget } from "../../scripts/staging/target.ts";

/** Confirma o destino, exige o preflight verde e garante as fixtures duráveis antes de qualquer teste. */
export default async function globalSetup(): Promise<void> {
  const target = loadTarget();
  if (!printPreflight(target, await runPreflight(target))) throw new Error("Preflight falhou: veja as linhas FALHA acima.");
  await ensureFixtures(target);
}
