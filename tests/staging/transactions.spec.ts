// Comando transacional existente (prova de fundação /api/probe: idempotência + livro imutável + saldo na mesma transação)
// no Firestore real. Não é a carteira (F08); serve para medir disputa de lock e conservação de saldo fora do emulador.
import { expect, test } from "@playwright/test";
import { createTestUser } from "../helpers/auth-emulator";
import { bearer, fsRequest, newKey } from "./helpers";

test.describe.configure({ mode: "serial" });

const balanceOf = async (idToken: string, uid: string): Promise<number> => {
  const { status, body } = await fsRequest(idToken, "GET", `foundationProbes/${uid}`);
  expect(status).toBe(200);
  return Number((body.fields as { balanceCents: { integerValue: string } }).balanceCents.integerValue);
};

test("idempotência: mesma chave = mesmo resultado sem duplicar; corpo diferente com a mesma chave = 409 (A35)", async ({ request }) => {
  const user = await createTestUser("hml-prova", "guardian");
  const key = newKey("probe");
  const first = await request.post("/api/probe", { headers: bearer(user.idToken), data: { key, amountCents: 500 } });
  expect(first.status()).toBe(200);
  const a = (await first.json()) as { entryId: string; balanceCents: number; replayed: boolean };
  expect(a).toMatchObject({ balanceCents: 500, replayed: false });
  const again = await request.post("/api/probe", { headers: bearer(user.idToken), data: { key, amountCents: 500 } });
  expect(await again.json()).toMatchObject({ entryId: a.entryId, balanceCents: 500, replayed: true });
  const conflict = await request.post("/api/probe", { headers: bearer(user.idToken), data: { key, amountCents: 700 } });
  expect(conflict.status()).toBe(409);
  expect(await balanceOf(user.idToken, user.uid)).toBe(500);
});

test("concorrência no mesmo documento: 12 escritores simultâneos conservam o saldo (A35)", async ({ request }) => {
  test.setTimeout(240_000);
  const user = await createTestUser("hml-conc", "guardian");
  const writers = 12;
  const started = Date.now();
  const responses = await Promise.all(
    Array.from({ length: writers }, (_, i) =>
      request.post("/api/probe", { headers: bearer(user.idToken), data: { key: newKey(`c${i}`), amountCents: 100 + i } }),
    ),
  );
  const elapsedMs = Date.now() - started;
  const statuses = responses.map((r) => r.status());
  console.log(`concorrência real: ${writers} escritores, ${elapsedMs} ms, status ${JSON.stringify(statuses)}`);
  expect(statuses.every((s) => s === 200), JSON.stringify(statuses)).toBe(true);
  const expected = Array.from({ length: writers }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
  expect(await balanceOf(user.idToken, user.uid)).toBe(expected);
  // Livro: uma entrada por comando, imutável (cliente não escreve).
  const entries = await fsRequest(user.idToken, "GET", `foundationProbes/${user.uid}/entries`);
  expect(entries.status).toBe(200);
  expect((entries.body.documents as unknown[]).length).toBe(writers);
  const tamper = await fsRequest(user.idToken, "PATCH", `foundationProbes/${user.uid}`, { balanceCents: { integerValue: "1" } });
  expect(tamper.status).toBe(403);
});
