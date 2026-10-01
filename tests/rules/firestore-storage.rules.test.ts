import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, deleteDoc, where } from "firebase/firestore";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";

let env: RulesTestEnvironment;

type Status = "active" | "disabled";

/** Perfil de acesso em users/{uid} (fonte atual do papel; só o servidor escreve — aqui, com Rules desligadas). */
async function setProfile(uid: string, role: string, status: Status = "active", permissions: string[] = []): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${uid}`), {
      email: `${uid}@example.test`,
      displayName: uid,
      role,
      status,
      permissions,
      accessVersion: 1,
    });
  });
}

/** Conta autenticada com perfil do papel (NENHUMA claim: o papel vem só do perfil). */
async function as(uid: string, role: string, status: Status = "active") {
  await setProfile(uid, role, status);
  return env.authenticatedContext(uid);
}

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
    await setDoc(doc(db, "idempotencyRecords/x"), { payloadHash: "h" });
    await setDoc(doc(db, "demoProducts/p1"), { name: "Exemplo", priceCents: 450 });
    await setDoc(doc(db, "auditLog/a1"), { action: "x" });
    await setDoc(doc(db, "reportingDaily/2026-09-30"), { profitCents: 123 });
    await setDoc(doc(db, "stockReceipts/r1"), { unitCostCents: 99 });
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

  it("demais coleções (carteira, estoque, produtos, auditoria, idempotência) seguem deny-all, inclusive para o dono", async () => {
    const a = (await as("familyA", "guardian")).firestore();
    await assertFails(getDoc(doc(a, "wallets/student1")));
    await assertFails(setDoc(doc(a, "wallets/student1"), { balanceCents: 1 }));
    await assertFails(getDoc(doc(a, "idempotencyRecords/x")));
    await assertFails(setDoc(doc(a, "students/s1"), { name: "x" }));
    await assertFails(setDoc(doc(a, "stockBalances/p1"), { qty: 1000 }));
    await assertFails(setDoc(doc(a, "products/p1"), { priceCents: 1 }));
    await assertFails(getDoc(doc(a, "auditLog/a1")));
  });
});

describe("Firestore rules — catálogo de demonstração (F02/F03)", () => {
  it("conta com perfil ativo lê; anônimo, sem perfil e desativada não; ninguém escreve pelo cliente", async () => {
    const staff = (await as("s1", "admin")).firestore();
    const guardian = (await as("familyA", "guardian")).firestore();
    await assertSucceeds(getDoc(doc(guardian, "demoProducts/p1")));
    await assertSucceeds(getDocs(collection(guardian, "demoProducts")));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "demoProducts/p1")));
    await assertFails(getDoc(doc(env.authenticatedContext("semPerfil").firestore(), "demoProducts/p1")));
    await assertFails(getDoc(doc((await as("off", "guardian", "disabled")).firestore(), "demoProducts/p1")));
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
      const s = (await as(`staff-${role}`, role)).storage();
      await assertSucceeds(uploadBytes(ref(s, `products/p9/${role}.png`), PNG, png));
      await assertSucceeds(uploadBytes(ref(s, `products/p9/${role}.jpg`), PNG, { contentType: "image/jpeg" }));
      await assertSucceeds(uploadBytes(ref(s, `products/p9/${role}.webp`), PNG, { contentType: "image/webp" }));
      await assertSucceeds(deleteObject(ref(s, `products/p9/${role}.png`)));
    }
  });

  it("arquivo já criado não pode ser sobrescrito (nem por funcionário): substituir = novo arquivo", async () => {
    await seedFiles();
    const s = (await as("staff", "admin")).storage();
    await assertFails(uploadBytes(ref(s, "products/p1/demo.png"), PNG, png));
    await assertSucceeds(uploadBytes(ref(s, "products/p1/novo.png"), PNG, png));
  });

  it("responsável, aluno, secretaria, papel desconhecido, equipe desativada, sem perfil e anônimo não enviam nem removem", async () => {
    await seedFiles();
    const contexts = [
      env.authenticatedContext("familyA").storage(), // sem perfil
      (await as("sec", "secretaria")).storage(),
      (await as("guard", "guardian")).storage(),
      (await as("stu", "student")).storage(),
      (await as("x", "root")).storage(), // papel desconhecido
      (await as("off-cantina", "cantina", "disabled")).storage(), // equipe desativada
      env.unauthenticatedContext().storage(),
    ];
    for (const s of contexts) {
      await assertFails(uploadBytes(ref(s, "products/p9/a.png"), PNG, png));
      await assertFails(uploadBytes(ref(s, "products/p1/demo.png"), PNG, png));
      await assertFails(deleteObject(ref(s, "products/p1/demo.png")));
    }
  });

  it("tipo, tamanho, vazio e nome de arquivo são validados", async () => {
    const s = (await as("staff", "cantina")).storage();
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
    const s = (await as("staff", "admin")).storage();
    for (const path of ["private/a.png", "receipts/a.png", "a.png", "products/a.png", "products/p9/sub/a.png"]) {
      await assertFails(uploadBytes(ref(s, path), PNG, png));
    }
  });

  it("leitura: foto de produto só para conta com perfil ativo; arquivo privado nunca", async () => {
    await seedFiles();
    const guardian = (await as("familyA", "guardian")).storage();
    const staff = (await as("staff", "admin")).storage();
    await assertSucceeds(getBytes(ref(guardian, "products/p1/demo.png")));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), "products/p1/demo.png")));
    await assertFails(getBytes(ref(env.authenticatedContext("semPerfil").storage(), "products/p1/demo.png")));
    await assertFails(getBytes(ref((await as("off", "guardian", "disabled")).storage(), "products/p1/demo.png")));
    for (const s of [guardian, staff]) {
      await assertFails(getBytes(ref(s, "private/receipt.pdf")));
    }
  });
});

describe("Storage rules — revogação imediata (F03)", () => {
  it("papel rebaixado ou conta desativada perde o upload na hora, com o MESMO contexto/token", async () => {
    await setProfile("func", "cantina");
    const ctx = env.authenticatedContext("func");
    await assertSucceeds(uploadBytes(ref(ctx.storage(), "products/p9/antes.png"), PNG, png));
    await setProfile("func", "guardian");
    await assertFails(uploadBytes(ref(ctx.storage(), "products/p9/depois.png"), PNG, png));
    await setProfile("func", "cantina");
    await assertSucceeds(uploadBytes(ref(ctx.storage(), "products/p9/volta.png"), PNG, png));
    await setProfile("func", "cantina", "disabled");
    await assertFails(uploadBytes(ref(ctx.storage(), "products/p9/off.png"), PNG, png));
    await assertFails(getBytes(ref(ctx.storage(), "products/p9/volta.png")));
  });

  it("claim de papel no token não concede nada sem perfil (claim antiga/forjada é irrelevante)", async () => {
    const forged = env.authenticatedContext("forjado", { role: "admin" });
    await assertFails(uploadBytes(ref(forged.storage(), "products/p9/forjado.png"), PNG, png));
    await assertFails(getDoc(doc(forged.firestore(), "demoProducts/p1")));
  });
});

describe("Firestore rules — perfil, papéis e revogação (F03; A33)", () => {
  it("cada conta lê só o próprio perfil (inclusive desativada, para saber o motivo); sem list", async () => {
    const a = (await as("familyA", "guardian")).firestore();
    await assertSucceeds(getDoc(doc(a, "users/familyA")));
    await assertFails(getDoc(doc(a, "users/outro")));
    await assertFails(getDocs(collection(a, "users")));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "users/familyA")));
    const off = (await as("off", "cantina", "disabled")).firestore();
    await assertSucceeds(getDoc(doc(off, "users/off")));
  });

  it("cliente não escala o próprio papel nem escreve perfil de ninguém (nem a administração)", async () => {
    const a = (await as("familyA", "guardian")).firestore();
    await assertFails(updateDoc(doc(a, "users/familyA"), { role: "admin" }));
    await assertFails(setDoc(doc(a, "users/familyA"), { role: "admin", status: "active" }));
    await assertFails(setDoc(doc(a, "users/novo"), { role: "admin", status: "active" }));
    await assertFails(deleteDoc(doc(a, "users/familyA")));
    const admin = (await as("adm", "admin")).firestore();
    await assertFails(updateDoc(doc(admin, "users/familyA"), { role: "cantina" }));
    await assertFails(setDoc(doc(admin, "users/novo"), { role: "admin", status: "active" }));
  });

  it("custos, lucro, relatórios e auditoria só pelo servidor: nenhum papel lê pelo cliente (A30)", async () => {
    for (const role of ["secretaria", "cantina", "guardian", "student", "admin"]) {
      const c = (await as(`r-${role}`, role)).firestore();
      await assertFails(getDoc(doc(c, "reportingDaily/2026-09-30")));
      await assertFails(getDoc(doc(c, "stockReceipts/r1")));
      await assertFails(getDoc(doc(c, "auditLog/a1")));
      await assertFails(setDoc(doc(c, "auditLog/novo"), { action: "forjado" }));
      await assertFails(getDocs(collection(c, "reportingDaily")));
    }
  });
});

describe("Firestore rules — alunos, vínculos e políticas (F03; A02/A33)", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "students/s1"), { name: "Aluno Um", status: "active", userUid: "stu1" });
      await setDoc(doc(db, "students/s2"), { name: "Aluno Dois", status: "active", userUid: null });
      await setDoc(doc(db, "studentPolicies/s1"), { allowSitePurchase: true, allowCounterPurchase: false });
      await setDoc(doc(db, "studentPolicies/s2"), { allowSitePurchase: false, allowCounterPurchase: false });
      await setDoc(doc(db, "guardianStudentLinks/gA_s1"), { guardianUid: "gA", studentId: "s1", status: "active" });
      await setDoc(doc(db, "guardianStudentLinks/gB_s1"), { guardianUid: "gB", studentId: "s1", status: "active" });
      await setDoc(doc(db, "guardianStudentLinks/gC_s2"), { guardianUid: "gC", studentId: "s2", status: "active" });
      await setDoc(doc(db, "guardianStudentLinks/gR_s1"), { guardianUid: "gR", studentId: "s1", status: "revoked" });
    });
  });

  it("dois responsáveis vinculados leem o mesmo aluno e política; sem vínculo, nada (leitura)", async () => {
    for (const uid of ["gA", "gB"]) {
      const g = (await as(uid, "guardian")).firestore();
      await assertSucceeds(getDoc(doc(g, "students/s1")));
      await assertSucceeds(getDoc(doc(g, "studentPolicies/s1")));
      await assertFails(getDoc(doc(g, "students/s2")));
      await assertFails(getDoc(doc(g, "studentPolicies/s2")));
    }
    const stranger = (await as("gC", "guardian")).firestore();
    await assertFails(getDoc(doc(stranger, "students/s1")));
    await assertSucceeds(getDoc(doc(stranger, "students/s2")));
  });

  it("nenhum cliente escreve aluno, vínculo ou política (A02 escrita; A33), nem responsável vinculado nem administração", async () => {
    for (const [uid, role] of [["gA", "guardian"], ["adm", "admin"], ["can", "cantina"], ["sec", "secretaria"]] as const) {
      const c = (await as(uid, role)).firestore();
      await assertFails(setDoc(doc(c, "students/s1"), { name: "Outro", status: "active" }));
      await assertFails(updateDoc(doc(c, "students/s1"), { status: "inactive" }));
      await assertFails(updateDoc(doc(c, "studentPolicies/s1"), { allowSitePurchase: false }));
      await assertFails(setDoc(doc(c, `guardianStudentLinks/${uid}_s2`), { guardianUid: uid, studentId: "s2", status: "active" }));
      await assertFails(updateDoc(doc(c, "guardianStudentLinks/gA_s1"), { status: "revoked" }));
      await assertFails(deleteDoc(doc(c, "students/s1")));
    }
  });

  it("não há listagem de alunos nem de políticas; vínculo próprio é listável só com filtro compatível", async () => {
    const g = (await as("gA", "guardian")).firestore();
    await assertFails(getDocs(collection(g, "students")));
    await assertFails(getDocs(collection(g, "studentPolicies")));
    await assertFails(getDocs(collection(g, "guardianStudentLinks")));
    await assertFails(getDocs(query(collection(g, "guardianStudentLinks"), where("guardianUid", "==", "gB"), where("status", "==", "active"))));
    const own = await assertSucceeds(
      getDocs(query(collection(g, "guardianStudentLinks"), where("guardianUid", "==", "gA"), where("status", "==", "active"))),
    );
    expect(own.docs.map((d) => d.id)).toEqual(["gA_s1"]);
    await assertFails(getDoc(doc(g, "guardianStudentLinks/gB_s1")));
  });

  it("vínculo revogado perde o acesso imediatamente, com o mesmo contexto", async () => {
    const g = (await as("gB", "guardian")).firestore();
    await assertSucceeds(getDoc(doc(g, "students/s1")));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "guardianStudentLinks/gB_s1"), { status: "revoked" });
    });
    await assertFails(getDoc(doc(g, "students/s1")));
    await assertFails(getDoc(doc(g, "studentPolicies/s1")));
    const revoked = (await as("gR", "guardian")).firestore();
    await assertFails(getDoc(doc(revoked, "students/s1")));
  });

  it("conta desativada ou sem perfil não acessa aluno mesmo com vínculo ativo; o vínculo só vale para o papel guardian", async () => {
    const off = (await as("gA", "guardian", "disabled")).firestore();
    await assertFails(getDoc(doc(off, "students/s1")));
    const none = env.authenticatedContext("gB").firestore(); // vínculo ativo, sem perfil
    await assertFails(getDoc(doc(none, "students/s1")));
    // Com papel de equipe o acesso vem do papel, não do vínculo: cantina lê aluno e política (PDV).
    const cantina = (await as("gB", "cantina")).firestore();
    await assertSucceeds(getDoc(doc(cantina, "students/s2")));
    await assertSucceeds(getDoc(doc(cantina, "studentPolicies/s2")));
    // Papel student com vínculo ativo de responsável não herda o vínculo.
    const student = (await as("gA", "student")).firestore();
    await assertFails(getDoc(doc(student, "students/s1")));
    await assertFails(getDoc(doc(student, "studentPolicies/s1")));
  });

  it("aluno com login lê só o próprio cadastro e política; outro aluno não", async () => {
    const self = (await as("stu1", "student")).firestore();
    await assertSucceeds(getDoc(doc(self, "students/s1")));
    await assertSucceeds(getDoc(doc(self, "studentPolicies/s1")));
    await assertFails(getDoc(doc(self, "students/s2")));
    const other = (await as("stu2", "student")).firestore();
    await assertFails(getDoc(doc(other, "students/s1")));
    await assertFails(getDoc(doc(other, "studentPolicies/s1")));
  });

  it("equipe: cantina/secretaria/admin leem o perfil do aluno; só cantina/admin leem política; secretaria não", async () => {
    for (const role of ["cantina", "secretaria", "admin"]) {
      const c = (await as(`f-${role}`, role)).firestore();
      await assertSucceeds(getDoc(doc(c, "students/s1")));
    }
    await assertSucceeds(getDoc(doc((await as("f1", "cantina")).firestore(), "studentPolicies/s1")));
    await assertSucceeds(getDoc(doc((await as("f2", "admin")).firestore(), "studentPolicies/s1")));
    await assertFails(getDoc(doc((await as("f3", "secretaria")).firestore(), "studentPolicies/s1")));
  });

  it("rebaixar o papel ou desativar a conta nega na hora, com o mesmo contexto", async () => {
    const ctx = await as("f9", "cantina");
    const db = ctx.firestore();
    await assertSucceeds(getDoc(doc(db, "studentPolicies/s1")));
    await setProfile("f9", "secretaria");
    await assertFails(getDoc(doc(db, "studentPolicies/s1")));
    await setProfile("f9", "cantina");
    await assertSucceeds(getDoc(doc(db, "studentPolicies/s1")));
    await setProfile("f9", "cantina", "disabled");
    await assertFails(getDoc(doc(db, "studentPolicies/s1")));
    await assertFails(getDoc(doc(db, "students/s1")));
    await assertFails(getDoc(doc(db, "demoProducts/p1")));
  });
});

describe("Firestore rules — F04: turmas, turnos, convites e dados de cadastro (A02/A33)", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "classes/c1"), { name: "5A", status: "active" });
      await setDoc(doc(db, "shifts/s1"), { name: "Manhã", status: "active" });
      await setDoc(doc(db, "students/kid1"), { name: "Aluno Um", enrollment: "M1", status: "active", userUid: null, classId: "c1", shiftId: "s1" });
      await setDoc(doc(db, "students/kid2"), { name: "Aluno Dois", enrollment: "M2", status: "active", userUid: null, classId: "c1", shiftId: "s1" });
      await setDoc(doc(db, "guardianStudentLinks/gA_kid1"), { guardianUid: "gA", studentId: "kid1", status: "active" });
      await setDoc(doc(db, "guardianStudentLinks/gB_kid1"), { guardianUid: "gB", studentId: "kid1", status: "active" });
      await setDoc(doc(db, "studentPolicies/kid1"), { allowSitePurchase: false, allowCounterPurchase: false, configVersion: 1 });
      await setDoc(doc(db, "invitations/h1"), { kind: "guardian", studentId: "kid1", status: "pending" });
      await setDoc(doc(db, "uniquenessKeys/enrollment_M1"), { studentId: "kid1" });
    });
  });

  it("turmas e turnos: leitura por conta com perfil ativo; escrita nunca pelo cliente (nem administração)", async () => {
    const guardian = (await as("gA", "guardian")).firestore();
    const admin = (await as("adm", "admin")).firestore();
    for (const db of [guardian, admin]) {
      await assertSucceeds(getDoc(doc(db, "classes/c1")));
      await assertSucceeds(getDocs(collection(db, "shifts")));
      await assertFails(setDoc(doc(db, "classes/c2"), { name: "6B", status: "active" }));
      await assertFails(updateDoc(doc(db, "shifts/s1"), { name: "Noite" }));
      await assertFails(deleteDoc(doc(db, "classes/c1")));
    }
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "classes/c1")));
    await assertFails(getDoc(doc(env.authenticatedContext("semPerfil").firestore(), "classes/c1")));
    await assertFails(getDoc(doc((await as("off", "guardian", "disabled")).firestore(), "shifts/s1")));
  });

  it("convites e chaves de unicidade são invisíveis e intocáveis para qualquer papel", async () => {
    for (const [uid, role] of [["gA", "guardian"], ["adm", "admin"], ["can", "cantina"], ["sec", "secretaria"]] as const) {
      const db = (await as(uid, role)).firestore();
      await assertFails(getDoc(doc(db, "invitations/h1")));
      await assertFails(getDocs(collection(db, "invitations")));
      await assertFails(updateDoc(doc(db, "invitations/h1"), { status: "used" }));
      await assertFails(setDoc(doc(db, "invitations/h2"), { kind: "guardian", studentId: "kid1", status: "pending" }));
      await assertFails(getDoc(doc(db, "uniquenessKeys/enrollment_M1")));
      await assertFails(setDoc(doc(db, "uniquenessKeys/enrollment_M9"), { studentId: "kid1" }));
    }
  });

  it("responsável vinculado lê o aluno e a política do seu filho, mas não escreve; outra família não lê (A02)", async () => {
    const a = (await as("gA", "guardian")).firestore();
    const b = (await as("gB", "guardian")).firestore();
    const outsider = (await as("gC", "guardian")).firestore();
    for (const db of [a, b]) {
      await assertSucceeds(getDoc(doc(db, "students/kid1")));
      await assertSucceeds(getDoc(doc(db, "studentPolicies/kid1")));
      await assertFails(updateDoc(doc(db, "studentPolicies/kid1"), { allowSitePurchase: true })); // só pelo servidor
      await assertFails(updateDoc(doc(db, "students/kid1"), { name: "Outro" }));
      await assertFails(setDoc(doc(db, "guardianStudentLinks/gA_kid2"), { guardianUid: "gA", studentId: "kid2", status: "active" })); // sem auto-vínculo
      await assertFails(getDoc(doc(db, "students/kid2")));
    }
    await assertFails(getDoc(doc(outsider, "students/kid1")));
    await assertFails(getDoc(doc(outsider, "studentPolicies/kid1")));
    await assertFails(setDoc(doc(outsider, "guardianStudentLinks/gC_kid1"), { guardianUid: "gC", studentId: "kid1", status: "active" }));
    await assertFails(getDocs(collection(outsider, "students")));
  });

  it("aluno com login lê o próprio cadastro e nada mais; vínculo só por servidor", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), "students/kid1"), { userUid: "stuUser" });
    });
    const student = (await as("stuUser", "student")).firestore();
    await assertSucceeds(getDoc(doc(student, "students/kid1")));
    await assertFails(getDoc(doc(student, "students/kid2")));
    await assertFails(updateDoc(doc(student, "students/kid1"), { userUid: "stuUser", name: "Eu" }));
    await assertFails(setDoc(doc(student, "guardianStudentLinks/stuUser_kid2"), { guardianUid: "stuUser", studentId: "kid2", status: "active" }));
  });
});
