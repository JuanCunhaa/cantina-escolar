// Build único do CI compartilhado com os grupos e2e: pacote do .next + manifesto rastreável, validado pelo consumidor.
//   env                     imprime o ambiente HERMÉTICO do build (para $GITHUB_ENV): APP_ENV=emulator e NEXT_PUBLIC_* fictícios
//   pack --out <dir> --name <artefato> --build-command <cmd>
//                           empacota o .next (sem cache/trace de diagnóstico), recusa arquivo proibido e grava manifest.json
//   verify --dir <dir>      confere manifesto × código testado (mesmo run, mesmo SHA, lockfile, modo, checksum) e extrai o .next
// O pacote contém só o resultado da compilação: o consumidor já tem o checkout do MESMO commit (verificado) e instala as
// dependências com npm ci; nada de node_modules, .env, credenciais, dados ou logs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { E2E_BUILD_ENV } from "../../tests/helpers/e2e-env.ts";

export const PACKAGE_FILE = "build.tar.gz";
/** Excluídos por serem dispensáveis à execução: cache incremental da compilação e rastros (trace) de diagnóstico. */
export const EXCLUDED = [/^\.next\/cache\//, /^\.next\/trace$/, /^\.next\/trace-build$/] as const;
/** Nunca podem ir no pacote. */
export const FORBIDDEN = [/(^|\/)\.env($|\.)/, /\.pem$/, /\.key$/, /(^|\/)service-account[^/]*\.json$/, /(^|\/)firebase-admin[^/]*\.json$/, /\.log$/] as const;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export type Manifest = {
  schema: "cantina-build-manifest/1";
  artifact: string;
  compiled_sha: string;
  github_sha: string;
  event: string;
  ref: string;
  pull_request: { head_sha: string | null; base_sha: string | null } | null;
  producer: { workflow: string; run_id: string; run_attempt: string; job: string };
  runtime: { node: string; npm: string | null; next: string; platform: string };
  lockfile_sha256: string;
  mode: "emulator";
  build_env: Record<string, string>;
  build_command: string;
  package: { file: string; sha256: string; size_bytes: number; files: number; uncompressed_bytes: number; excluded: string[]; symlinks: Symlink[] };
  created_at: string;
};

/** Link simbólico do build (Turbopack: .next/node_modules/<pacote>-<hash> -> ../../node_modules/<pacote>, para os
 *  serverExternalPackages). Necessário ao next start; o alvo é a dependência instalada pelo npm ci do consumidor. */
export type Symlink = { path: string; target: string };

/** Só aceita link RELATIVO, dentro de .next/, cujo alvo resolve para node_modules/ do projeto (nunca fora dele). */
export function symlinkProblem(path: string, target: string): string | null {
  if (!path.startsWith(".next/") || path.split("/").includes("..")) return `link fora de .next/: ${path}`;
  if (isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.startsWith("/")) return `link com alvo absoluto: ${path} -> ${target}`;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target.split("\\").join("/")));
  if (!resolved.startsWith("node_modules/") || resolved.split("/").includes("..")) return `link com alvo fora de node_modules/ do projeto: ${path} -> ${target}`;
  return null;
}

/** Links no tar (listagem -tv): cada um precisa constar do manifesto com o mesmo alvo e passar na regra de alvo. */
export function symlinkEntryProblems(verboseLines: string[], expected: Symlink[]): string[] {
  const problems: string[] = [];
  const found = verboseLines
    .filter((l) => l.startsWith("l"))
    .map((l) => {
      const arrow = l.lastIndexOf(" -> ");
      const start = l.indexOf(" .next/");
      return arrow > 0 && start > 0 ? { path: l.slice(start + 1, arrow), target: l.slice(arrow + 4).trim() } : { path: l, target: "" };
    });
  for (const link of found) {
    const problem = symlinkProblem(link.path, link.target);
    if (problem) problems.push(problem);
    if (!expected.some((e) => e.path === link.path && e.target === link.target)) problems.push(`link não declarado no manifesto: ${link.path}`);
  }
  if (found.length !== expected.length) problems.push(`links no pacote (${found.length}) ≠ manifesto (${expected.length})`);
  return problems;
}

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function listBuildFiles(root = ".next"): { files: string[]; bytes: number; problems: string[]; symlinks: Symlink[] } {
  const files: string[] = [];
  const problems: string[] = [];
  const symlinks: Symlink[] = [];
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(".", full).replace(/\\/g, "/");
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(full).split("\\").join("/");
        const problem = symlinkProblem(rel, target);
        if (problem) problems.push(problem);
        else {
          symlinks.push({ path: rel, target });
          files.push(rel);
        }
        continue;
      }
      if (stat.isDirectory()) {
        if (!EXCLUDED.some((p) => p.test(`${rel}/`))) walk(full);
        continue;
      }
      if (EXCLUDED.some((p) => p.test(rel))) continue;
      if (FORBIDDEN.some((p) => p.test(rel))) problems.push(`arquivo proibido no build: ${rel}`);
      if (stat.size < 5 * 1024 * 1024 && PRIVATE_KEY.test(readFileSync(full, "latin1"))) problems.push(`chave privada encontrada em ${rel}`);
      files.push(rel);
      bytes += stat.size;
    }
  };
  if (!existsSync(root)) problems.push(`${root} não existe: build ausente`);
  else walk(root);
  return { files: files.sort(), bytes, problems, symlinks: symlinks.sort((a, b) => a.path.localeCompare(b.path)) };
}

