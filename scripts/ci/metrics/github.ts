// Acesso somente leitura à API REST do GitHub para o coletor de métricas, o gate e o ci-status.
// Token do workflow, ou o do `gh` autenticado da máquina local (obtido com argumentos fixos: `gh auth token`).
// Destino fixo (api.github.com): o caminho é validado e reconstruído segmento a segmento; nada vindo de entrada externa
// escolhe host nem vira argumento de comando.
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

/** URL absoluta em api.github.com: cada segmento codificado, parâmetros recompostos e origem conferida. */
export function apiUrl(path: string): URL {
  const [route = "", query = ""] = assertApiPath(path).split("?");
  const url = new URL(GITHUB_API);
  url.pathname = `/${route
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/")}`;
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.append(key, value);
  if (url.origin !== GITHUB_API) throw new Error("destino da API recusado");
  return url;
}

export function tokenFetcher(token: string, fetchImpl: typeof fetch = fetch): Fetcher {
  return async (path) => {
    const url = apiUrl(path);
    const response = await fetchImpl(url, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} em ${url.pathname}`);
    return response.json();
  };
}

/** Uso local: token do `gh` já autenticado (comando com argumentos fixos) e consulta pelo mesmo fetch validado. */
export function ghCliFetcher(token: () => string = () => execFileSync(bin("gh"), ["auth", "token"], { encoding: "utf8" }).trim(), fetchImpl: typeof fetch = fetch): Fetcher {
  let cached: string | null = null;
  return (path) => tokenFetcher((cached ??= token()), fetchImpl)(path);
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
