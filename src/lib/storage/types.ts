// Contrato único de armazenamento de arquivos. Implementações: R2 (staging/production) e disco local (só emulator).
// Sem imports `@/` nem `server-only`: este arquivo também é carregado direto pelo Node (seed).

export type ObjectInfo = {
  key: string;
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
};

export type StoredObject = ObjectInfo & { body: Uint8Array };

/** Já existe um objeto com a mesma chave: objetos validados nunca são sobrescritos. */
export class ObjectExistsError extends Error {}
/** Falha do provedor (rede, credencial, indisponibilidade). Nunca carrega segredo nem a resposta bruta. */
export class StorageUnavailableError extends Error {}

export interface ObjectStore {
  /** Cria o objeto somente se a chave ainda não existir; caso contrário lança ObjectExistsError. */
  putIfAbsent(key: string, body: Uint8Array, options: { contentType: string; metadata?: Record<string, string> }): Promise<{ etag: string | null }>;
  head(key: string): Promise<ObjectInfo | null>;
  get(key: string): Promise<StoredObject | null>;
  /** Idempotente: apagar objeto inexistente não é erro. */
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<ObjectInfo>;
}

/** Chave de objeto aceita pelas implementações: segmentos simples, sem `..`, sem barra inicial. */
export const OBJECT_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}(\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}){0,7}$/;

export function assertObjectKey(key: string): void {
  if (!OBJECT_KEY_PATTERN.test(key) || key.split("/").some((part) => part === "." || part === ".." || part.endsWith(".."))) {
    throw new Error("Chave de objeto inválida.");
  }
}
