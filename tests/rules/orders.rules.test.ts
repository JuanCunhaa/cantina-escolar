import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";

let env: RulesTestEnvironment;

async function as(uid: string, role: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { email: `${uid}@example.test`, displayName: uid, role, status: "active", permissions: [], accessVersion: 1 });
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
    await setDoc(doc(db, "students/stu_a"), { name: "A", status: "active", userUid: "aluA" });
    await setDoc(doc(db, "guardianStudentLinks/famA_stu_a"), { guardianUid: "famA", studentId: "stu_a", status: "active" });
    await setDoc(doc(db, "orders/ord_1"), { orderId: "ord_1", studentId: "stu_a", status: "paid", totalCents: 800, consumptionDate: "2026-10-05" });
  });
});

/**
 * F11 cria pedidos só pelo servidor (Admin SDK). A leitura de pedidos pelo cliente (Meus pedidos, listeners) é da F12 e
 * ainda NÃO tem regra: pedidos ficam fechados para qualquer cliente — nem a família dona, nem a equipe, nem a
 * administração — e nenhum cliente escreve. Garantia de default-deny publicada na main/homologação sem alterar Rules.
 */
describe("Firestore rules — F11: pedidos são só do servidor", () => {
  it("nenhum cliente lê, lista, cria, altera ou apaga pedido (família dona, outra família, aluno, equipe, admin, anônimo)", async () => {
    const contexts = [await as("famA", "guardian"), await as("famB", "guardian"), await as("aluA", "student"), await as("cant", "cantina"), await as("sec", "secretaria"), await as("adm", "admin"), env.unauthenticatedContext()];
    for (const ctx of contexts) {
      const db = ctx.firestore();
      await assertFails(getDoc(doc(db, "orders/ord_1")));
      await assertFails(getDocs(query(collection(db, "orders"), where("studentId", "==", "stu_a"))));
      await assertFails(setDoc(doc(db, "orders/ord_2"), { studentId: "stu_a", status: "paid", totalCents: 1 }));
      await assertFails(updateDoc(doc(db, "orders/ord_1"), { status: "cancelled" }));
      await assertFails(deleteDoc(doc(db, "orders/ord_1")));
    }
  });

  it("o cliente não grava débito, livro, uso nem reserva (escrita financeira do cliente negada)", async () => {
    const db = (await as("famA", "guardian")).firestore();
    await assertFails(setDoc(doc(db, "wallets/stu_a/entries/e_x"), { type: "advance_purchase", seq: 1, amountCents: -800, balanceAfterCents: 0 }));
    await assertFails(setDoc(doc(db, "wallets/stu_a"), { studentId: "stu_a", balanceCents: 0, version: 1 }));
    await assertFails(setDoc(doc(db, "studentUsage/stu_a/days/2026-10-05"), { committedCents: 0 }));
    await assertFails(setDoc(doc(db, "stockBalances/p1/reservations/r1"), { quantity: 1 }));
    await assertFails(setDoc(doc(db, "dailyCapacity/p1_2026-10-05_shf"), { reserved: 0 }));
  });
});
