import "server-only";
import { parseStorageConfig } from "./config.ts";
import { createObjectStore } from "./factory.ts";
import type { ObjectStore } from "./types.ts";

export * from "./types.ts";

type Cached = { signature: string; store: ObjectStore };
const holder = globalThis as typeof globalThis & { __cantinaObjectStore?: Cached };

/**
 * Armazenamento de arquivos do ambiente atual (R2 em staging/production; disco local só em emulator). Falha fechada se
 * a configuração for inválida. Guardado em globalThis porque o dev server do Next pode instanciar o módulo mais de uma vez.
 */
export function getObjectStore(source: Record<string, string | undefined> = process.env): ObjectStore {
  const config = parseStorageConfig(source);
  const signature = JSON.stringify(config);
  if (holder.__cantinaObjectStore?.signature === signature) return holder.__cantinaObjectStore.store;
  const store = createObjectStore(config);
  holder.__cantinaObjectStore = { signature, store };
  return store;
}