export type Actual = { runId: string; headSha: string; githubSha: string; lockfileSha256: string; nodeVersion: string; packageSha256: string | null; packageSize: number | null };

/** Validação do consumidor: qualquer divergência impede usar o build (nunca usa build de outro run/commit). */
export function validateManifest(m: Manifest, actual: Actual): string[] {
  const errors: string[] = [];
  const major = (v: string) => v.replace(/^v/, "").split(".")[0];
  if (m.schema !== "cantina-build-manifest/1") errors.push(`schema inesperado: ${String(m.schema)}`);
  if (m.producer.run_id !== actual.runId) errors.push(`build de outro run (${m.producer.run_id} ≠ ${actual.runId})`);
  if (m.compiled_sha !== actual.headSha) errors.push(`SHA compilado ${m.compiled_sha} ≠ código testado ${actual.headSha}`);
  if (m.github_sha !== actual.githubSha) errors.push(`GITHUB_SHA do produtor ${m.github_sha} ≠ ${actual.githubSha}`);
  if (m.lockfile_sha256 !== actual.lockfileSha256) errors.push("package-lock.json diferente do usado no build");
  if (major(m.runtime.node) !== major(actual.nodeVersion)) errors.push(`Node ${m.runtime.node} no build ≠ ${actual.nodeVersion} no consumidor`);
  if (m.mode !== "emulator") errors.push(`modo ${String(m.mode)} ≠ emulator`);
  if (JSON.stringify(m.build_env) !== JSON.stringify(E2E_BUILD_ENV)) errors.push("ambiente público do build difere do ambiente hermético do e2e");
  if (actual.packageSha256 === null) errors.push(`pacote ${m.package.file} ausente`);
  else if (actual.packageSha256 !== m.package.sha256) errors.push("checksum do pacote não confere");
  if (actual.packageSize !== null && actual.packageSize !== m.package.size_bytes) errors.push("tamanho do pacote não confere");
  return errors;
}

/** Entradas do tar: só dentro de .next/, sem caminho absoluto nem "..". */
export function unsafeEntries(entries: string[]): string[] {
  return entries.filter((e) => !e.startsWith(".next/") || e.split("/").includes("..") || e.startsWith("/") || /^[A-Za-z]:/.test(e));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const env = (name: string) => process.env[name] ?? "";
const summary = (text: string) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);

