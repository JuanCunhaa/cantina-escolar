import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where } from "firebase/firestore";

let env: RulesTestEnvironment;

async function as(uid: string, role: string, status: "active" | "disabled" = "active") {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { email: `${uid}@example.test`, displayName: uid, role, status, permissions: [], accessVersion: 1 });
  });
  return env.authenticatedContext(uid);
}

const QUANTITY_DOCS = [
  "stockBalances/prd_a",
  "stockBalances/prd_a/lots/lot1",
  "stockBalances/prd_a/reservations/res1",
  "dailyCapacity/prd_a_2026-10-09_shf_manha",
];
const COST_DOCS = ["stockCosts/prd_a", "stockCosts/prd_a/movements/m000000001", "stockReceipts/rcp_1"];

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-cantina", firestore: { rules: readFileSync("firebase/firestore.rules", "utf8") } });
});
afterAll(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "stockBalances/prd_a"), { productId: "prd_a", onHand: 10, reservedByDate: { "2026-10-09": 2 }, movementSeq: 1, version: 1 });
    await setDoc(doc(db, "stockBalances/prd_a/lots/lot1"), { productId: "prd_a", remaining: 10, openKey: "9999-12-31|2026-10-01|lot1" });
    await setDoc(doc(db, "stockBalances/prd_a/reservations/res1"), { productId: "prd_a", orderRef: "ord1", status: "active", quantity: 2 });
    await setDoc(doc(db, "dailyCapacity/prd_a_2026-10-09_shf_manha"), { productId: "prd_a", capacity: 20, reserved: 2, delivered: 0 });
    await setDoc(doc(db, "stockCosts/prd_a"), { productId: "prd_a", valueMicros: 1_000_000_000 });
    await setDoc(doc(db, "stockCosts/prd_a/movements/m000000001"), { seq: 1, type: "receipt", quantity: 10, totalCostMicros: 1_000_000_000 });
    await setDoc(doc(db, "stockReceipts/rcp_1"), { productId: "prd_a", unitCostMicros: 100_000_000, supplier: "Fornecedor interno" });
  });
});

describe("Firestore rules — F10: estoque", () => {
  it("cantina e administração leem as QUANTIDADES; ninguém escreve pelo cliente, nem a administração", async () => {
    for (const [uid, role] of [["cant", "cantina"], ["adm", "admin"]] as const) {
      const db = (await as(uid, role)).firestore();
      for (const path of QUANTITY_DOCS) {
        await assertSucceeds(getDoc(doc(db, path)));
        await assertFails(setDoc(doc(db, path), { onHand: 999 }));
        await assertFails(updateDoc(doc(db, path), { onHand: 999 }));
        await assertFails(deleteDoc(doc(db, path)));
      }
      await assertSucceeds(getDocs(collection(db, "stockBalances")));
      await assertSucceeds(getDocs(query(collection(db, "stockBalances/prd_a/lots"), orderBy("openKey"), limit(10))));
      await assertSucceeds(getDocs(query(collection(db, "stockBalances/prd_a/reservations"), where("status", "==", "active"))));
      await assertSucceeds(getDocs(query(collection(db, "dailyCapacity"), where("productId", "==", "prd_a"))));
      await assertFails(setDoc(doc(db, "stockBalances/prd_novo"), { onHand: 1 }));
    }
    expect(true).toBe(true);
  });

  it("CUSTOS (valor, livro com custo, entradas) nenhum papel lê pelo cliente, nem a administração: só a API com costs.read", async () => {
    for (const [uid, role] of [["adm", "admin"], ["cant", "cantina"], ["sec", "secretaria"]] as const) {
      const db = (await as(uid, role)).firestore();
      for (const path of COST_DOCS) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(setDoc(doc(db, path), { valueMicros: 0 }));
        await assertFails(deleteDoc(doc(db, path)));
      }
      await assertFails(getDocs(collection(db, "stockCosts")));
      await assertFails(getDocs(collection(db, "stockCosts/prd_a/movements")));
      await assertFails(getDocs(collection(db, "stockReceipts")));
    }
  });

  it("família, aluno, secretaria, desativada, sem perfil e anônimo não leem nada de estoque", async () => {
    const clients = [
      (await as("famA", "guardian")).firestore(),
      (await as("aluno", "student")).firestore(),
      (await as("sec", "secretaria")).firestore(),
      (await as("off", "admin", "disabled")).firestore(),
      env.authenticatedContext("semPerfil").firestore(),
      env.unauthenticatedContext().firestore(),
    ];
    for (const db of clients) {
      for (const path of [...QUANTITY_DOCS, ...COST_DOCS]) await assertFails(getDoc(doc(db, path)));
      await assertFails(getDocs(collection(db, "stockBalances")));
      await assertFails(getDocs(collection(db, "dailyCapacity")));
      await assertFails(setDoc(doc(db, "stockBalances/prd_a"), { onHand: 999 }));
    }
    expect(true).toBe(true);
  });
});
