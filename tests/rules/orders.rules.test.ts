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

/**
 * F13 grava entregas em `orders/{id}/deliveries` (movimentos de estoque, ator) só pelo servidor: sem regra nova, o
 * default-deny cobre a subcoleção — nem a equipe que entrega nem a família dona leem ou escrevem direto.
 */
describe("Firestore rules — F13: entregas e progresso do pedido são só do servidor", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ord_1/deliveries/dlv_1"), { orderId: "ord_1", studentId: "stu_a", seq: 1, lines: [{ lineNo: 1, movementId: "m000000001" }], actorUid: "cant" });
    });
  });

  it("nenhum cliente lê, lista, cria, altera ou apaga entrega (família dona, aluno, cantina, secretaria, admin, anônimo)", async () => {
    const contexts = [await as("famA", "guardian"), await as("famB", "guardian"), await as("aluA", "student"), await as("cant", "cantina"), await as("sec", "secretaria"), await as("adm", "admin"), env.unauthenticatedContext()];
    for (const ctx of contexts) {
      const db = ctx.firestore();
      await assertFails(getDoc(doc(db, "orders/ord_1/deliveries/dlv_1")));
      await assertFails(getDocs(collection(db, "orders/ord_1/deliveries")));
      await assertFails(setDoc(doc(db, "orders/ord_1/deliveries/dlv_2"), { orderId: "ord_1", seq: 2 }));
      await assertFails(updateDoc(doc(db, "orders/ord_1/deliveries/dlv_1"), { totalUnits: 99 }));
      await assertFails(deleteDoc(doc(db, "orders/ord_1/deliveries/dlv_1")));
      // A equipe também não entrega nem resolve pelo cliente: progresso do pedido é do servidor.
      await assertFails(updateDoc(doc(db, "orders/ord_1"), { status: "delivered", deliveredQty: 1 }));
    }
  });

  it("estoque e custos seguem fechados a escrita do cliente (baixa só pelo StockSession no servidor)", async () => {
    for (const role of ["cantina", "admin"]) {
      const db = (await as(`u_${role}`, role)).firestore();
      await assertFails(setDoc(doc(db, "stockBalances/p1"), { onHand: 0 }));
      await assertFails(setDoc(doc(db, "stockCosts/p1/movements/m000000001"), { type: "sale_exit", quantity: -1 }));
      await assertFails(setDoc(doc(db, "dailyCapacity/p1_2026-10-05_shf"), { delivered: 5 }));
    }
  });
});

/**
 * F14 grava cancelamentos em `orders/{id}/cancellations` (valor, motivo, ator, descartes) e o reembolso em
 * `wallets/{aluno}/entries` só pelo servidor: sem regra nova, o default-deny cobre a subcoleção, e o crédito/saldo da carteira
 * segue sem escrita do cliente (responsável dono incluso).
 */
describe("Firestore rules — F14: cancelamento e reembolso são só do servidor", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "orders/ord_1/cancellations/can_1"), { orderId: "ord_1", studentId: "stu_a", seq: 1, kind: "family", refundCents: 500, reason: "Mudança de planos", actorUid: "famA" });
    });
  });

  it("nenhum cliente lê, lista, cria, altera ou apaga cancelamento, nem se cancela/reembolsa direto no pedido", async () => {
    const contexts = [await as("famA", "guardian"), await as("famB", "guardian"), await as("aluA", "student"), await as("cant", "cantina"), await as("sec", "secretaria"), await as("adm", "admin"), env.unauthenticatedContext()];
    for (const ctx of contexts) {
      const db = ctx.firestore();
      await assertFails(getDoc(doc(db, "orders/ord_1/cancellations/can_1")));
      await assertFails(getDocs(collection(db, "orders/ord_1/cancellations")));
      await assertFails(setDoc(doc(db, "orders/ord_1/cancellations/can_2"), { orderId: "ord_1", seq: 2, refundCents: 99999 }));
      await assertFails(updateDoc(doc(db, "orders/ord_1/cancellations/can_1"), { refundCents: 99999 }));
      await assertFails(deleteDoc(doc(db, "orders/ord_1/cancellations/can_1")));
      await assertFails(updateDoc(doc(db, "orders/ord_1"), { status: "cancelled", canceledQty: 1, refundedCents: 500 }));
    }
  });

  it("a família dona não credita a própria carteira: lançamento de reembolso e saldo seguem fechados à escrita do cliente", async () => {
    const db = (await as("famA", "guardian")).firestore();
    await assertFails(setDoc(doc(db, "wallets/stu_a/entries/can_x_refund"), { type: "order_refund", seq: 1, amountCents: 500, balanceAfterCents: 500 }));
    await assertFails(setDoc(doc(db, "wallets/stu_a"), { studentId: "stu_a", balanceCents: 99999, version: 1 }));
  });
});

