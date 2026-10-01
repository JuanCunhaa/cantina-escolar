import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { ref, uploadString, getBytes } from "firebase/storage";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-cantina",
    firestore: { rules: readFileSync("firebase/firestore.rules", "utf8") },
    storage: { rules: readFileSync("firebase/storage.rules", "utf8") },
  });
});
afterAll(async () => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "foundationProbes/familyA"), { balanceCents: 500 });
    await setDoc(doc(db, "foundationProbes/familyA/entries/e1"), { amountCents: 500 });
    await setDoc(doc(db, "foundationProbes/familyB"), { balanceCents: 900 });
    await setDoc(doc(db, "wallets/student1"), { balanceCents: 1000 });
    await setDoc(doc(db, "users/familyA"), { roles: ["guardian"] });
    await setDoc(doc(db, "idempotencyRecords/x"), { payloadHash: "h" });
  });
});

describe("Firestore rules — F01 (A33)", () => {
  it("dono lê somente o próprio documento e livro", async () => {
    const a = env.authenticatedContext("familyA").firestore();
    await assertSucceeds(getDoc(doc(a, "foundationProbes/familyA")));
    await assertSucceeds(getDoc(doc(a, "foundationProbes/familyA/entries/e1")));
    await assertSucceeds(getDocs(collection(a, "foundationProbes/familyA/entries")));
  });

  it("família B não lê dados da família A", async () => {
    const b = env.authenticatedContext("familyB").firestore();
    await assertFails(getDoc(doc(b, "foundationProbes/familyA")));
    await assertFails(getDoc(doc(b, "foundationProbes/familyA/entries/e1")));
    await assertFails(getDocs(collection(b, "foundationProbes/familyA/entries")));
  });

  it("não autenticado não lê nada", async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "foundationProbes/familyA")));
  });

  it("não há listagem ampla da coleção", async () => {
    const a = env.authenticatedContext("familyA").firestore();
    await assertFails(getDocs(collection(a, "foundationProbes")));
  });

  it("cliente nunca escreve saldo, livro ou documento alheio", async () => {
    const a = env.authenticatedContext("familyA").firestore();
    await assertFails(setDoc(doc(a, "foundationProbes/familyA"), { balanceCents: 999999 }));
    await assertFails(updateDoc(doc(a, "foundationProbes/familyA"), { balanceCents: 999999 }));
    await assertFails(deleteDoc(doc(a, "foundationProbes/familyA")));
    await assertFails(setDoc(doc(a, "foundationProbes/familyA/entries/e2"), { amountCents: 1 }));
    await assertFails(updateDoc(doc(a, "foundationProbes/familyA/entries/e1"), { amountCents: 1 }));
    await assertFails(setDoc(doc(a, "foundationProbes/familyB"), { balanceCents: 1 }));
  });

  it("demais coleções (carteira, papéis, idempotência) seguem deny-all, inclusive para o dono", async () => {
    const a = env.authenticatedContext("familyA").firestore();
    await assertFails(getDoc(doc(a, "wallets/student1")));
    await assertFails(setDoc(doc(a, "wallets/student1"), { balanceCents: 1 }));
    await assertFails(getDoc(doc(a, "users/familyA")));
    await assertFails(setDoc(doc(a, "users/familyA"), { roles: ["admin"] }));
    await assertFails(getDoc(doc(a, "idempotencyRecords/x")));
    await assertFails(setDoc(doc(a, "students/s1"), { name: "x" }));
    await assertFails(setDoc(doc(a, "stockBalances/p1"), { qty: 1000 }));
    await assertFails(setDoc(doc(a, "products/p1"), { priceCents: 1 }));
  });
});

describe("Storage rules — deny-all até a tarefa de fotos (A36)", () => {
  it("nega leitura e upload, autenticado ou não", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadString(ref(ctx.storage(), "products/p1.jpg"), "x");
    });
    for (const storage of [env.authenticatedContext("familyA").storage(), env.unauthenticatedContext().storage()]) {
      await assertFails(getBytes(ref(storage, "products/p1.jpg")));
      await assertFails(uploadString(ref(storage, "products/p2.jpg"), "y"));
      await assertFails(uploadString(ref(storage, "private/receipt.pdf"), "z"));
    }
  });
});
