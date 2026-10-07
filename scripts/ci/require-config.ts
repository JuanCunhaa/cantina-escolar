// Recusa explícita de configuração ausente nos jobs que dependem de serviço externo (Veracode, SonarQube Cloud):
// credencial/variável ausente REPROVA o passo — nunca vira aprovação silenciosa. Não imprime valores.
// Uso: node scripts/ci/require-config.ts <rótulo> NOME [NOME=valor-exigido ...]
import { appendFileSync } from "node:fs";

export function missingConfig(specs: string[], env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const spec of specs) {
    const [name, expected] = spec.split("=") as [string, string | undefined];
    const value = env[name];
    if (!value) problems.push(`${name} ausente`);
    else if (expected !== undefined && value !== expected) problems.push(`${name} com valor não suportado (exigido: ${expected})`);
  }
  return problems;
}

/** CLI testável: devolve o código de saída. */
export function main(argv: string[], env: Record<string, string | undefined>, out: (text: string) => void = (text) => process.stdout.write(text)): number {
  const [label, ...specs] = argv;
  if (!label || !specs.length || specs.some((s) => !/^[A-Z][A-Z0-9_]*(=[\w.-]+)?$/.test(s))) {
    console.error("Uso: node scripts/ci/require-config.ts <rótulo> NOME [NOME=valor ...]");
    return 2;
  }
  const problems = missingConfig(specs, env);
  if (problems.length) {
    const message = `${label}: configuração externa ausente ou não suportada (${problems.join("; ")}) — não executado, REPROVADO. Ver docs/testing/ci.md "Configuração externa".`;
    out(`::error::${message}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### ❌ ${message}\n`);
    return 1;
  }
  out(`${label}: configuração presente (${specs.map((s) => s.split("=")[0]).join(", ")}).\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