/**
 * F15: pedido de balcão (`channel: "counter"`, entregue na hora), a entrega que o acompanha, a venda direta (`directSales`,
 * recebimento local sem aluno) e o lançamento `counter_purchase` são escritos só pelo servidor. Sem regra nova: o default-deny
 * cobre tudo — nem a cantina que opera o PDV, nem a administração, nem a família dona leem ou escrevem direto.
 */
describe("Firestore rules — F15: balcão e venda direta são só do servidor", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "orders/cnt_1"), { orderId: "cnt_1", channel: "counter", studentId: "stu_a", status: "delivered", totalCents: 1000, consumptionDate: "2026-10-05", createdByUid: "cant" });
      await setDoc(doc(db, "orders/cnt_1/deliveries/dlv_1"), { deliveryId: "dlv_1", orderId: "cnt_1", studentId: "stu_a", lines: [{ movementId: "m000000001" }] });
      await setDoc(doc(db, "directSales/dsl_1"), { saleId: "dsl_1", channel: "counter_direct", totalCents: 500, payment: { method: "cash" }, createdByUid: "cant" });
    });
  });

  it("nenhum cliente lê, lista, cria, altera ou apaga venda de balcão, entrega ou venda direta", async () => {
    const contexts = [await as("famA", "guardian"), await as("famB", "guardian"), await as("aluA", "student"), await as("cant", "cantina"), await as("sec", "secretaria"), await as("adm", "admin"), env.unauthenticatedContext()];
    for (const ctx of contexts) {
      const db = ctx.firestore();
      await assertFails(getDoc(doc(db, "orders/cnt_1")));
      await assertFails(getDoc(doc(db, "orders/cnt_1/deliveries/dlv_1")));
      await assertFails(getDocs(collection(db, "orders/cnt_1/deliveries")));
      await assertFails(getDoc(doc(db, "directSales/dsl_1")));
      await assertFails(getDocs(collection(db, "directSales")));
      await assertFails(setDoc(doc(db, "directSales/dsl_2"), { saleId: "dsl_2", totalCents: 1 }));
      await assertFails(updateDoc(doc(db, "directSales/dsl_1"), { totalCents: 1 }));
      await assertFails(deleteDoc(doc(db, "directSales/dsl_1")));
      await assertFails(setDoc(doc(db, "orders/cnt_2"), { channel: "counter", studentId: "stu_a", status: "delivered", totalCents: 1 }));
      await assertFails(updateDoc(doc(db, "orders/cnt_1"), { totalCents: 1 }));
    }
  });

  it("o cliente não grava lançamento de balcão nem altera o saldo (a cantina não tem leitura de saldo pelo cliente)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "wallets/stu_a"), { studentId: "stu_a", balanceCents: 5000, version: 1 });
    });
    for (const ctx of [await as("cant", "cantina"), await as("adm", "admin"), await as("famA", "guardian")]) {
      const db = ctx.firestore();
      await assertFails(setDoc(doc(db, "wallets/stu_a/entries/cnt_1_pay"), { type: "counter_purchase", seq: 2, amountCents: -1000, balanceAfterCents: 4000 }));
      await assertFails(updateDoc(doc(db, "wallets/stu_a"), { balanceCents: 0 }));
    }
    await assertFails(getDoc(doc(((await as("cant", "cantina")).firestore()), "wallets/stu_a")));
  });
});
