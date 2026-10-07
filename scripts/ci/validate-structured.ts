// Validação leve de documentos estruturados versionados (roda também em mudança só de documentação):
// todo .json rastreado pelo git precisa ser JSON válido. Sem dependências instaladas.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "--", "*.json"], { encoding: "utf8" }).split("\0").filter(Boolean);
const errors: string[] = [];
for (const file of files) {
  try {
    JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (errors.length) {
  console.error(`JSON inválido:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`${files.length} arquivo(s) JSON válidos.`);
