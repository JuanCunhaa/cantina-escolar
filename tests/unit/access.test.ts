import { describe, expect, it } from "vitest";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction, type StudentAction } from "@/modules/access/authorize";
import { CAPABILITIES, can, type Capability } from "@/modules/access/permissions";
import { parseProfile } from "@/modules/access/profile";
import { ROLES, type Role } from "@/modules/access/roles";
import { setUserAccessSchema } from "@/modules/access/users-command";

describe("matriz de papéis (A30)", () => {
  const allowed = (role: Role, permissions: string[] = []) => CAPABILITIES.filter((c) => can({ role, permissions }, c));

  it("administração tem todas as capacidades", () => {
    expect(allowed("admin")).toEqual([...CAPABILITIES]);
  });

  it("secretaria nunca recebe custos, lucro, auditoria ou gestão de usuários", () => {
    const secretaria = allowed("secretaria");
    expect(secretaria).toEqual(["students.search", "topup.register"]);
    for (const c of ["costs.read", "profit.read", "audit.read", "users.manage"] as Capability[]) expect(can({ role: "secretaria" }, c)).toBe(false);
  });

  it("cantina opera pedidos/PDV/fotos, mas não vê custos, lucro nem recarrega", () => {
    expect(allowed("cantina")).toEqual(["students.search", "orders.operate", "orders.cancel", "pos.operate", "catalog.photos.manage", "inventory.read", "inventory.loss"]);
  });

  it("responsável, aluno e conta sem papel não têm capacidade administrativa", () => {
    expect(allowed("guardian")).toEqual([]);
    expect(allowed("student")).toEqual([]);
    for (const c of CAPABILITIES) expect(can({ role: null }, c)).toBe(false);
    for (const c of CAPABILITIES) expect(can({}, c)).toBe(false);
  });

  it("estorno manual é permissão separada: só a secretaria com a permissão extra explícita", () => {
    expect(can({ role: "secretaria" }, "topup.reverse")).toBe(false);
    expect(can({ role: "secretaria", permissions: ["topup.reverse"] }, "topup.reverse")).toBe(true);
    // Permissão extra não vale para outros papéis nem vira acesso a lucro.
    expect(can({ role: "cantina", permissions: ["topup.reverse"] }, "topup.reverse")).toBe(false);
    expect(can({ role: "secretaria", permissions: ["topup.reverse"] }, "profit.read")).toBe(false);
    expect(can({ role: "admin" }, "topup.reverse")).toBe(true);
  });

  it("todo papel conhecido está na matriz", () => {
    for (const role of ROLES) expect(() => allowed(role)).not.toThrow();
  });
});

describe("perfil de acesso", () => {
  const valid = { email: "a@example.test", displayName: "A", role: "cantina", status: "active", permissions: [], accessVersion: 1 };

  it("aceita perfil válido e normaliza permissões ausentes", () => {
    expect(parseProfile(valid)?.role).toBe("cantina");
    expect(parseProfile({ ...valid, permissions: undefined })?.permissions).toEqual([]);
  });

  it("perfil malformado, papel desconhecido ou situação desconhecida falham fechado", () => {
    for (const bad of [undefined, null, {}, { ...valid, role: "root" }, { ...valid, status: "pending" }, { ...valid, accessVersion: 0 }, { ...valid, permissions: ["admin"] }]) {
      expect(parseProfile(bad)).toBeNull();
    }
  });

  it("comando de acesso exige uid OU email, motivo e chave de idempotência", () => {
    const base = { key: "chave-12345", reason: "Início do ano letivo", role: "cantina" };
    expect(setUserAccessSchema.safeParse({ ...base, email: "x@example.test" }).success).toBe(true);
    expect(setUserAccessSchema.safeParse({ ...base, uid: "abc123" }).success).toBe(true);
    expect(setUserAccessSchema.safeParse({ ...base }).success).toBe(false);
    expect(setUserAccessSchema.safeParse({ ...base, uid: "abc", email: "x@example.test" }).success).toBe(false);
    expect(setUserAccessSchema.safeParse({ ...base, uid: "abc", reason: "" }).success).toBe(false);
    expect(setUserAccessSchema.safeParse({ ...base, uid: "abc", key: "curta" }).success).toBe(false);
    expect(setUserAccessSchema.safeParse({ ...base, uid: "abc", role: "root" }).success).toBe(false);
  });
});

