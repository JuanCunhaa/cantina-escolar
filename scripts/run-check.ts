// Resumir stdout/stderr, guardar bytes brutos localmente e propagar falha.
// Comando sem shell: usar executáveis reais; npm.cmd no Windows não é executável nativo.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const executable = args.shift();
if (!executable) {
  console.error('Uso: node scripts/run-check.ts -- node <caminho-do-cli> [argumentos]');
  process.exit(2);
}
const directory = resolve(process.cwd(), '.agent-logs');
mkdirSync(directory, { recursive: true });
const logPath = resolve(directory, `check-${Date.now()}-${process.pid}.log`);
const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
let first = '';
let tail = '';
let bytes = 0;
let loggingFailed = false;
let spawnFailed = false;
let finished = false;
const headLimit = 16_384;
const tailLimit = 65_536;
log.on('error', error => {
  loggingFailed = true;
  console.error(`Falha ao salvar log: ${error.message}`);
});
const child = spawn(executable, args, { shell: false, stdio: ['inherit', 'pipe', 'pipe'] });
const collect = (chunk: Buffer) => {
  bytes += chunk.length;
  log.write(chunk);
  const text = chunk.toString('utf8');
  if (first.length < headLimit) first += text.slice(0, headLimit - first.length);
  tail = (tail + text).slice(-tailLimit);
};
child.stdout?.on('data', collect);
child.stderr?.on('data', collect);
child.on('error', error => {
  spawnFailed = true;
  console.error(`Não foi possível iniciar o comando: ${error.message}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => child.kill(signal));
}
child.on('close', (code, signal) => {
  const status = spawnFailed ? 127 : (code ?? (signal === 'SIGINT' ? 130 : 143));
  const emitSummary = () => {
    if (finished) return;
    finished = true;
    const finalStatus = loggingFailed && status === 0 ? 1 : status;
    console.log(JSON.stringify({ status: finalStatus, signal, bytes, log: logPath, summary: true }));
    if (finalStatus !== 0 && bytes > 0) {
      console.log('Início do log:');
      console.log(first.split('\n').slice(0, 40).join('\n'));
      if (bytes > headLimit) console.log('Fim do log (inspecionar log bruto se necessário):');
      if (bytes > headLimit) console.log(tail.split('\n').slice(-80).join('\n'));
    } else if (bytes > 0) {
      console.log(tail.split('\n').slice(-20).join('\n'));
    }
    process.exitCode = finalStatus;
  };
  if (loggingFailed || log.destroyed) emitSummary();
  else {
    log.once('error', emitSummary);
    log.end(emitSummary);
  }
});
