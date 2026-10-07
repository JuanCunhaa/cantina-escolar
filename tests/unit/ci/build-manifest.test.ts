import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, symlinkEntryProblems, symlinkProblem, unsafeEntries, validateManifest, type Manifest } from "../../../scripts/ci/build-manifest.ts";
import { E2E_BUILD_ENV } from "../../helpers/e2e-env.ts";


describe("build compartilhado: pacote, manifesto e validação no consumidor", () => {
  let dir: string;
  let sha: string;
  // Em processo (cobertura real); o CLI só repassa argv/ambiente para main().
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    try {
      const env = { GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: sha, GITHUB_EVENT_NAME: "pull_request", PR_HEAD_SHA: "a".repeat(40), PR_BASE_SHA: "b".repeat(40), ...extraEnv };
      const status = main(args, { root: dir, env, log: (text) => logs.push(text) });
      return { status, out: logs.join("\n") };
    } finally {
      spy.mockRestore();
    }
  };
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "build-"));
    write("package-lock.json", '{"lockfileVersion":3}');
    write("node_modules/next/package.json", '{"version":"16.3.8"}');
    write(".gitignore", ".next/\nnode_modules/\nout/\nci-results/\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "x"], { cwd: dir });
    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    write(".next/BUILD_ID", "abc");
    write(".next/server/app/page.js", "export default 1");
    write(".next/cache/webpack/x.pack", "cache");
    write(".next/trace", "trace");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("empacota sem cache/trace, registra a origem e o consumidor do mesmo run/commit extrai", () => {
    expect(run(["pack", "--out", "out", "--name", "build-100-a1", "--build-command", "npm run build"]).status).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, "out/manifest.json"), "utf8")) as Manifest;
    expect(m).toMatchObject({ artifact: "build-100-a1", compiled_sha: sha, mode: "emulator", producer: { run_id: "100", run_attempt: "1" }, pull_request: { head_sha: "a".repeat(40) } });
    expect(m.package.files).toBe(2);
    expect(m.build_env).toEqual(E2E_BUILD_ENV);
    rmSync(join(dir, ".next"), { recursive: true });
    const consumer = run(["verify", "--dir", "out"], { GITHUB_RUN_ATTEMPT: "2" });
    expect(consumer.status).toBe(0);
    expect(consumer.out).toContain("produzido na tentativa 1; consumidor na tentativa 2");
    expect(readFileSync(join(dir, ".next/server/app/page.js"), "utf8")).toBe("export default 1");
    expect(existsSync(join(dir, ".next/cache"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "ci-results/build-consumed.json"), "utf8"))).toMatchObject({ artifact: "build-100-a1", producer_attempt: "1", consumer_attempt: "2" });
  });

  it("consumidor recusa build de outro run, pacote adulterado e .next pré-existente", () => {
    run(["pack", "--out", "out", "--name", "build-100-a1"]);
    expect(run(["verify", "--dir", "out"]).out).toContain(".next já existe");
    rmSync(join(dir, ".next"), { recursive: true });
    expect(run(["verify", "--dir", "out"], { GITHUB_RUN_ID: "999" }).out).toContain("build de outro run (100 ≠ 999)");
    appendFileSync(join(dir, "out/build.tar.gz"), "x");
    const tampered = run(["verify", "--dir", "out"]);
    expect(tampered.status).toBe(1);
    expect(tampered.out).toContain("checksum do pacote não confere");
    expect(existsSync(join(dir, ".next"))).toBe(false);
  });

  it("consumidor de outro commit (novo push) recusa", () => {
    run(["pack", "--out", "out", "--name", "build-100-a1"]);
    rmSync(join(dir, ".next"), { recursive: true });
    write("novo.txt", "1");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "novo"], { cwd: dir });
    expect(run(["verify", "--dir", "out"]).out).toMatch(/SHA compilado [0-9a-f]{40} ≠ código testado/);
  });

  it.each([[".next/server/.env.production"], [".next/server/app.log"], [".next/service-account-hml.json"]])("recusa empacotar %s", (file) => {
    write(file, "x");
    const result = run(["pack", "--out", "out", "--name", "b"]);
    expect(result.status).toBe(1);
    expect(result.out).toContain("pacote recusado");
  });

  it("recusa chave privada embutida em arquivo do build", () => {
    write(".next/server/chunk.js", 'const k="-----BEGIN PRIVATE KEY-----\\nMIIE"');
    expect(run(["pack", "--out", "out", "--name", "b"]).out).toContain("chave privada encontrada em .next/server/chunk.js");
  });

  it("links relativos do Turbopack para node_modules/ entram no pacote e no manifesto; link para fora é recusado", () => {
    // Forma medida no CI (P1): .next/node_modules/firebase-admin-<hash> -> ../../node_modules/firebase-admin.
    let linked = true;
    try {
      mkdirSync(join(dir, ".next/node_modules"), { recursive: true });
      symlinkSync("../../node_modules/next", join(dir, ".next/node_modules/next-abc123"), "dir");
    } catch {
      linked = false; // Windows sem permissão de link: a regra é coberta pelos testes puros abaixo
    }
    if (linked) {
      expect(run(["pack", "--out", "out", "--name", "b"]).status).toBe(0);
      const m = JSON.parse(readFileSync(join(dir, "out/manifest.json"), "utf8")) as Manifest;
      expect(m.package.symlinks).toEqual([{ path: ".next/node_modules/next-abc123", target: "../../node_modules/next" }]);
      rmSync(join(dir, ".next"), { recursive: true });
      expect(run(["verify", "--dir", "out"]).status).toBe(0);
      rmSync(join(dir, ".next"), { recursive: true });
      mkdirSync(join(dir, ".next/node_modules"), { recursive: true });
      write(".next/BUILD_ID", "abc");
      symlinkSync("../../../fora", join(dir, ".next/node_modules/fora"), "dir");
      expect(run(["pack", "--out", "out2", "--name", "b"]).out).toContain("link com alvo fora de node_modules/ do projeto");
    }
    expect(symlinkProblem(".next/node_modules/x-1", "../../node_modules/x")).toBeNull();
    expect(symlinkProblem(".next/node_modules/x-1", "/usr/lib/x")).toContain("alvo absoluto");
    expect(symlinkProblem(".next/node_modules/x-1", "../../../etc")).toContain("fora de node_modules/");
    expect(symlinkProblem(".next/node_modules/x-1", "../../src")).toContain("fora de node_modules/");
  });

  it("build ausente não gera pacote", () => {
    rmSync(join(dir, ".next"), { recursive: true });
    expect(run(["pack", "--out", "out", "--name", "b"]).out).toContain(".next não existe");
  });
});