describe("decisão de acesso ao aluno com vínculo e política atuais (A02/A08)", () => {
  const studentId = "s1";
  const student = { status: "active", userUid: "stu" };
  const link = (guardianUid: string, status = "active") => ({ guardianUid, studentId, status });
  const decide = (actor: Actor, action: StudentAction, over: Partial<Parameters<typeof decideStudentAction>[0]> = {}) =>
    decideStudentAction({ actor, studentId, action, student, link: undefined, policy: undefined, ...over });

  const guardianA: Actor = { uid: "gA", role: "guardian" };
  const guardianB: Actor = { uid: "gB", role: "guardian" };
  const stranger: Actor = { uid: "gX", role: "guardian" };

  it("dois responsáveis vinculados têm a mesma capacidade; sem vínculo nada é permitido", () => {
    for (const action of ["view", "manage", "purchase.site"] as const) {
      expect(decide(guardianA, action, { link: link("gA") }), `A ${action}`).toBe(true);
      expect(decide(guardianB, action, { link: link("gB") }), `B ${action}`).toBe(true);
      expect(decide(stranger, action, { link: undefined }), `X ${action}`).toBe(false);
    }
  });

  it("vínculo revogado, de outro responsável ou de outro aluno não vale", () => {
    for (const action of ["view", "manage", "purchase.site"] as const) {
      expect(decide(guardianA, action, { link: link("gA", "revoked") })).toBe(false);
      expect(decide(guardianA, action, { link: link("gB") })).toBe(false);
      expect(decide(guardianA, action, { link: { guardianUid: "gA", studentId: "outro", status: "active" } })).toBe(false);
    }
  });

  it("aluno inexistente nega tudo", () => {
    expect(decide(guardianA, "view", { student: undefined, link: link("gA") })).toBe(false);
    expect(decide({ uid: "adm", role: "admin" }, "view", { student: undefined })).toBe(false);
  });

  it("papel nulo (conta sem perfil) nega tudo", () => {
    expect(decide({ uid: "gA", role: null }, "view", { link: link("gA") })).toBe(false);
  });

  it("aluno compra pelo site somente com a permissão; revogar bloqueia checkout e PDV autônomo", () => {
    const studentActor: Actor = { uid: "stu", role: "student" };
    const cantina: Actor = { uid: "c1", role: "cantina" };
    expect(decide(studentActor, "purchase.site", { policy: { allowSitePurchase: true } })).toBe(true);
    expect(decide(studentActor, "purchase.site", { policy: { allowSitePurchase: false } })).toBe(false);
    expect(decide(studentActor, "purchase.site", { policy: undefined })).toBe(false);
    expect(decide(cantina, "purchase.counter", { policy: { allowCounterPurchase: true } })).toBe(true);
    expect(decide(cantina, "purchase.counter", { policy: { allowCounterPurchase: false } })).toBe(false);
    expect(decide(cantina, "purchase.counter", { policy: undefined })).toBe(false);
    // O responsável segue podendo comprar para o aluno (a política limita a autonomia do aluno, não o responsável).
    expect(decide(guardianA, "purchase.site", { link: link("gA"), policy: { allowSitePurchase: false } })).toBe(true);
    // Outro aluno (userUid diferente) não compra por este cadastro.
    expect(decide({ uid: "outro", role: "student" }, "purchase.site", { policy: { allowSitePurchase: true } })).toBe(false);
  });

  it("aluno/PDV inativo não compra; consulta continua para preservar histórico", () => {
    const inactive = { status: "inactive", userUid: "stu" };
    expect(decide(guardianA, "purchase.site", { student: inactive, link: link("gA") })).toBe(false);
    expect(decide({ uid: "c1", role: "cantina" }, "purchase.counter", { student: inactive, policy: { allowCounterPurchase: true } })).toBe(false);
    expect(decide(guardianA, "view", { student: inactive, link: link("gA") })).toBe(true);
  });

  it("secretaria e cantina consultam o aluno, mas não administram nem compram pelo site", () => {
    for (const role of ["secretaria", "cantina"] as const) {
      const actor: Actor = { uid: "f1", role };
      expect(decide(actor, "view")).toBe(true);
      expect(decide(actor, "manage")).toBe(false);
      expect(decide(actor, "purchase.site")).toBe(false);
    }
    expect(decide({ uid: "adm", role: "admin" }, "manage")).toBe(true);
    expect(decide({ uid: "adm", role: "admin" }, "purchase.site")).toBe(false);
  });

  it("guardião com papel de equipe (ou o contrário) não herda o vínculo: o vínculo só vale para o papel guardian", () => {
    expect(decide({ uid: "gA", role: "cantina" }, "manage", { link: link("gA") })).toBe(false);
    expect(decide({ uid: "gA", role: "student" }, "manage", { link: link("gA") })).toBe(false);
  });
});
