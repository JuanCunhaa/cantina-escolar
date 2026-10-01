import type { StorageConfig } from "./config.ts";
import { createLocalStore } from "./local.ts";
import { createR2Store } from "./r2.ts";
import type { ObjectStore } from "./types.ts";

/** Único ponto de escolha de implementação: local só existe para emulator (config.ts já recusa em staging/production). */
export function createObjectStore(config: StorageConfig): ObjectStore {
  return config.driver === "local" ? createLocalStore(config.dir) : createR2Store(config);
}