describe("regras puras do manifesto", () => {
  const base: Manifest = {
    schema: "cantina-build-manifest/1",
    artifact: "build-1-a1",
    compiled_sha: "c".repeat(40),
    github_sha: "c".repeat(40),
    event: "push",
    ref: "refs/heads/main",
    pull_request: null,
    producer: { workflow: "ci", run_id: "1", run_attempt: "1", job: "build" },
    runtime: { node: "v24.12.0", npm: "11.0.0", next: "16.3.8", platform: "linux-x64" },
    lockfile_sha256: "l",
    mode: "emulator",
    build_env: { ...E2E_BUILD_ENV },
    build_command: "npm run build",
    package: { file: "build.tar.gz", sha256: "p", size_bytes: 10, files: 1, uncompressed_bytes: 20, excluded: [], symlinks: [] },
    created_at: "x",
  };
  const actual = { runId: "1", headSha: "c".repeat(40), githubSha: "c".repeat(40), lockfileSha256: "l", nodeVersion: "v24.20.0", packageSha256: "p", packageSize: 10 };

  it("aceita só quando tudo confere", () => {
    expect(validateManifest(base, actual)).toEqual([]);
    expect(validateManifest(base, { ...actual, lockfileSha256: "z" })).toEqual(["package-lock.json diferente do usado no build"]);
    expect(validateManifest(base, { ...actual, nodeVersion: "v22.1.0" })).toEqual(["Node v24.12.0 no build ≠ v22.1.0 no consumidor"]);
    expect(validateManifest({ ...base, build_env: { ...base.build_env, APP_ENV: "production" } }, actual)).toEqual(["ambiente público do build difere do ambiente hermético do e2e"]);
    expect(validateManifest(base, { ...actual, packageSha256: null, packageSize: null })).toEqual(["pacote build.tar.gz ausente"]);
  });

  it("links do tar precisam constar do manifesto com o mesmo alvo", () => {
    const line = "lrwxrwxrwx runner/runner 0 2026-10-07 04:47 .next/node_modules/firebase-admin-a1 -> ../../node_modules/firebase-admin";
    const declared = [{ path: ".next/node_modules/firebase-admin-a1", target: "../../node_modules/firebase-admin" }];
    expect(symlinkEntryProblems([line, "-rw-r--r-- runner/runner 3 2026-10-07 04:47 .next/BUILD_ID"], declared)).toEqual([]);
    expect(symlinkEntryProblems([line], [])).toEqual(["link não declarado no manifesto: .next/node_modules/firebase-admin-a1", "links no pacote (1) ≠ manifesto (0)"]);
    expect(symlinkEntryProblems([line.replace("../../node_modules/firebase-admin", "/etc")], declared)[0]).toContain("alvo absoluto");
  });

  it("entradas fora de .next/, absolutas ou com .. são inseguras", () => {
    expect(unsafeEntries([".next/a", ".next/../x", "/etc/passwd", "src/a.ts", "C:/x", ".next/b/"])).toEqual([".next/../x", "/etc/passwd", "src/a.ts", "C:/x"]);
  });
});
