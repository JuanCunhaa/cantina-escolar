import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";

/**
 * Observabilidade do CI: instantâneo de recursos quando os testes terminam, ainda com o servidor e os emuladores no ar
 * (o passo do workflow só enxerga o runner depois que eles saem). Só no CI, nunca falha o teste e não lê variáveis de ambiente.
 */
export default function globalTeardown(): void {
  if (!process.env.CI || !existsSync("scripts/ci/resource-snapshot.sh")) return;
  try {
    mkdirSync("ci-diagnostics", { recursive: true });
    appendFileSync("ci-diagnostics/resources.txt", execFileSync("bash", ["scripts/ci/resource-snapshot.sh", "teardown-e2e-servicos-ativos"], { encoding: "utf8", timeout: 10000 }));
  } catch {
    /* diagnóstico: ignorar */
  }
}
