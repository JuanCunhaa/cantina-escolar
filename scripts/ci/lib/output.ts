// Saída de texto no terminal/log sem permitir que conteúdo externo (API, argumentos) forje linhas: cada linha é escrita
// isoladamente, sem CR/LF embutidos.
export function writeLines(text: string, write: (line: string) => void = (line) => process.stdout.write(line)): void {
  for (const line of text.split("\n")) write(`${line.replace(/[\r\n]/g, "")}\n`);
}
