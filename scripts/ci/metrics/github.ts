// Acesso somente leitura à API REST do GitHub para o coletor de métricas e o ci-status.
// Duas fontes: token do workflow (fetch) ou o `gh` autenticado da máquina local (sem manipular token aqui).
import { execFileSync } from "node:child_process";

export type Fetcher = (path: string) => Promise<unknown>;

export function tokenFetcher(token: string, apiUrl = "https://api.github.com"): Fetcher {
  return async (path) => {
    const response = await fetch(`${apiUrl}/${path.replace(/^\//, "")}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} em ${path}`);
    return response.json();
  };
}

export function ghCliFetcher(): Fetcher {
  return async (path) => JSON.parse(execFileSync("gh", ["api", path.replace(/^\//, "")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
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
