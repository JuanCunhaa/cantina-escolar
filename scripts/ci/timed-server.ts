// Inicia o servidor do e2e e registra quanto tempo levou até o Next anunciar "Ready" (observabilidade; não altera o comando).
// dev: next dev --webpack -p 3100 (como antes). start: next start -p 3100 sobre o .next já compilado (sem recompilar).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function serverArgs(mode: string | undefined): string[] | null {
  if (mode === "dev") return ["dev", "--webpack", "-p", "3100"];
  if (mode === "start") return ["start", "-p", "3100"];
  return null;
}

type Options = { nextBin?: string; outDir?: string; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; now?: () => number };

/** Sobe o Next e grava ci-results/server-ready-<modo>-<pid>.json na primeira linha com "Ready". */
export function startServer(mode: "dev" | "start", opts: Options = {}): ChildProcess {
  const now = opts.now ?? Date.now;
  const started = now();
  const nextBin = opts.nextBin ?? join("node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, ...(serverArgs(mode) ?? [])], { stdio: ["ignore", "pipe", "pipe"] });
  let ready = false;
  const watch = (chunk: Buffer, target: NodeJS.WritableStream) => {
    target.write(chunk);
    if (ready || !/\bReady\b/.test(chunk.toString("utf8"))) return;
    ready = true;
    try {
      const dir = opts.outDir ?? "ci-results";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `server-ready-${mode}-${child.pid}.json`), `${JSON.stringify({ mode, ready_ms: now() - started, at: new Date().toISOString() })}\n`);
    } catch {
      /* só observabilidade: nunca derruba o servidor */
    }
  };
  child.stdout?.on("data", (c: Buffer) => watch(c, opts.stdout ?? process.stdout));
  child.stderr?.on("data", (c: Buffer) => watch(c, opts.stderr ?? process.stderr));
  return child;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "dev" && mode !== "start") {
    console.error("Uso: node scripts/ci/timed-server.ts <dev|start>");
    process.exit(2);
  }
  const child = startServer(mode);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
