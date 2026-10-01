import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { IdempotencyConflictError, PROBE_COLLECTION, runProbeCommand } from "@/modules/access/probe";

let db: Firestore;

beforeAll(() => {
  const app = getApps().find((a) => a.name === "probe-test") ?? initializeApp({ projectId: "demo-cantina" }, "probe-test");
  db = getFirestore(app);
});
afterAll(async () => {
  await db.terminate();
});

const newUid = () => `uid-${randomUUID().slice(0, 8)}`;
const newKey = () => randomUUID();

async function snapshotOf(uid: string) {
  const probe = await db.doc(`${PROBE_COLLECTION}/${uid}`).get();
  const entries = await db.collection(`${PROBE_COLLECTION}/${uid}/entries`).get();
  return {
    balance: probe.exists ? (probe.get("balanceCents") as number) : 0,
    version: probe.exists ? (probe.get("version") as number) : 0,
    entries: entries.docs.map((d) => d.get("amountCents") as number),
  };
}

describe("comando transacional de prova (A35)", () => {
  it("credita centavos, grava livro e saldo juntos", async () => {
    const uid = newUid();
    const result = await runProbeCommand(db, { uid }, { key: newKey(), amountCents: 500 });
    expect(result).toMatchObject({ balanceCents: 500, replayed: false });
    expect(await snapshotOf(uid)).toEqual({ balance: 500, version: 1, entries: [500] });
  });

  it("replay com mesma chave e payload devolve a resposta salva sem novo movimento nem efeito externo", async () => {
    const uid = newUid();
    const key = newKey();
    let effects = 0;
    const afterCommit = () => void effects++;
    const first = await runProbeCommand(db, { uid }, { key, amountCents: 300 }, { afterCommit });
    const again = await runProbeCommand(db, { uid }, { key, amountCents: 300 }, { afterCommit });
    expect(again).toEqual({ ...first, replayed: true });
    expect(effects).toBe(1);
    expect(await snapshotOf(uid)).toEqual({ balance: 300, version: 1, entries: [300] });
  });

  it("mesma chave com payload diferente é rejeitada e não altera nada", async () => {
    const uid = newUid();
    const key = newKey();
    await runProbeCommand(db, { uid }, { key, amountCents: 100 });
    await expect(runProbeCommand(db, { uid }, { key, amountCents: 200 })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await snapshotOf(uid)).toEqual({ balance: 100, version: 1, entries: [100] });
  });

  it("idempotência é por ator: mesma chave em outro uid é operação distinta", async () => {
    const key = newKey();
    const a = newUid();
    const b = newUid();
    await runProbeCommand(db, { uid: a }, { key, amountCents: 100 });
    const rb = await runProbeCommand(db, { uid: b }, { key, amountCents: 100 });
    expect(rb.replayed).toBe(false);
    expect((await snapshotOf(a)).balance).toBe(100);
    expect((await snapshotOf(b)).balance).toBe(100);
  });

  it("entradas inválidas são recusadas antes de qualquer escrita", async () => {
    const uid = newUid();
    for (const bad of [{ key: "curta", amountCents: 100 }, { key: newKey(), amountCents: 0 }, { key: newKey(), amountCents: 1.5 }, { key: newKey(), amountCents: -5 }, { key: newKey(), amountCents: 10_001 }, null]) {
      await expect(runProbeCommand(db, { uid }, bad)).rejects.toThrow();
    }
    expect(await snapshotOf(uid)).toEqual({ balance: 0, version: 0, entries: [] });
  });

  it("operações concorrentes com chaves distintas conservam o total; retries não duplicam efeito", async () => {
    const uid = newUid();
    const n = 12;
    let attempts = 0;
    let effects = 0;
    await Promise.all(
      Array.from({ length: n }, () =>
        runProbeCommand(db, { uid }, { key: newKey(), amountCents: 100 }, { onAttempt: () => void attempts++, afterCommit: () => void effects++ }),
      ),
    );
    const snap = await snapshotOf(uid);
    expect(snap.balance).toBe(n * 100);
    expect(snap.version).toBe(n);
    expect(snap.entries).toHaveLength(n);
    expect(effects).toBe(n);
    expect(attempts).toBeGreaterThanOrEqual(n); // callback pode reexecutar em contenção; efeitos não
    // Cada impasse de promoção leitura->escrita custa um lock timeout do emulador (~3,4 s): a disputa de 12 escritores leva
    // de ~4 a ~20 s. Timeout próprio do teste; a asserção de conservação e de efeitos não muda.
  }, 90000);

  it("disputa pela mesma chave produz exatamente um movimento e um efeito", async () => {
    const uid = newUid();
    const key = newKey();
    let effects = 0;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runProbeCommand(db, { uid }, { key, amountCents: 250 }, { afterCommit: () => void effects++ })),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.balanceCents))).toEqual(new Set([250]));
    expect(effects).toBe(1);
    expect(await snapshotOf(uid)).toEqual({ balance: 250, version: 1, entries: [250] });
  });

  it("falha no efeito externo não desfaz o commit e replay não repete o efeito", async () => {
    const uid = newUid();
    const key = newKey();
    await expect(
      runProbeCommand(db, { uid }, { key, amountCents: 100 }, { afterCommit: () => { throw new Error("email fora do ar"); } }),
    ).rejects.toThrow("email fora do ar");
    let effects = 0;
    const again = await runProbeCommand(db, { uid }, { key, amountCents: 100 }, { afterCommit: () => void effects++ });
    expect(again.replayed).toBe(true);
    expect(effects).toBe(0);
    expect(await snapshotOf(uid)).toEqual({ balance: 100, version: 1, entries: [100] });
  });
});
