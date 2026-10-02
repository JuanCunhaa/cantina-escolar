import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";

let env: RulesTestEnvironment;

async function as(uid: string, role: string, status: "active" | "disabled" = "active") {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { email: `${uid}@example.test`, displayName: uid, role, status, permissions: [], accessVersion: 1 });
  });
  return env.authenticatedContext(uid);
}

const OVERRIDE = "menuOverrides/2026-10-09__shf_manha";
const RULE = "defaultMenuRules/prd_suco";

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-cantina", firestore: { rules: readFileSync("firebase/firestore.rules", "utf8") } });
});
afterAll(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, RULE), { productId: "prd_suco", shiftIds: ["shf_manha"], version: 1 });
    await setDoc(doc(db, OVERRIDE), {
      date: "2026-10-09",
      shiftId: "shf_manha",
      suspended: false,
      serviceReason: "",
      items: { prd_pao: { include: "hidden", limit: null, reason: "Fornecedor não entrega" } },
      version: 1,
    });
  });
});

describe("Firestore rules — F07: configuração do cardápio", () => {
  it("cantina e administração leem (documento e lista); ninguém escreve pelo cliente, nem a administração", async () => {
    for (const [uid, role] of [["cant", "cantina"], ["adm", "admin"]] as const) {
      const db = (await as(uid, role)).firestore();
      await assertSucceeds(getDoc(doc(db, RULE)));
      await assertSucceeds(getDoc(doc(db, OVERRIDE)));
      await assertSucceeds(getDocs(collection(db, "defaultMenuRules")));
      await assertSucceeds(getDocs(query(collection(db, "menuOverrides"), where("date", ">=", "2026-10-01"))));
      await assertFails(setDoc(doc(db, RULE), { productId: "prd_suco", shiftIds: [], version: 2 }));
      await assertFails(updateDoc(doc(db, OVERRIDE), { suspended: true }));
      await assertFails(setDoc(doc(db, "menuOverrides/2026-10-10__shf_manha"), { date: "2026-10-10", items: {} }));
      await assertFails(deleteDoc(doc(db, OVERRIDE)));
    }
    expect(true).toBe(true);
  });

  it("família, aluno, secretaria, sem perfil, desativada e anônimo não leem (motivos internos; a família usa o cardápio resolvido)", async () => {
    const denied = [
      (await as("famA", "guardian")).firestore(),
      (await as("aluno", "student")).firestore(),
      (await as("sec", "secretaria")).firestore(),
      (await as("off", "admin", "disabled")).firestore(),
      env.authenticatedContext("semPerfil").firestore(),
      env.unauthenticatedContext().firestore(),
    ];
    for (const db of denied) {
      await assertFails(getDoc(doc(db, RULE)));
      await assertFails(getDoc(doc(db, OVERRIDE)));
      await assertFails(getDocs(collection(db, "defaultMenuRules")));
      await assertFails(getDocs(collection(db, "menuOverrides")));
      await assertFails(setDoc(doc(db, OVERRIDE), { suspended: true }));
    }
    expect(true).toBe(true);
  });
});
