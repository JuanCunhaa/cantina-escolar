import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { conflict, invalid } from "@/lib/domain-error";
import { deterministicId, hashPayload, IdempotencyConflictError, sha256Hex } from "@/lib/firebase/command";
import { COMMAND_TRANSACTION } from "@/lib/firebase/transaction-options";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { parseProfile } from "@/modules/access/profile";
import { appendAudit } from "@/modules/audit/log";
import { loadUnits } from "@/modules/school/commands";
import { createStudentInTx, updateStudentInTx } from "./commands";
import { CSV_MAX_BYTES, planImport, type ExistingStudent, type ImportPlan, type PlanRow } from "./csv";

/** Diretório máximo lido na importação (custo: um read por aluno cadastrado, na prévia e na confirmação). */
const DIRECTORY_LIMIT = 5000;

const baseSchema = z.object({
  csv: z.string().min(1).max(CSV_MAX_BYTES),
  onDuplicate: z.enum(["skip", "update"]).default("skip"),
});
export const importSchema = z.discriminatedUnion("mode", [
  baseSchema.extend({ mode: z.literal("preview") }),
  baseSchema.extend({
    mode: z.literal("commit"),
    key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    /** Resumo devolvido pela prévia aprovada; a confirmação recalcula e recusa se o estado mudou. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    acceptWarnings: z.boolean().default(false),
  }),
]);

export type ImportPreview = { ok: true; plan: Extract<ImportPlan, { ok: true }>; digest: string } | { ok: false; error: string };

async function loadPlan(db: Firestore, csv: string, onDuplicate: "skip" | "update"): Promise<ImportPreview> {
  const [classes, shifts, students] = await Promise.all([
    loadUnits(db, "class"),
    loadUnits(db, "shift"),
    db.collection("students").select("enrollment", "name", "classId", "shiftId", "status").limit(DIRECTORY_LIMIT).get(),
  ]);
  const existing: ExistingStudent[] = students.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ExistingStudent, "id">) }));
  const plan = planImport(csv, { classes, shifts, existing, onDuplicate });
  if (!plan.ok) return plan;
  const stable = plan.rows.map((r) => [r.line, r.enrollment, r.name, r.action, r.classId, r.shiftId, r.studentId, r.warnings.length]);
  return { ok: true, plan, digest: sha256Hex(JSON.stringify({ onDuplicate, stable })) };
}

export type ImportOutcome = { line: number; enrollment: string; outcome: "created" | "updated" | "skipped" | "unchanged" | "duplicate" | "error" };
export type ImportResult = { created: number; updated: number; skipped: number; failed: number; rows: ImportOutcome[]; replayed: boolean };

export async function previewStudentImport(db: Firestore, actor: Actor, raw: unknown): Promise<ImportPreview> {
  authorize(actor, "students.manage");
  const input = importSchema.parse(raw);
  return loadPlan(db, input.csv, input.onDuplicate);
}

/**
 * Confirma a importação: recalcula a prévia no servidor (nunca confia no cliente), exige o mesmo resumo aprovado e grava
 * linha a linha em transações próprias (aluno + política + matrícula única + auditoria). Linhas com erro nunca são gravadas;
 * duplicidade por matrícula é decidida por `onDuplicate`; avisos de possível duplicidade exigem `acceptWarnings`.
 * Reexecutar a mesma chave devolve o resumo guardado.
 */
export async function commitStudentImport(db: Firestore, actor: Actor, raw: unknown): Promise<ImportResult> {
  authorize(actor, "students.manage");
  const input = importSchema.parse(raw);
  if (input.mode !== "commit") throw invalid("mode_required", "Use mode=commit.");
  const payloadHash = hashPayload({ a: "student.import", csv: sha256Hex(input.csv), d: input.onDuplicate, w: input.acceptWarnings });
  const idemRef = db.doc(`idempotencyRecords/${actor.uid}__student.import__${input.key}`);

  const early = await idemRef.get();
  if (early.exists) {
    const stored = early.data() as { payloadHash: string; response: Omit<ImportResult, "replayed"> };
    if (stored.payloadHash !== payloadHash) throw new IdempotencyConflictError("Chave reutilizada com payload diferente.");
    return { ...stored.response, replayed: true };
  }
  const actorProfile = parseProfile((await db.doc(`users/${actor.uid}`).get()).data());
  if (actorProfile?.status !== "active" || actorProfile.role !== "admin") throw new ForbiddenError("Ator sem permissão atual.");

  const preview = await loadPlan(db, input.csv, input.onDuplicate);
  if (!preview.ok) throw invalid(preview.error, "Arquivo inválido.");
  if (preview.digest !== input.digest) throw conflict("stale_preview", "Os dados mudaram desde a prévia. Gere a prévia novamente.");
  const { rows } = preview.plan;
  if (rows.some((r) => r.action === "error")) throw invalid("rows_with_errors", "Corrija ou remova as linhas com erro antes de confirmar.");
  if (!input.acceptWarnings && rows.some((r) => r.warnings.length > 0 && (r.action === "create" || r.action === "update"))) {
    throw conflict("warnings_not_accepted", "Há avisos de possível duplicidade; confirme explicitamente.");
  }

  const outcomes: ImportOutcome[] = [];
  const done = (row: PlanRow, outcome: ImportOutcome["outcome"]) => outcomes.push({ line: row.line, enrollment: row.enrollment, outcome });
  for (const row of rows) {
    if (row.action === "skip") {
      done(row, "skipped");
      continue;
    }
    if (row.action === "unchanged") {
      done(row, "unchanged");
      continue;
    }
    try {
      if (row.action === "create") {
        const studentId = deterministicId("stu", actor.uid, input.key, row.enrollment);
        const auditId = `${actor.uid}__student.import__${input.key}__${row.enrollment}`;
        const result = await db.runTransaction(
          (tx) => createStudentInTx(db, tx, actor, auditId, { studentId, enrollment: row.enrollment, name: row.name, classId: row.classId!, shiftId: row.shiftId! }),
          COMMAND_TRANSACTION,
        );
        done(row, result.outcome === "created" ? "created" : "duplicate");
      } else {
        const auditId = `${actor.uid}__student.import__${input.key}__${row.enrollment}`;
        const result = await db.runTransaction(
          (tx) => updateStudentInTx(db, tx, actor, auditId, row.studentId!, { name: row.name, classId: row.classId!, shiftId: row.shiftId! }, "Importação CSV"),
          COMMAND_TRANSACTION,
        );
        done(row, result.changed ? "updated" : "unchanged");
      }
    } catch {
      done(row, "error");
    }
  }
  const count = (o: ImportOutcome["outcome"]) => outcomes.filter((x) => x.outcome === o).length;
  const response = {
    created: count("created"),
    updated: count("updated"),
    skipped: count("skipped") + count("duplicate") + count("unchanged"),
    failed: count("error"),
    rows: outcomes,
  };
  await appendAudit(db, `${actor.uid}__student.import__${input.key}`, {
    action: "student.import",
    actorUid: actor.uid,
    actorRole: actor.role ?? null,
    target: { type: "import", id: input.key },
    reason: "Importação CSV",
    after: { created: response.created, updated: response.updated, skipped: response.skipped, failed: response.failed },
  });
  // Só registra a idempotência quando nada falhou: com falha parcial, o administrador repete com nova prévia.
  if (response.failed === 0) {
    await idemRef.create({ payloadHash, response, createdAt: FieldValue.serverTimestamp() }).catch(() => undefined);
  }
  return { ...response, replayed: false };
}
