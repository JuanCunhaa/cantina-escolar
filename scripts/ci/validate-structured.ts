// Validação leve de documentos estruturados versionados (roda também em mudança só de documentação):
// todo .json rastreado pelo git precisa ser JSON válido. Sem dependências instaladas.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bin } from "./lib/bin.ts";

export function invalidJson(files: string[], read: (file: string) => string): string[] {
  const errors: string[] = [];
  for (const file of files) {
    try {
      JSON.parse(read(file).replace(/^﻿/, ""));
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export function main(deps: { cwd?: string; log?: (text: string) => void } = {}): number {
  const cwd = deps.cwd ?? process.cwd();
  const log = deps.log ?? console.log;
  const files = execFileSync(bin("git"), ["ls-files", "-z", "--", "*.json"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  const errors = invalidJson(files, (file) => readFileSync(join(cwd, file), "utf8"));
  if (errors.length) {
    log(`JSON inválido:\n- ${errors.join("\n- ")}`);
    return 1;
  }
  log(`${files.length} arquivo(s) JSON válidos.`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
