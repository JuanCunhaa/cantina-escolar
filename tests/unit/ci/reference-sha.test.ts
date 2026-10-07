import { describe, expect, it } from "vitest";
import { referenceSha } from "../../../scripts/ci/reference-sha.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const base = { repo: "o/r", workflowRef: "o/r/.github/workflows/ci.yml@refs/heads/main", branch: "main", runId: 3 };

describe("referência da classificação documental", () => {
  it("PR usa a base do PR", async () => {
    expect(await referenceSha({ ...base, event: "pull_request", prBase: A, fetcher: async () => ({}) })).toEqual({ sha: A, reason: "base do PR" });
    expect((await referenceSha({ ...base, event: "pull_request", prBase: "", fetcher: async () => ({}) })).sha).toBe("");
  });

  it("push usa o último run VERDE do workflow no ref (não o push anterior, que pode ter sido cancelado)", async () => {
    let asked = "";
    const fetcher = async (path: string) => {
      asked = path;
      return { workflow_runs: [{ id: 3, head_sha: B, conclusion: "success", status: "completed" }, { id: 2, head_sha: A, conclusion: "success", status: "completed" }] };
    };
    expect(await referenceSha({ ...base, event: "push", fetcher })).toEqual({ sha: A, reason: "último run verde 2" });
    expect(asked).toBe("repos/o/r/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=10");
  });

  it("sem run verde anterior, workflow desconhecido ou outro evento => sem referência (fluxo completo)", async () => {
    expect((await referenceSha({ ...base, event: "push", fetcher: async () => ({ workflow_runs: [] }) })).sha).toBe("");
    expect((await referenceSha({ ...base, event: "push", workflowRef: "x", fetcher: async () => ({}) })).sha).toBe("");
    expect((await referenceSha({ ...base, event: "workflow_dispatch", fetcher: async () => ({}) })).sha).toBe("");
  });
});
