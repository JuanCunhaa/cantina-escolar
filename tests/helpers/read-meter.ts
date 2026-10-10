import type { Firestore } from "firebase-admin/firestore";

/**
 * Medidor de leituras do Firestore para TESTES (emulador): intercepta, no cliente Admin, as chamadas que trazem documentos
 * (consulta, leitura por ID, `getAll`, agregação, listagem) e soma os documentos que cada uma devolveu. É uma ESTIMATIVA do que a
 * aplicação pediu, não a cobrança oficial do Firebase: consulta custa no mínimo 1 leitura mesmo vazia; agregação custa 1 por 1 000
 * entradas de índice (mínimo 1); a listagem de documentos conta 1 por documento listado. Etiqueta = `grupo:<coleção>` (consulta de
 * grupo), `colecao:<coleção>`, `doc:<raiz>`, `getAll`, `agregacao`, `listagem`.
 * As classes do cliente não são exportadas como valor pelo `firebase-admin`; os protótipos saem de instâncias reais.
 */
export type Tally = { total: number; calls: number; byLabel: Record<string, number> };

type AnyFn = (...args: unknown[]) => Promise<unknown>;
let active: Tally | null = null;
let installed = false;
/** `DocumentReference.get()` chama `getAll` por dentro: a leitura já foi contada como `doc:`, então o `getAll` interno não conta de novo. */
let insideDocGet = 0;

function add(label: string, n: number): void {
  if (!active) return;
  active.total += n;
  active.calls += 1;
  active.byLabel[label] = (active.byLabel[label] ?? 0) + n;
}

function queryLabel(q: unknown): string {
  const o = (q as { _queryOptions?: { collectionId?: string; allDescendants?: boolean } })._queryOptions;
  if (!o?.collectionId) return "colecao:?";
  return `${o.allDescendants ? "grupo" : "colecao"}:${o.collectionId}`;
}

function patch(proto: object, name: string, wrap: (original: AnyFn) => AnyFn): void {
  const original = (proto as Record<string, AnyFn>)[name];
  if (typeof original !== "function") throw new Error(`medidor: ${name} não existe no protótipo`);
  (proto as Record<string, AnyFn>)[name] = wrap(original);
}

function install(db: Firestore): void {
  if (installed) return;
  installed = true;
  const collection = db.collection("medidor");
  patch(Object.getPrototypeOf(collection.where("a", "==", 1)) as object, "get", (original) =>
    async function (this: unknown, ...args) {
      const snap = (await original.apply(this, args)) as { size: number };
      add(queryLabel(this), Math.max(1, snap.size));
      return snap;
    },
  );
  patch(Object.getPrototypeOf(db.doc("medidor/a")) as object, "get", (original) =>
    async function (this: { path: string }, ...args) {
      insideDocGet += 1;
      try {
        const snap = await original.apply(this, args);
        add(`doc:${this.path.split("/")[0]}`, 1);
        return snap;
      } finally {
        insideDocGet -= 1;
      }
    },
  );
  patch(Object.getPrototypeOf(db) as object, "getAll", (original) =>
    async function (this: unknown, ...args) {
      const snaps = (await original.apply(this, args)) as unknown[];
      if (insideDocGet === 0) add("getAll", snaps.length);
      return snaps;
    },
  );
  patch(Object.getPrototypeOf(collection.count()) as object, "get", (original) =>
    async function (this: unknown, ...args) {
      const snap = (await original.apply(this, args)) as { data(): { count?: number } };
      add("agregacao", Math.max(1, Math.ceil((snap.data().count ?? 0) / 1000)));
      return snap;
    },
  );
  patch(Object.getPrototypeOf(collection) as object, "listDocuments", (original) =>
    async function (this: unknown, ...args) {
      const refs = (await original.apply(this, args)) as unknown[];
      add("listagem", refs.length);
      return refs;
    },
  );
}

/** Mede o que `run` consulta (tudo o que o processo pedir enquanto ele roda). Não aninhar. */
export async function measureReads<T>(db: Firestore, run: () => Promise<T>): Promise<{ result: T; tally: Tally }> {
  install(db);
  active = { total: 0, calls: 0, byLabel: {} };
  try {
    const result = await run();
    return { result, tally: active };
  } finally {
    active = null;
  }
}
