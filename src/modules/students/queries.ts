import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { z } from "zod";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { normalizeEnrollment, normalizeName } from "./normalize";

/** Diretório de alunos para a equipe (busca por nome com turma/turno, que diferenciam homônimos). Servidor apenas. */
export type StudentRow = {
  id: string;
  enrollment: string;
  name: string;
  classId: string;
  shiftId: string;
  status: string;
  hasLogin: boolean;
};

export const MAX_PAGE = 100;

export const listQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  after: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(MAX_PAGE),
});

function toRow(doc: QueryDocumentSnapshot): StudentRow {
  const d = doc.data() as Omit<StudentRow, "id" | "hasLogin"> & { userUid?: string | null };
  return { id: doc.id, enrollment: d.enrollment, name: d.name, classId: d.classId, shiftId: d.shiftId, status: d.status, hasLogin: Boolean(d.userUid) };
}

/**
 * Lista ordenada por nome normalizado, paginada por cursor (id do último aluno).
 * `q` = prefixo do nome normalizado (consulta por intervalo; custo = documentos retornados) OU matrícula exata.
 * Não há busca textual geral no Firestore: busca por sobrenome/trecho é filtrada no navegador sobre a página carregada.
 */
export async function listStudents(
  db: Firestore,
  actor: Actor,
  rawQuery: unknown,
): Promise<{ students: StudentRow[]; nextCursor: string | null }> {
  authorize(actor, "students.search");
  const { q, after, limit } = listQuerySchema.parse(rawQuery);
  const students = db.collection("students");
  const needle = q ? normalizeName(q) : "";

  let query = students.orderBy("nameNormalized").limit(limit);
  if (needle) query = students.where("nameNormalized", ">=", needle).where("nameNormalized", "<=", `${needle}`).orderBy("nameNormalized").limit(limit);
  if (after) {
    const cursor = await students.doc(after).get();
    if (cursor.exists) query = query.startAfter(cursor);
  }
  const page = await query.get();
  const rows = new Map(page.docs.map((doc) => [doc.id, toRow(doc)] as const));

  const enrollment = q && !after ? normalizeEnrollment(q) : null;
  if (enrollment) {
    const byEnrollment = await students.where("enrollment", "==", enrollment).limit(2).get();
    for (const doc of byEnrollment.docs) rows.set(doc.id, toRow(doc));
  }
  const ordered = [...rows.values()].sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)) || a.id.localeCompare(b.id));
  return { students: ordered, nextCursor: page.size === limit ? (page.docs.at(-1)?.id ?? null) : null };
}
