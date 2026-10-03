import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc } from "firebase/firestore";

let env: RulesTestEnvironment;

async function as(uid: string, role: string, status: "active" | "disabled" = "active") {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { email: `${uid}@example.test`, displayName: uid, role, status, permissions: [], accessVersion: 1 });
  });
  return env.authenticatedContext(uid);
}

const WALLET = "wallets/stu_a";
const ENTRY = "wallets/stu_a/entries/e1";

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-cantina", firestore: { rules: readFileSync("firebase/firestore.rules", "utf8") } });
});
afterAll(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "students/stu_a"), { name: "A", status: "active", userUid: "aluA" });
    await setDoc(doc(db, "students/stu_b"), { name: "B", status: "active", userUid: null });
    await setDoc(doc(db, "guardianStudentLinks/famA_stu_a"), { guardianUid: "famA", studentId: "stu_a", status: "active" });
    await setDoc(doc(db, "guardianStudentLinks/famRev_stu_a"), { guardianUid: "famRev", studentId: "stu_a", status: "revoked" });
    await setDoc(doc(db, "guardianStudentLinks/famB_stu_b"), { guardianUid: "famB", studentId: "stu_b", status: "active" });
    await setDoc(doc(db, WALLET), { studentId: "stu_a", balanceCents: 3750, version: 2 });
    await setDoc(doc(db, ENTRY), { seq: 1, type: "adjustment", amountCents: 5000, balanceAfterCents: 5000 });
    await setDoc(doc(db, "wallets/stu_b"), { studentId: "stu_b", balanceCents: 100, version: 1 });
    await setDoc(doc(db, "walletTransfers/trf_1"), { fromStudentId: "stu_a", toStudentId: "stu_b", amountCents: 1 });
  });
});

describe("Firestore rules — F08: carteira e livro", () => {
  it("o responsável com vínculo ativo lê a carteira e o extrato (consulta ordenada com limite) do próprio aluno", async () => {
    const db = (await as("famA", "guardian")).firestore();
    await assertSucceeds(getDoc(doc(db, WALLET)));
    await assertSucceeds(getDoc(doc(db, ENTRY)));
    await assertSucceeds(getDocs(query(collection(db, "wallets/stu_a/entries"), orderBy("seq", "desc"), limit(20))));
  });

  it("carteira de aluno sem movimento (documento inexistente) é legível pelo responsável vinculado; a de outra família não", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "students/stu_novo"), { name: "N", status: "active", userUid: null });
      await setDoc(doc(ctx.firestore(), "guardianStudentLinks/famA_stu_novo"), { guardianUid: "famA", studentId: "stu_novo", status: "active" });
    });
    await assertSucceeds(getDoc(doc((await as("famA", "guardian")).firestore(), "wallets/stu_novo")));
    await assertFails(getDoc(doc((await as("famB", "guardian")).firestore(), "wallets/stu_novo")));
  });

  it("outra família, vínculo revogado, aluno com login, equipe (inclusive administração), sem perfil, desativado e anônimo NÃO leem carteira nem livro", async () => {
    const denied = [
      (await as("famB", "guardian")).firestore(),
      (await as("famRev", "guardian")).firestore(),
      (await as("aluA", "student")).firestore(),
      (await as("cant", "cantina")).firestore(),
      (await as("sec", "secretaria")).firestore(),
      (await as("adm", "admin")).firestore(),
      env.authenticatedContext("semPerfil").firestore(),
      (await as("famA", "guardian", "disabled")).firestore(),
      env.unauthenticatedContext().firestore(),
    ];
    for (const db of denied) {
      await assertFails(getDoc(doc(db, WALLET)));
      await assertFails(getDoc(doc(db, ENTRY)));
      await assertFails(getDocs(query(collection(db, "wallets/stu_a/entries"), orderBy("seq", "desc"), limit(20))));
    }
  });

  it("ninguém lista carteiras nem lê transferências pelo cliente; o responsável não lê a carteira de outro aluno", async () => {
    const db = (await as("famA", "guardian")).firestore();
    await assertFails(getDocs(collection(db, "wallets")));
    await assertFails(getDoc(doc(db, "wallets/stu_b")));
    await assertFails(getDoc(doc(db, "walletTransfers/trf_1")));
    const adm = (await as("adm", "admin")).firestore();
    await assertFails(getDoc(doc(adm, "walletTransfers/trf_1")));
    await assertFails(getDocs(collection(adm, "wallets")));
  });

  it("nenhuma escrita financeira pelo cliente: saldo, versão, livro e transferências são negados a responsável e administração", async () => {
    for (const [uid, role] of [["famA", "guardian"], ["adm", "admin"], ["cant", "cantina"]] as const) {
      const db = (await as(uid, role)).firestore();
      await assertFails(updateDoc(doc(db, WALLET), { balanceCents: 999999 }));
      await assertFails(setDoc(doc(db, WALLET), { studentId: "stu_a", balanceCents: 999999, version: 3 }));
      await assertFails(setDoc(doc(db, "wallets/stu_novo"), { studentId: "stu_novo", balanceCents: 1, version: 1 }));
      await assertFails(setDoc(doc(db, "wallets/stu_a/entries/e2"), { seq: 2, type: "adjustment", amountCents: 100, balanceAfterCents: 3850 }));
      await assertFails(updateDoc(doc(db, ENTRY), { amountCents: 1 }));
      await assertFails(deleteDoc(doc(db, ENTRY)));
      await assertFails(deleteDoc(doc(db, WALLET)));
      await assertFails(setDoc(doc(db, "walletTransfers/trf_x"), { amountCents: 1 }));
    }
  });
});
