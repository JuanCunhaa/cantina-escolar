import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyFiles, classifyRange } from "../../../scripts/ci/classify-changes.ts";

describe("classificação documental (lista explícita)", () => {
  it("só PROGRESS e registros de status dispensam o fluxo completo", () => {
    expect(classifyFiles(["PROGRESS.md", "docs/status/history.md", "docs/status/ci-baseline.md"]).mode).toBe("docs");
  });

  it.each([
    ["docs/tasks/F19.md"],
    ["CLAUDE.md"],
    ["AGENTS.md"],
    [".claude/skills/cantina-verify/SKILL.md"],
    ["docs/status/acceptance.json"],
    ["docs/status/sub/nota.md"],
    ["docs/decisions.md"],
    ["README.md"],
    [".github/workflows/ci.yml"],
    ["scripts/ci/classify-changes.ts"],
    ["vercel.json"],
    ["src/app/page.tsx"],
  ])("%s exige o fluxo completo, mesmo junto com documentação elegível", (file) => {
    expect(classifyFiles([file]).mode).toBe("full");
    expect(classifyFiles(["PROGRESS.md", file]).mode).toBe("full");
  });

  it("diff vazio é incerto e roda o fluxo completo", () => {
    expect(classifyFiles([]).mode).toBe("full");
  });
});

describe("classificação por intervalo de commits (git real)", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  let base: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "classify-"));
    git("init", "-q", "-b", "main");
    base = commit({ "PROGRESS.md": "a", "src/app.ts": "x", "docs/tasks/F01.md": "t" }, "base");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("vários commits só de documentação elegível => docs", () => {
    git("checkout", "-q", "-b", "doc", base);
    commit({ "PROGRESS.md": "b" }, "1");
    const head = commit({ "docs/status/novo.md": "c" }, "2");
    expect(classifyRange(base, head, repo)).toMatchObject({ mode: "docs", files: ["PROGRESS.md", "docs/status/novo.md"] });
  });

  it("merge que traz código entre commits documentais => full", () => {
    git("checkout", "-q", "-b", "code", base);
    commit({ "src/app.ts": "y" }, "codigo");
    git("checkout", "-q", "doc");
    git("-c", "user.name=t", "-c", "user.email=t@example.test", "merge", "-q", "--no-ff", "-m", "merge", "code");
    const head = commit({ "PROGRESS.md": "d" }, "3");
    expect(classifyRange(base, head, repo).mode).toBe("full");
  });

  it("alteração em docs/tasks => full", () => {
    git("checkout", "-q", "-b", "tasks", base);
    const head = commit({ "docs/tasks/F01.md": "aceite mudou" }, "t");
    expect(classifyRange(base, head, repo).mode).toBe("full");
  });

  it("renomear registro de status para fora da lista conta origem e destino => full", () => {
    git("checkout", "-q", "-b", "rename", base);
    commit({ "docs/status/a.md": "conteúdo longo o bastante para renomeação" }, "a");
    const before = git("rev-parse", "HEAD");
    git("mv", "docs/status/a.md", "src/a.md");
    const head = commit({}, "mv");
    expect(classifyRange(before, head, repo).mode).toBe("full");
  });

  it("Ignored Build Step da Vercel: 0 ignora só documentação; 1 constrói nos demais casos e em erro", () => {
    const script = join(process.cwd(), "scripts/ci/vercel-ignore.ts");
    const run = (previous: string | undefined, current: string) => {
      try {
        execFileSync(process.execPath, [script], { cwd: repo, env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: previous ?? "", VERCEL_GIT_COMMIT_SHA: current }, stdio: "pipe" });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    git("checkout", "-q", "-b", "vercel", base);
    const docs = commit({ "PROGRESS.md": "v" }, "docs");
    const code = commit({ "src/app.ts": "v" }, "code");
    expect(run(base, docs)).toBe(0);
    expect(run(base, code)).toBe(1);
    expect(run(undefined, docs)).toBe(1);
    expect(run("1234567890abcdef1234567890abcdef12345678", docs)).toBe(1);
  });

  it.each([
    ["base zerada (branch nova)", "0000000000000000000000000000000000000000"],
    ["base inexistente (push forçado/clone raso)", "1234567890abcdef1234567890abcdef12345678"],
    ["base ausente", undefined],
  ])("%s => full", (_label, ref) => {
    expect(classifyRange(ref, git("rev-parse", "HEAD"), repo).mode).toBe("full");
  });
});
