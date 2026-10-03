import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, where } from "firebase/firestore";

let env: RulesTestEnvironment;

async function as(uid: string, role: string, status: "active" | "disabled" = "active") {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { email: `${uid}@example.test`, displayName: uid, role, status, permissions: [], accessVersion: 1 });
  });
  return env.authenticatedContext(uid);
}

const DAY = "studentUsage/stu_a/days/2026-10-05";
const WEEK = "studentUsage/stu_a/weeks/2026-10-05";
const EXC = "studentPolicies/stu_a/exceptions/exc_1";

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-cantina", firestore: { rules: readFileSync("firebase/firestore.rules", "utf8") } });
});
afterAll(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "students/stu_a"), { name: "A", status: "active", userUid: "aluA" });
    await setDoc(doc(db, "students/stu_b"), { name: "B", status: "active", userUid: "aluB" });
    await setDoc(doc(db, "guardianStudentLinks/famA_stu_a"), { guardianUid: "famA", studentId: "stu_a", status: "active" });
    await setDoc(doc(db, "guardianStudentLinks/famRev_stu_a"), { guardianUid: "famRev", studentId: "stu_a", status: "revoked" });
    await setDoc(doc(db, "guardianStudentLinks/famB_stu_b"), { guardianUid: "famB", studentId: "stu_b", status: "active" });
    await setDoc(doc(db, "studentPolicies/stu_a"), { allowSitePurchase: true, dailyLimitCents: 1000, weeklyLimitCents: 3000, blockedProductIds: ["p1"], configVersion: 2 });
    await setDoc(doc(db, DAY), { studentId: "stu_a", date: "2026-10-05", committedCents: 800 });
    await setDoc(doc(db, WEEK), { studentId: "stu_a", weekStart: "2026-10-05", committedCents: 800 });
    await setDoc(doc(db, "studentUsage/stu_b/days/2026-10-05"), { studentId: "stu_b", date: "2026-10-05", committedCents: 100 });
    await setDoc(doc(db, EXC), { studentId: "stu_a", kind: "admin", status: "active", consumptionDate: "2026-10-05", maxCents: 500, reason: "motivo interno" });
  });
});

describe("Firestore rules — F09: limites, uso por data e exceções", () => {
  it("família vinculada, o próprio aluno, cantina e administração leem o uso do aluno (dia/semana, inclusive consulta por data)", async () => {
    for (const [uid, role] of [["famA", "guardian"], ["aluA", "student"], ["cant", "cantina"], ["adm", "admin"]] as const) {
      const db = (await as(uid, role)).firestore();
      await assertSucceeds(getDoc(doc(db, DAY)));
      await assertSucceeds(getDoc(doc(db, WEEK)));
      await assertSucceeds(getDocs(query(collection(db, "studentUsage/stu_a/days"), where("date", ">=", "2026-10-01"), orderBy("date"))));
      await assertSucceeds(getDocs(collection(db, "studentUsage/stu_a/weeks")));
    }
  });

  it("outra família, vínculo revogado, aluno de outra conta, secretaria, sem perfil, desativado e anônimo NÃO leem o uso nem listam", async () => {
    const denied = [
      (await as("famB", "guardian")).firestore(),
      (await as("famRev", "guardian")).firestore(),
      (await as("aluB", "student")).firestore(),
      (await as("sec", "secretaria")).firestore(),
      env.authenticatedContext("semPerfil").firestore(),
      (await as("famA", "guardian", "disabled")).firestore(),
      env.unauthenticatedContext().firestore(),
    ];
    for (const db of denied) {
      await assertFails(getDoc(doc(db, DAY)));
      await assertFails(getDoc(doc(db, WEEK)));
      await assertFails(getDocs(collection(db, "studentUsage/stu_a/days")));
    }
  });

  it("nenhuma escrita de uso pelo cliente (nem família, nem equipe, nem administração): limite não é contornável direto", async () => {
    for (const [uid, role] of [["famA", "guardian"], ["aluA", "student"], ["cant", "cantina"], ["adm", "admin"]] as const) {
      const db = (await as(uid, role)).firestore();
      await assertFails(setDoc(doc(db, DAY), { studentId: "stu_a", date: "2026-10-05", committedCents: 0 }));
      await assertFails(updateDoc(doc(db, DAY), { committedCents: 0 }));
      await assertFails(setDoc(doc(db, "studentUsage/stu_a/days/2026-10-06"), { committedCents: 1 }));
      await assertFails(deleteDoc(doc(db, WEEK)));
      await assertFails(setDoc(doc(db, "studentUsage/stu_a/outro/x"), { committedCents: 1 }));
      await assertFails(getDoc(doc(db, "studentUsage/stu_a/outro/x")));
    }
  });

  it("a política (limites/bloqueios) segue legível por quem já lia e nunca escrita pelo cliente", async () => {
    await assertSucceeds(getDoc(doc((await as("famA", "guardian")).firestore(), "studentPolicies/stu_a")));
    await assertSucceeds(getDoc(doc((await as("aluA", "student")).firestore(), "studentPolicies/stu_a")));
    await assertSucceeds(getDoc(doc((await as("cant", "cantina")).firestore(), "studentPolicies/stu_a")));
    await assertFails(getDoc(doc((await as("famB", "guardian")).firestore(), "studentPolicies/stu_a")));
    for (const [uid, role] of [["famA", "guardian"], ["adm", "admin"], ["aluA", "student"]] as const) {
      const db = (await as(uid, role)).firestore();
      await assertFails(updateDoc(doc(db, "studentPolicies/stu_a"), { dailyLimitCents: 999999 }));
      await assertFails(updateDoc(doc(db, "studentPolicies/stu_a"), { blockedProductIds: [] }));
    }
  });

  it("exceções: só o responsável vinculado e a administração leem; aluno, cantina, secretaria, outra família e anônimo não; ninguém escreve", async () => {
    await assertSucceeds(getDoc(doc((await as("famA", "guardian")).firestore(), EXC)));
    await assertSucceeds(getDoc(doc((await as("adm", "admin")).firestore(), EXC)));
    await assertSucceeds(getDocs(collection((await as("famA", "guardian")).firestore(), "studentPolicies/stu_a/exceptions")));
    for (const db of [
      (await as("aluA", "student")).firestore(),
      (await as("cant", "cantina")).firestore(),
      (await as("sec", "secretaria")).firestore(),
      (await as("famB", "guardian")).firestore(),
      (await as("famRev", "guardian")).firestore(),
      env.unauthenticatedContext().firestore(),
    ]) {
      await assertFails(getDoc(doc(db, EXC)));
      await assertFails(getDocs(collection(db, "studentPolicies/stu_a/exceptions")));
    }
    for (const [uid, role] of [["famA", "guardian"], ["adm", "admin"], ["cant", "cantina"]] as const) {
      const db = (await as(uid, role)).firestore();
      await assertFails(setDoc(doc(db, "studentPolicies/stu_a/exceptions/exc_2"), { studentId: "stu_a", kind: "guardian", status: "active", maxCents: 99999 }));
      await assertFails(updateDoc(doc(db, EXC), { maxCents: 99999 }));
      await assertFails(deleteDoc(doc(db, EXC)));
    }
  });
});
