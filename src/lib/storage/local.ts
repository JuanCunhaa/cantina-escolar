// Armazenamento em disco SOMENTE para APP_ENV=emulator (dev/seed/testes hermeticamente locais). É um double do R2:
// prova a lógica da aplicação, não o comportamento do provedor. Staging/production nunca o selecionam (config.ts).
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertObjectKey, ObjectExistsError, type ObjectInfo, type ObjectStore, type StoredObject } from "./types.ts";

type Meta = { contentType: string; metadata: Record<string, string> };

export function createLocalStore(rootDir: string): ObjectStore {
  const root = resolve(rootDir);
  const objects = join(root, "objects");
  const metas = join(root, "meta");

  function pathFor(base: string, key: string, suffix = ""): string {
    assertObjectKey(key);
    const full = resolve(base, ...key.split("/")) + suffix;
    if (!full.startsWith(base + sep)) throw new Error("Chave de objeto inválida.");
    return full;
  }

  async function info(key: string): Promise<ObjectInfo | null> {
    let stats;
    try {
      stats = await stat(pathFor(objects, key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stats.isFile()) return null;
    const meta = await readFile(pathFor(metas, key, ".json"), "utf8").then((text) => JSON.parse(text) as Meta, () => null);
    const body = await readFile(pathFor(objects, key));
    return {
      key,
      size: stats.size,
      contentType: meta?.contentType ?? null,
      etag: `"${createHash("md5").update(body).digest("hex")}"`,
      lastModified: stats.mtime,
    };
  }

  return {
    async putIfAbsent(key, body, options) {
      const target = pathFor(objects, key);
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, body, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ObjectExistsError(key);
        throw error;
      }
      const metaPath = pathFor(metas, key, ".json");
      await mkdir(dirname(metaPath), { recursive: true });
      const meta: Meta = { contentType: options.contentType, metadata: options.metadata ?? {} };
      await writeFile(metaPath, JSON.stringify(meta));
      return { etag: `"${createHash("md5").update(body).digest("hex")}"` };
    },
    head: info,
    async get(key): Promise<StoredObject | null> {
      const found = await info(key);
      if (!found) return null;
      return { ...found, body: new Uint8Array(await readFile(pathFor(objects, key))) };
    },
    async delete(key) {
      await rm(pathFor(objects, key), { force: true });
      await rm(pathFor(metas, key, ".json"), { force: true });
    },
    async *list(prefix) {
      async function* walk(dir: string, relative: string): AsyncGenerator<string> {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const next = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) yield* walk(join(dir, entry.name), next);
          else yield next;
        }
      }
      for await (const key of walk(objects, "")) {
        if (!key.startsWith(prefix)) continue;
        const found = await info(key);
        if (found) yield found;
      }
    },
  };
}