function pack() {
  const out = arg("out");
  const name = arg("name");
  const command = arg("build-command") ?? "";
  if (!out || !name || !/^[\w.-]+$/.test(name)) throw new Error("pack exige --out <dir> --name <artefato>");
  const { files, bytes, problems, symlinks } = listBuildFiles();
  if (problems.length) throw new Error(`pacote recusado:\n- ${problems.join("\n- ")}`);
  mkdirSync(out, { recursive: true });
  const listPath = join(out, "files.txt");
  writeFileSync(listPath, `${files.join("\0")}\0`);
  const tarPath = join(out, PACKAGE_FILE);
  execFileSync("tar", ["--null", "-czf", tarPath, "-T", listPath]);
  rmSync(listPath);
  const sha = (value: string) => (/^[0-9a-f]{40}$/.test(value) ? value : null);
  const manifest: Manifest = {
    schema: "cantina-build-manifest/1",
    artifact: name,
    compiled_sha: git("rev-parse", "HEAD"),
    github_sha: env("GITHUB_SHA"),
    event: env("GITHUB_EVENT_NAME"),
    ref: env("GITHUB_REF"),
    pull_request: env("GITHUB_EVENT_NAME").startsWith("pull_request") ? { head_sha: sha(env("PR_HEAD_SHA")), base_sha: sha(env("PR_BASE_SHA")) } : null,
    producer: { workflow: env("GITHUB_WORKFLOW"), run_id: env("GITHUB_RUN_ID"), run_attempt: env("GITHUB_RUN_ATTEMPT"), job: env("GITHUB_JOB") },
    runtime: {
      node: process.version,
      npm: (() => {
        try {
          return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
        } catch {
          return null;
        }
      })(),
      next: (JSON.parse(readFileSync("node_modules/next/package.json", "utf8")) as { version: string }).version,
      platform: `${process.platform}-${process.arch}`,
    },
    lockfile_sha256: sha256File("package-lock.json"),
    mode: "emulator",
    build_env: { ...E2E_BUILD_ENV },
    build_command: command,
    package: { file: PACKAGE_FILE, sha256: sha256File(tarPath), size_bytes: lstatSync(tarPath).size, files: files.length, uncompressed_bytes: bytes, excluded: EXCLUDED.map(String), symlinks },
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Pacote ${name}: ${files.length} arquivos, ${(manifest.package.size_bytes / 1_048_576).toFixed(1)} MB (${(bytes / 1_048_576).toFixed(1)} MB sem compressão), sha256 ${manifest.package.sha256}`);
  summary(`### Build compartilhado \`${name}\`\n\n- SHA compilado: \`${manifest.compiled_sha}\`${manifest.pull_request?.head_sha ? ` (merge de teste; head do PR \`${manifest.pull_request.head_sha}\`)` : ""}\n- Produtor: run ${manifest.producer.run_id}, tentativa ${manifest.producer.run_attempt}\n- Node ${manifest.runtime.node}, npm ${manifest.runtime.npm ?? "?"}, Next ${manifest.runtime.next}; modo emulator\n- ${files.length} arquivos; ${(manifest.package.size_bytes / 1_048_576).toFixed(1)} MB; sha256 \`${manifest.package.sha256}\`\n`);
}

function verify() {
  const dir = arg("dir");
  if (!dir) throw new Error("verify exige --dir <dir>");
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("manifest.json ausente no artefato do build");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const tarPath = join(dir, manifest.package?.file ?? PACKAGE_FILE);
  const present = existsSync(tarPath);
  const errors = validateManifest(manifest, {
    runId: env("GITHUB_RUN_ID"),
    headSha: git("rev-parse", "HEAD"),
    githubSha: env("GITHUB_SHA"),
    lockfileSha256: sha256File("package-lock.json"),
    nodeVersion: process.version,
    packageSha256: present ? sha256File(tarPath) : null,
    packageSize: present ? lstatSync(tarPath).size : null,
  });
  // Só inspeciona o tar depois que o checksum confere com o manifesto (não abre pacote adulterado).
  if (present && !errors.length) {
    const entries = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
    const verbose = execFileSync("tar", ["-tvzf", tarPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter(Boolean);
    errors.push(...symlinkEntryProblems(verbose, manifest.package.symlinks ?? []));
    const unsafe = unsafeEntries(entries);
    if (unsafe.length) errors.push(`entradas inseguras no pacote: ${unsafe.slice(0, 5).join(", ")}`);
    if (entries.filter((e) => !e.endsWith("/")).length !== manifest.package.files) errors.push("número de arquivos do pacote não confere com o manifesto");
  }
  if (existsSync(".next")) errors.push(".next já existe no consumidor: o build compartilhado não pode ser misturado a outra compilação");
  if (errors.length) throw new Error(`build compartilhado recusado:\n- ${errors.join("\n- ")}`);
  execFileSync("tar", ["-xzf", tarPath]);
  const consumed = {
    artifact: manifest.artifact,
    producer_run_id: manifest.producer.run_id,
    producer_attempt: manifest.producer.run_attempt,
    consumer_attempt: env("GITHUB_RUN_ATTEMPT"),
    compiled_sha: manifest.compiled_sha,
    package_sha256: manifest.package.sha256,
  };
  mkdirSync("ci-results", { recursive: true });
  writeFileSync("ci-results/build-consumed.json", `${JSON.stringify(consumed, null, 2)}\n`);
  console.log(`Build consumido: ${manifest.artifact} (produzido na tentativa ${manifest.producer.run_attempt}; consumidor na tentativa ${consumed.consumer_attempt}); SHA ${manifest.compiled_sha}`);
  summary(`Build consumido: \`${manifest.artifact}\` — produzido na tentativa ${manifest.producer.run_attempt}, consumido na tentativa ${consumed.consumer_attempt}, SHA \`${manifest.compiled_sha}\`, sha256 \`${manifest.package.sha256}\`\n\n`);
}

if (import.meta.main) {
  try {
    const command = process.argv[2];
    if (command === "env") for (const [k, v] of Object.entries(E2E_BUILD_ENV)) console.log(`${k}=${v}`);
    else if (command === "pack") pack();
    else if (command === "verify") verify();
    else {
      console.error("Uso: node scripts/ci/build-manifest.ts env | pack --out <dir> --name <artefato> [--build-command <cmd>] | verify --dir <dir>");
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
