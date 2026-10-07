// Recusa explícita de configuração ausente nos jobs que dependem de serviço externo (Veracode, SonarQube Cloud, Semgrep):
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

if (import.meta.main) {
  const [label, ...specs] = process.argv.slice(2);
  if (!label || !specs.length || specs.some((s) => !/^[A-Z][A-Z0-9_]*(=[\w.-]+)?$/.test(s))) {
    console.error("Uso: node scripts/ci/require-config.ts <rótulo> NOME [NOME=valor ...]");
    process.exit(2);
  }
  const problems = missingConfig(specs, process.env);
  if (problems.length) {
    const message = `${label}: configuração externa ausente ou não suportada (${problems.join("; ")}) — não executado, REPROVADO. Ver docs/testing/ci.md "Configuração externa".`;
    console.log(`::error::${message}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ❌ ${message}\n`);
    process.exit(1);
  }
  console.log(`${label}: configuração presente (${specs.map((s) => s.split("=")[0]).join(", ")}).`);
}
