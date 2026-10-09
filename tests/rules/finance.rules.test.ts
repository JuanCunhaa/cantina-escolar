// Coleções financeiras da F20 (caixa, taxas, fontes, conferências): todas só do servidor. Nenhum papel — nem a administração pelo
// cliente — lê ou escreve; operadores não enxergam o caixa de outro; as Rules não ganharam nenhuma permissão (default-deny).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

let env: RulesTestEnvironment;

async function as(uid: string, role: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { email: `${uid}@example.test`, displayName: uid, role, status: "active", permissions: [], accessVersion: 1 });
  });
  return env.authenticatedContext(uid);
}

const PATHS = [
  "cashSessions/2026-10-09__secretaria__secA",
  "cashSessions/2026-10-09__secretaria__secA/closures/1",
  "cashSessions/2026-10-09__secretaria__secA/events/e1",
  "paymentSources/term_abc",
  "feeSeries/term_abc__card_credit",
  "topups/tpm_1/reconciliations/rcn_1",
  "directSales/dsl_1/reconciliations/rcn_2",
] as const;

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-cantina", firestore: { rules: readFileSync("firebase/firestore.rules", "utf8") } });
});
afterAll(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const path of PATHS) await setDoc(doc(ctx.firestore(), path), { sentinel: true, operator: { uid: "secA" }, percentBp: 300 });
  });
});

describe("Firestore rules — F20: caixa, taxas e conferências são fechados ao cliente", () => {
  // Testes ESTÁTICOS (um `it` literal por papel): o gate compara testes listados × executados e a listagem não expande `.each` nem laços.
  const cannotRead = async (role: string) => {
    const db = (await as(`u_${role}`, role)).firestore();
    for (const path of PATHS) await assertFails(getDoc(doc(db, path)));
    await assertFails(getDocs(collection(db, "cashSessions")));
    await assertFails(getDocs(collection(db, "feeSeries")));
    await assertFails(getDocs(collection(db, "paymentSources")));
  };
  const cannotWrite = async (role: string) => {
    const db = (await as(`w_${role}`, role)).firestore();
    await assertFails(setDoc(doc(db, "cashSessions/2026-10-09__secretaria__w_" + role), { operator: { uid: `w_${role}` }, status: "closed", opening: { cents: 1 } }));
    await assertFails(updateDoc(doc(db, PATHS[0]), { status: "closed" }));
    await assertFails(deleteDoc(doc(db, PATHS[1])));
    await assertFails(setDoc(doc(db, "feeSeries/term_x__pix"), { versions: [{ n: 1, percentBp: 1 }] }));
    await assertFails(updateDoc(doc(db, "feeSeries/term_abc__card_credit"), { versions: [] }));
    await assertFails(setDoc(doc(db, "topups/tpm_1/reconciliations/rcn_9"), { after: { fee: { status: "confirmed", cents: 0 } } }));
  };
  it("admin não lê nem lista nenhuma coleção financeira da F20", () => cannotRead("admin"));
  it("secretaria não lê nem lista nenhuma coleção financeira da F20", () => cannotRead("secretaria"));
  it("cantina não lê nem lista nenhuma coleção financeira da F20", () => cannotRead("cantina"));
  it("guardian não lê nem lista nenhuma coleção financeira da F20", () => cannotRead("guardian"));
  it("student não lê nem lista nenhuma coleção financeira da F20", () => cannotRead("student"));
  it("admin não escreve, altera nem apaga: nem o próprio caixa (a escrita é só do servidor)", () => cannotWrite("admin"));
  it("secretaria não escreve, altera nem apaga: nem o próprio caixa (a escrita é só do servidor)", () => cannotWrite("secretaria"));
  it("cantina não escreve, altera nem apaga: nem o próprio caixa (a escrita é só do servidor)", () => cannotWrite("cantina"));

  it("sem login: nada", async () => {
    const db = env.unauthenticatedContext().firestore();
    for (const path of PATHS) await assertFails(getDoc(doc(db, path)));
    await assertFails(setDoc(doc(db, "cashSessions/x"), { a: 1 }));
  });
});
