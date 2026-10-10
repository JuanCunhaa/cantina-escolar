// Grafo `needs` de um workflow, lido como DADO do arquivo da branch padrão (checkout esparso do coletor): permite separar a
// fila do runner (job pronto, sem runner livre) da espera por dependência (a API informa só criação→início).
// Analisador mínimo, sem dependências, para as formas usadas em ci.yml: `needs: a`, `needs: [a, b]` e lista em linhas `- a`.

export type NeedsGraph = Record<string, string[]>;

const stripComment = (line: string) => line.replace(/\s+#.*$/, "");

export function parseNeeds(workflowYaml: string): NeedsGraph {
  const graph: NeedsGraph = {};
  const lines = workflowYaml.split(/\r?\n/).map(stripComment);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return graph;
  let job: string | null = null;
  let collecting = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // fim da seção jobs
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) {
      job = id[1] ?? null;
      collecting = false;
      if (job) graph[job] = [];
      continue;
    }
    if (!job) continue;
    const inline = /^ {4}needs:\s*(.*)$/.exec(line);
    if (inline) {
      const value = (inline[1] ?? "").trim();
      collecting = value === "";
      graph[job] = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (collecting) {
      const item = /^ {6}-\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
      if (item?.[1]) graph[job]?.push(item[1]);
      else if (/^ {4}\S/.test(line)) collecting = false;
    }
  }
  return graph;
}

/** Identificador do job no workflow a partir do nome exibido na API ("e2e (g1)" -> "e2e"); null se não houver no grafo. */
export function jobIdOf(displayName: string, graph: NeedsGraph): string | null {
  if (displayName in graph) return displayName;
  const match = Object.keys(graph).find((id) => displayName.startsWith(`${id} (`));
  return match ?? null;
}
