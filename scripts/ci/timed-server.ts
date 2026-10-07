// Inicia o servidor do e2e e registra quanto tempo levou até o Next anunciar "Ready" (observabilidade; não altera o comando).
// dev: next dev --webpack -p 3100 (como antes). start: next start -p 3100 sobre o .next já compilado (sem recompilar).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
const args = mode === "dev" ? ["dev", "--webpack", "-p", "3100"] : mode === "start" ? ["start", "-p", "3100"] : null;
if (!args) {
  console.error("Uso: node scripts/ci/timed-server.ts <dev|start>");
  process.exit(2);
}
const started = Date.now();
const child = spawn(process.execPath, [join("node_modules", "next", "dist", "bin", "next"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
let ready = false;
const watch = (chunk: Buffer, target: NodeJS.WriteStream) => {
  target.write(chunk);
  if (!ready && /\bReady\b/.test(chunk.toString("utf8"))) {
    ready = true;
    try {
      mkdirSync("ci-results", { recursive: true });
      writeFileSync(join("ci-results", `server-ready-${mode}-${process.pid}.json`), `${JSON.stringify({ mode, ready_ms: Date.now() - started, at: new Date().toISOString() })}\n`);
    } catch {
      /* só observabilidade */
    }
  }
};
child.stdout.on("data", (c: Buffer) => watch(c, process.stdout));
child.stderr.on("data", (c: Buffer) => watch(c, process.stderr));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
