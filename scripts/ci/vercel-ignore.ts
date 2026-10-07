// Ignored Build Step da Vercel (vercel.json "ignoreCommand"). Contrato da Vercel: saída 0 = IGNORAR o build;
// saída 1 = CONTINUAR o build. Só ignora quando TODAS as mudanças desde o último deploy bem-sucedido da branch
// (VERCEL_GIT_PREVIOUS_SHA..VERCEL_GIT_COMMIT_SHA) são documentação elegível. Erro, SHA ausente/fora do clone raso,
// Node antigo ou qualquer exceção => saída 1 (constrói normalmente).
import { classifyRange } from "./classify-changes.ts";

try {
  const previous = process.env.VERCEL_GIT_PREVIOUS_SHA;
  const current = process.env.VERCEL_GIT_COMMIT_SHA;
  const result = classifyRange(previous, current);
  console.log(`[ignored-build-step] ${previous?.slice(0, 7) ?? "?"}..${current?.slice(0, 7) ?? "?"}: modo=${result.mode} — ${result.reason}`);
  process.exit(result.mode === "docs" ? 0 : 1);
} catch (error) {
  console.log(`[ignored-build-step] falha na classificação (${error instanceof Error ? error.message : String(error)}): build normal`);
  process.exit(1);
}
