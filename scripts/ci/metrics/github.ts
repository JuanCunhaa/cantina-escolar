// Acesso somente leitura à API REST do GitHub para o coletor de métricas, o gate e o ci-status.
// Duas fontes: token do workflow (fetch) ou o `gh` autenticado da máquina local (sem manipular token aqui).
// Destino fixo (api.github.com) e caminho validado: nada vindo de entrada externa escolhe host ou argumentos livres.
import { execFileSync } from "node:child_process";
import { bin } from "../lib/bin.ts";

export type Fetcher = (path: string) => Promise<unknown>;

export const GITHUB_API = "https://api.github.com";
const SAFE_PATH = /^(repos\/[\w.-]+\/[\w.-]+|user)(\/[\w.%-]+)*(\?[\w.%=&:-]*)?$/;

export function assertApiPath(path: string): string {
  const clean = path.replace(/^\//, "");
  if (!SAFE_PATH.test(clean) || clean.split("?")[0]!.split("/").some((segment) => segment === ".." || segment === ".")) throw new Error(`caminho de API recusado: ${clean.slice(0, 80)}`);
  return clean;
}

export function tokenFetcher(token: string, fetchImpl: typeof fetch = fetch): Fetcher {
  return async (path) => {
    const response = await fetchImpl(`${GITHUB_API}/${assertApiPath(path)}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} em ${assertApiPath(path).split("?")[0]}`);
    return response.json();
  };
}

export function ghCliFetcher(run: (args: string[]) => string = (args) => execFileSync(bin("gh"), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })): Fetcher {
  return async (path) => JSON.parse(run(["api", assertApiPath(path)]));
}

/** Pagina listas da API (`per_page=100`) até a última página; `key` é a propriedade com os itens. */
export async function paginate<T>(fetcher: Fetcher, path: string, key: string, maxPages = 20): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const body = (await fetcher(`${path}${separator}per_page=100&page=${page}`)) as Record<string, unknown>;
    const chunk = (body[key] ?? []) as T[];
    items.push(...chunk);
    const total = typeof body.total_count === "number" ? body.total_count : undefined;
    if (chunk.length < 100 || (total !== undefined && items.length >= total)) return items;
  }
  throw new Error(`Paginação excedeu ${maxPages} páginas em ${path}: resultado incompleto não é aceito.`);
}
