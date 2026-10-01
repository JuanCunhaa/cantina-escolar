import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { auditInTransaction } from "@/modules/audit/log";
import { isSafeLabel, normalizeName, unitSlug } from "@/modules/students/normalize";

/** Turmas e turnos (cadastrados pela administração). Arquivar não apaga: alunos e pedidos antigos mantêm a referência. */
export const UNIT_KINDS = ["class", "shift"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

const COLLECTION: Record<UnitKind, string> = { class: "classes", shift: "shifts" };
const PREFIX: Record<UnitKind, string> = { class: "cls", shift: "shf" };
const STUDENT_FIELD: Record<UnitKind, string> = { class: "classId", shift: "shiftId" };

const key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const name = z.string().trim().min(1).max(60).refine(isSafeLabel, "Nome inválido.");
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const schoolUnitSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), key, kind: z.enum(UNIT_KINDS), name }),
  z.object({ action: z.literal("rename"), key, kind: z.enum(UNIT_KINDS), id, name }),
  z.object({ action: z.literal("archive"), key, kind: z.enum(UNIT_KINDS), id }),
  z.object({ action: z.literal("restore"), key, kind: z.enum(UNIT_KINDS), id }),
]);
export type SchoolUnitInput = z.infer<typeof schoolUnitSchema>;

export type SchoolUnitResult = { id: string; changed: boolean };

const uniqueKey = (kind: UnitKind, slug: string) => `uniquenessKeys/${kind}_${slug}`;

export async function changeSchoolUnit(db: Firestore, actor: Actor, raw: unknown): Promise<SchoolUnitResult & { replayed: boolean }> {
  authorize(actor, "students.manage");
  const input = schoolUnitSchema.parse(raw);
  const collection = COLLECTION[input.kind];
  const slug = "name" in input ? unitSlug(input.name) : null;
  if ("name" in input && !slug) throw invalid("invalid_name", "Nome precisa ter letras ou números.");
  const unitId = input.action === "create" ? deterministicId(PREFIX[input.kind], actor.uid, input.key) : input.id;

  return runIdempotentCommand(
    db,
    actor,
    { scope: `school.${input.action}`, key: input.key, payload: input, allow: (p) => p.role === "admin" },
    async ({ tx, actor: current, auditId }) => {
      const ref = db.doc(`${collection}/${unitId}`);
      const reads = [ref];
      if (slug) reads.push(db.doc(uniqueKey(input.kind, slug)));
      const [unit, newKey] = await tx.getAll(...reads);
      const before = unit?.exists ? (unit.data() as { name: string; nameSlug?: string; status: string }) : null;
      if (input.action === "create" ? before : !before) {
        throw input.action === "create" ? conflict("already_exists") : notFound("unit_not_found");
      }
      let activeStudent = false;
      if (input.action === "archive") {
        const used = await tx.get(
          db.collection("students").where(STUDENT_FIELD[input.kind], "==", unitId).where("status", "==", "active").limit(1),
        );
        activeStudent = !used.empty;
      }
      const oldKeyRef = before?.nameSlug ? db.doc(uniqueKey(input.kind, before.nameSlug)) : null;
      const oldKey = oldKeyRef && input.action === "rename" && oldKeyRef.path !== newKey?.ref.path ? await tx.get(oldKeyRef) : null;

      if (newKey?.exists && (newKey.data() as { unitId: string }).unitId !== unitId) throw conflict("name_taken", "Já existe com este nome.");
      if (input.action === "archive" && activeStudent) throw conflict("unit_in_use", "Há alunos ativos nesta turma/turno.");

      const now = FieldValue.serverTimestamp();
      let changed = true;
      let after: Record<string, unknown>;
      if (input.action === "create") {
        after = { name: input.name, nameSlug: slug, status: "active" };
        tx.create(ref, { ...after, createdAt: now, updatedAt: now });
        tx.create(newKey!.ref, { unitId, kind: input.kind, createdAt: now });
      } else if (input.action === "rename") {
        changed = before!.name !== input.name;
        after = { name: input.name, nameSlug: slug, status: before!.status };
        if (changed) {
          tx.update(ref, { name: input.name, nameSlug: slug, updatedAt: now });
          if (!newKey!.exists) tx.create(newKey!.ref, { unitId, kind: input.kind, createdAt: now });
          if (oldKey?.exists && oldKeyRef) tx.delete(oldKeyRef);
        }
      } else {
        const status = input.action === "archive" ? "archived" : "active";
        changed = before!.status !== status;
        after = { name: before!.name, nameSlug: before!.nameSlug, status };
        if (changed) tx.update(ref, { status, updatedAt: now });
      }
      if (changed) {
        auditInTransaction(db, tx, auditId, {
          action: `school.${input.kind}.${input.action}`,
          actorUid: current.uid,
          actorRole: current.role ?? null,
          target: { type: input.kind, id: unitId },
          before: before && { name: before.name, status: before.status },
          after: { name: after.name, status: after.status },
        });
      }
      return { id: unitId, changed };
    },
  );
}

/** Resolve nomes (normalizados) de turmas/turnos ativos para importação. */
export async function loadUnits(db: Firestore, kind: UnitKind): Promise<Map<string, { id: string; name: string; active: boolean }>> {
  const snap = await db.collection(COLLECTION[kind]).limit(500).get();
  const byName = new Map<string, { id: string; name: string; active: boolean }>();
  for (const doc of snap.docs) {
    const data = doc.data() as { name: string; status: string };
    byName.set(normalizeName(data.name), { id: doc.id, name: data.name, active: data.status === "active" });
  }
  return byName;
}
