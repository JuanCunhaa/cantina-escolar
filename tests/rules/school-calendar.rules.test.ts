import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

let env: RulesTestEnvironment;

async function as(uid: string, role: string, status: "active" | "disabled" = "active") {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { email: `${uid}@example.test`, displayName: uid, role, status, permissions: [], accessVersion: 1 });
  });
  return env.authenticatedContext(uid);
}

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-cantina", firestore: { rules: readFileSync("firebase/firestore.rules", "utf8") } });
});
afterAll(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "settings/school"), { schoolName: "Escola Teste", weekdays: [1, 2, 3, 4, 5], shiftPolicies: {}, version: 1 });
    await setDoc(doc(db, "calendarDays/2026-10-10"), { date: "2026-10-10", kind: "extra", reason: "Sábado letivo" });
  });
});

describe("Firestore rules — F05: configurações da escola e calendário (A14)", () => {
  it("leitura por conta com perfil ativo; escrita nunca pelo cliente (nem administração); sem perfil/desativada negadas", async () => {
    const guardian = (await as("gA", "guardian")).firestore();
    const admin = (await as("adm", "admin")).firestore();
    for (const db of [guardian, admin]) {
      await assertSucceeds(getDoc(doc(db, "settings/school")));
      await assertSucceeds(getDoc(doc(db, "calendarDays/2026-10-10")));
      await assertSucceeds(getDocs(collection(db, "calendarDays")));
      await assertFails(setDoc(doc(db, "settings/school"), { schoolName: "Outra", version: 2 }));
      await assertFails(updateDoc(doc(db, "settings/school"), { weekdays: [0] }));
      await assertFails(setDoc(doc(db, "calendarDays/2026-10-11"), { kind: "extra" }));
      await assertFails(deleteDoc(doc(db, "calendarDays/2026-10-10")));
      await assertFails(getDocs(collection(db, "settings")));
    }
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "settings/school")));
    await assertFails(getDoc(doc(env.authenticatedContext("semPerfil").firestore(), "calendarDays/2026-10-10")));
    await assertFails(getDoc(doc((await as("off", "guardian", "disabled")).firestore(), "settings/school")));
    expect(true).toBe(true);
  });
});
