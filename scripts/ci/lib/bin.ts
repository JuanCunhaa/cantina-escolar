// Executáveis externos por CAMINHO ABSOLUTO em diretórios fixos e não graváveis do runner Linux (não pelo PATH).
// No Windows (uso local por quem desenvolve) usa o nome, resolvido pelo ambiente da própria máquina.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FIXED_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"] as const;
export type Tool = "git" | "tar" | "gh";

export function bin(name: Tool, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  if (platform === "win32") return name;
  for (const dir of FIXED_DIRS) {
    const candidate = `${dir}/${name}`;
    if (exists(candidate)) return candidate;
  }
  throw new Error(`${name} não encontrado em ${FIXED_DIRS.join(", ")}`);
}

/** Versão do npm que acompanha o Node em execução, lida do pacote (sem executar nada). */
export function npmVersion(execPath = process.execPath, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string | null {
  const base = dirname(execPath);
  const path = platform === "win32" ? join(base, "node_modules", "npm", "package.json") : join(base, "..", "lib", "node_modules", "npm", "package.json");
  if (!exists(path)) return null;
  return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? null;
}
