// Família fictícia para os testes do portal (emulador e homologação): a administração cria o aluno na turma/turno de
// exemplo e vincula um responsável novo pelas rotas autorizadas do app (nada por escrita direta na nuvem). O cardápio do
// portal é por aluno/data/turno (F07), então quem testa o portal precisa de um aluno vinculado.
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { DEMO_SHIFTS } from "../../scripts/lib/demo-seed.ts";
import { createTestUser, type TestUser } from "./auth-emulator";
import { fixtureIds } from "./catalog-fixtures.ts";

export type Family = { guardian: TestUser; admin: TestUser; studentId: string; studentName: string };

export async function adminPost(request: APIRequestContext, admin: TestUser, url: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request.post(url, { headers: { authorization: `Bearer ${admin.idToken}` }, data: { key: randomUUID(), ...data } });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok()) throw new Error(`${url} ${String(data.action ?? "")} → ${response.status()} ${String(body.error ?? "")}`);
  return body;
}

/** Responsável novo com um aluno fictício "(exemplo)" no turno indicado (padrão: manhã de exemplo). */
export async function createFamily(request: APIRequestContext, label: string, shiftName: string = DEMO_SHIFTS[0].name): Promise<Family> {
  const ids = await fixtureIds();
  const [admin, guardian] = await Promise.all([createTestUser(`${label}-adm`, "admin"), createTestUser(label, "guardian")]);
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const studentName = `Aluno ${suffix} (exemplo)`;
  const created = await adminPost(request, admin, "/api/students", {
    action: "create",
    enrollment: `EX${suffix}`,
    name: studentName,
    classId: ids.classId(),
    shiftId: ids.shift(shiftName),
  });
  const studentId = String(created.studentId);
  await adminPost(request, admin, "/api/links", { action: "add", studentId, guardianEmail: guardian.email, reason: "Teste automatizado (fictício)" });
  return { guardian, admin, studentId, studentName };
}
