import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";

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
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "foundationProbes/familyA"), { balanceCents: 500 });
    await setDoc(doc(db, "foundationProbes/familyA/entries/e1"), { amountCents: 500 });
    await setDoc(doc(db, "foundationProbes/familyB"), { balanceCents: 900 });
    await setDoc(doc(db, "wallets/student1"), { balanceCents: 1000 });
    await setDoc(doc(db, "users/familyA"), { roles: ["guardian"] });
    await setDoc(doc(db, "idempotencyRecords/x"), { payloadHash: "h" });
    await setDoc(doc(db, "demoProducts/p1"), { name: "Exemplo", priceCents: 450 });
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

describe("Firestore rules — catálogo de demonstração (F02)", () => {
  it("conta autenticada lê; anônimo não; ninguém escreve pelo cliente", async () => {
    const staff = env.authenticatedContext("s1", { role: "admin" }).firestore();
    const guardian = env.authenticatedContext("familyA").firestore();
    await assertSucceeds(getDoc(doc(guardian, "demoProducts/p1")));
    await assertSucceeds(getDocs(collection(guardian, "demoProducts")));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "demoProducts/p1")));
    await assertFails(updateDoc(doc(staff, "demoProducts/p1"), { photoPath: "products/p1/x.png" }));
    await assertFails(setDoc(doc(guardian, "demoProducts/p2"), { priceCents: 1 }));
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = { contentType: "image/png" };

describe("Storage rules — fotos de produto (A36)", () => {
  async function seedFiles() {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "products/p1/demo.png"), PNG, png);
      await uploadBytes(ref(ctx.storage(), "private/receipt.pdf"), PNG, { contentType: "application/pdf" });
    });
  }

  it("funcionário (cantina/admin) envia e remove foto válida no caminho do produto", async () => {
    for (const role of ["cantina", "admin"]) {
      const s = env.authenticatedContext(`staff-${role}`, { role }).storage();
      await assertSucceeds(uploadBytes(ref(s, `products/p9/${role}.png`), PNG, png));
      await assertSucceeds(uploadBytes(ref(s, `products/p9/${role}.jpg`), PNG, { contentType: "image/jpeg" }));
      await assertSucceeds(uploadBytes(ref(s, `products/p9/${role}.webp`), PNG, { contentType: "image/webp" }));
      await assertSucceeds(deleteObject(ref(s, `products/p9/${role}.png`)));
    }
  });

  it("arquivo já criado não pode ser sobrescrito (nem por funcionário): substituir = novo arquivo", async () => {
    await seedFiles();
    const s = env.authenticatedContext("staff", { role: "admin" }).storage();
    await assertFails(uploadBytes(ref(s, "products/p1/demo.png"), PNG, png));
    await assertSucceeds(uploadBytes(ref(s, "products/p1/novo.png"), PNG, png));
  });

  it("responsável, secretaria, papel desconhecido e anônimo não enviam nem removem", async () => {
    await seedFiles();
    const contexts = [
      env.authenticatedContext("familyA").storage(),
      env.authenticatedContext("sec", { role: "secretaria" }).storage(),
      env.authenticatedContext("guard", { role: "guardian" }).storage(),
      env.authenticatedContext("x", { role: "root" }).storage(),
      env.unauthenticatedContext().storage(),
    ];
    for (const s of contexts) {
      await assertFails(uploadBytes(ref(s, "products/p9/a.png"), PNG, png));
      await assertFails(uploadBytes(ref(s, "products/p1/demo.png"), PNG, png));
      await assertFails(deleteObject(ref(s, "products/p1/demo.png")));
    }
  });

  it("tipo, tamanho, vazio e nome de arquivo são validados", async () => {
    const s = env.authenticatedContext("staff", { role: "cantina" }).storage();
    for (const type of ["image/svg+xml", "application/pdf", "text/html", "image/gif"]) {
      await assertFails(uploadBytes(ref(s, "products/p9/a.png"), PNG, { contentType: type }));
    }
    await assertFails(uploadBytes(ref(s, "products/p9/a.png"), new Uint8Array(0), png));
    await assertSucceeds(uploadBytes(ref(s, "products/p9/limite.png"), new Uint8Array(2 * 1024 * 1024), png));
    await assertFails(uploadBytes(ref(s, "products/p9/grande.png"), new Uint8Array(2 * 1024 * 1024 + 1), png));
    await assertFails(uploadBytes(ref(s, "products/p9/a.svg"), PNG, png));
    await assertFails(uploadBytes(ref(s, "products/p9/a.png.exe"), PNG, png));
  });

  it("caminho fora de products/{id}/{arquivo} é negado, inclusive para funcionário", async () => {
    const s = env.authenticatedContext("staff", { role: "admin" }).storage();
    for (const path of ["private/a.png", "receipts/a.png", "a.png", "products/a.png", "products/p9/sub/a.png"]) {
      await assertFails(uploadBytes(ref(s, path), PNG, png));
    }
  });

  it("leitura: foto de produto só para autenticado; arquivo privado nunca", async () => {
    await seedFiles();
    const guardian = env.authenticatedContext("familyA").storage();
    const staff = env.authenticatedContext("staff", { role: "admin" }).storage();
    await assertSucceeds(getBytes(ref(guardian, "products/p1/demo.png")));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), "products/p1/demo.png")));
    for (const s of [guardian, staff]) {
      await assertFails(getBytes(ref(s, "private/receipt.pdf")));
    }
  });
});
