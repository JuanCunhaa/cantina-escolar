import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { localDateOf, addDays, weekStartOf } from "@/lib/dates/school-time";
import { conflict, invalid, notFound } from "@/lib/domain-error";
import { deterministicId, runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { auditInTransaction } from "@/modules/audit/log";
import { MAX_ADVANCE_DAYS } from "@/modules/school/calendar";
import { exceptionSchema, parsePolicy, sameList, setPolicySchema, type StudentPolicy } from "./model";
import { exceptionRefOf } from "./purchase-guard";
import { readCommitmentsFrom } from "./usage";

export { setPolicySchema };

/** Compromisso já existente acima de um teto novo: mostrado ao responsável, NUNCA cancelado nem alterado. */
export type ExistingCommitment = { scope: "day" | "week"; key: string; committedCents: number; limitCents: number; excessCents: number };

export type SetPolicyResult = {
  studentId: string;
  changed: boolean;
  configVersion: number;
  policy: Omit<StudentPolicy, "configVersion">;
  /** Reduzir limite/bloquear produto vale para NOVAS compras; pedidos e consumo já registrados permanecem como estão. */
  appliesTo: "new_purchases_only";
  existingCommitments: ExistingCommitment[];
};

const pickPolicy = (p: StudentPolicy): SetPolicyResult["policy"] => ({
  allowSitePurchase: p.allowSitePurchase,
  allowCounterPurchase: p.allowCounterPurchase,
  dailyLimitCents: p.dailyLimitCents,
  weeklyLimitCents: p.weeklyLimitCents,
  blockedProductIds: p.blockedProductIds,
  blockedCategoryIds: p.blockedCategoryIds,
});

/**
 * Permissões de compra (site e balcão), limites diário/semanal e bloqueios do aluno. Qualquer responsável vinculado
 * ativo — todos equivalentes, sem "principal" — ou a administração altera; a mudança vale para a conta do aluno e
 * registra o autor/versão na auditoria. Vínculo, aluno e política são lidos DENTRO da transação (decisão com estado
 * atual). Só os campos informados mudam; `expectedConfigVersion` (opcional) detecta edição concorrente (409
 * `stale_policy`). Nada aqui cancela, reembolsa ou reescreve pedidos/uso já registrados.
 */
export async function setStudentPolicy(db: Firestore, actor: Actor, raw: unknown): Promise<SetPolicyResult & { replayed: boolean }> {
  const input = setPolicySchema.parse(raw);
  return runIdempotentCommand(
    db,
    actor,
    { scope: "policy.set", key: input.key, payload: input, allow: (p) => p.role === "guardian" || p.role === "admin" },
    async ({ tx, actor: current, auditId }) => {
      const [student, link, policy] = await tx.getAll(
        db.doc(`students/${input.studentId}`),
        db.doc(`guardianStudentLinks/${current.uid}_${input.studentId}`),
        db.doc(`studentPolicies/${input.studentId}`),
      );
      if (!decideStudentAction({ actor: current, studentId: input.studentId, action: "manage", student: student?.data(), link: link?.data(), policy: policy?.data() })) {
        throw new ForbiddenError("Sem acesso ao aluno (manage).");
      }
      const before = parsePolicy(policy?.data());
      if (input.expectedConfigVersion !== undefined && input.expectedConfigVersion !== before.configVersion) {
        throw conflict("stale_policy", "Política alterada por outra pessoa.");
      }
      const after: StudentPolicy = {
        ...before,
        allowSitePurchase: input.allowSitePurchase ?? before.allowSitePurchase,
        allowCounterPurchase: input.allowCounterPurchase ?? before.allowCounterPurchase,
        dailyLimitCents: input.dailyLimitCents === undefined ? before.dailyLimitCents : input.dailyLimitCents,
        weeklyLimitCents: input.weeklyLimitCents === undefined ? before.weeklyLimitCents : input.weeklyLimitCents,
        blockedProductIds: input.blockedProductIds ? [...new Set(input.blockedProductIds)].sort() : before.blockedProductIds,
        blockedCategoryIds: input.blockedCategoryIds ? [...new Set(input.blockedCategoryIds)].sort() : before.blockedCategoryIds,
      };
      if (after.dailyLimitCents !== null && after.weeklyLimitCents !== null && after.dailyLimitCents > after.weeklyLimitCents) {
        throw invalid("daily_exceeds_weekly", "O limite diário não pode ser maior que o semanal.");
      }
      // Bloquear exige item existente (só os recém-adicionados são conferidos; remover sempre é possível).
      const addedProducts = after.blockedProductIds.filter((id) => !before.blockedProductIds.includes(id));
      const addedCategories = after.blockedCategoryIds.filter((id) => !before.blockedCategoryIds.includes(id));
      const refs = [...addedProducts.map((id) => db.doc(`products/${id}`)), ...addedCategories.map((id) => db.doc(`categories/${id}`))];
      const catalog = refs.length > 0 ? await tx.getAll(...refs) : [];
      if (catalog.some((s) => !s.exists)) throw notFound("blocked_item_not_found");

      const changed =
        after.allowSitePurchase !== before.allowSitePurchase ||
        after.allowCounterPurchase !== before.allowCounterPurchase ||
        after.dailyLimitCents !== before.dailyLimitCents ||
        after.weeklyLimitCents !== before.weeklyLimitCents ||
        !sameList(after.blockedProductIds, before.blockedProductIds) ||
        !sameList(after.blockedCategoryIds, before.blockedCategoryIds);
      const configVersion = before.configVersion + (changed ? 1 : 0);

      // Compromissos existentes acima do teto vigente (informação para o responsável; nada é cancelado).
      const today = localDateOf(new Date());
      const existing = after.dailyLimitCents !== null || after.weeklyLimitCents !== null ? await readCommitmentsFrom(db, tx, input.studentId, today) : { days: [], weeks: [] };
      const existingCommitments: ExistingCommitment[] = [
        ...existing.days.flatMap((d) =>
          after.dailyLimitCents !== null && d.committedCents > after.dailyLimitCents
            ? [{ scope: "day" as const, key: d.key, committedCents: d.committedCents, limitCents: after.dailyLimitCents, excessCents: d.committedCents - after.dailyLimitCents }]
            : [],
        ),
        ...existing.weeks.flatMap((w) =>
          after.weeklyLimitCents !== null && w.committedCents > after.weeklyLimitCents
            ? [{ scope: "week" as const, key: w.key, committedCents: w.committedCents, limitCents: after.weeklyLimitCents, excessCents: w.committedCents - after.weeklyLimitCents }]
            : [],
        ),
      ];

      if (changed) {
        const fields = pickPolicy(after);
        tx.set(policy!.ref, { ...fields, configVersion, updatedAt: FieldValue.serverTimestamp(), updatedBy: current.uid }, { merge: true });
        auditInTransaction(db, tx, auditId, {
          action: "policy.set",
          actorUid: current.uid,
          actorRole: current.role ?? null,
          target: { type: "student", id: input.studentId },
          reason: input.reason,
          before: { ...pickPolicy(before), configVersion: before.configVersion },
          after: { ...fields, configVersion, appliesTo: "new_purchases_only", existingCommitmentsAboveLimit: existingCommitments.length },
        });
      }
      return { studentId: input.studentId, changed, configVersion, policy: pickPolicy(after), appliesTo: "new_purchases_only", existingCommitments };
    },
  );
}

export type ExceptionResult = { studentId: string; exceptionId: string; status: "active" | "revoked"; changed: boolean };

/**
 * Exceção de compra de uso único para UMA data de consumo e um valor máximo: supera bloqueios e limites (não a
 * permissão de canal) para aluno/funcionário. Criada por responsável vinculado ("autorização específica do
 * responsável") ou pela administração ("exceção administrativa", motivo ≥ 10 caracteres). Ambas auditadas; a
 * exceção é consumida na transação da compra (`commitPurchaseUsage`). Revogar só vale enquanto está ativa.
 */
export async function changeException(db: Firestore, actor: Actor, raw: unknown): Promise<ExceptionResult & { replayed: boolean }> {
  const input = exceptionSchema.parse(raw);
  const exceptionId = input.action === "create" ? deterministicId("exc", actor.uid, input.key) : (input.exceptionId ?? "");
  if (input.action === "revoke" && !input.exceptionId) throw invalid("exception_id_required");
  if (input.action === "create" && (!input.consumptionDate || !input.maxCents)) throw invalid("exception_scope_required", "Informe a data e o valor máximo.");
  return runIdempotentCommand(
    db,
    actor,
    { scope: "policy.exception", key: input.key, payload: input, allow: (p) => p.role === "guardian" || p.role === "admin" },
    async ({ tx, actor: current, auditId }) => {
      const ref = exceptionRefOf(db, input.studentId, exceptionId);
      const [student, link, policy, existing] = await tx.getAll(
        db.doc(`students/${input.studentId}`),
        db.doc(`guardianStudentLinks/${current.uid}_${input.studentId}`),
        db.doc(`studentPolicies/${input.studentId}`),
        ref,
      );
      if (!decideStudentAction({ actor: current, studentId: input.studentId, action: "manage", student: student?.data(), link: link?.data(), policy: policy?.data() })) {
        throw new ForbiddenError("Sem acesso ao aluno (manage).");
      }
      const kind = current.role === "admin" ? "admin" : "guardian";
      if (input.action === "create") {
        if (kind === "admin" && input.reason.length < 10) throw invalid("admin_reason_required", "Exceção administrativa exige motivo (mín. 10 caracteres).");
        if (student?.data()?.status !== "active") throw conflict("student_inactive");
        const today = localDateOf(new Date());
        const date = input.consumptionDate!;
        if (date < today || date > addDays(today, MAX_ADVANCE_DAYS)) throw invalid("date_out_of_window", "Data fora da janela de compra.");
        if (existing?.exists) throw conflict("already_exists");
        tx.create(ref, {
          studentId: input.studentId,
          kind,
          status: "active",
          consumptionDate: date,
          weekStart: weekStartOf(date),
          maxCents: input.maxCents,
          reason: input.reason,
          createdBy: current.uid,
          createdByRole: current.role ?? null,
          createdAt: FieldValue.serverTimestamp(),
        });
        auditInTransaction(db, tx, auditId, {
          action: "policy.exception.create",
          actorUid: current.uid,
          actorRole: current.role ?? null,
          target: { type: "student", id: input.studentId },
          reason: input.reason,
          after: { exceptionId, kind, consumptionDate: date, maxCents: input.maxCents },
        });
        return { studentId: input.studentId, exceptionId, status: "active" as const, changed: true };
      }
      if (!existing?.exists) throw notFound("exception_not_found");
      const status = existing.data()?.status;
      if (status === "used") throw conflict("exception_used", "A exceção já foi usada.");
      if (status === "revoked") return { studentId: input.studentId, exceptionId, status: "revoked" as const, changed: false };
      tx.update(ref, { status: "revoked", revokedBy: current.uid, revokedAt: FieldValue.serverTimestamp() });
      auditInTransaction(db, tx, auditId, {
        action: "policy.exception.revoke",
        actorUid: current.uid,
        actorRole: current.role ?? null,
        target: { type: "student", id: input.studentId },
        reason: input.reason,
        before: { exceptionId, status: "active" },
        after: { exceptionId, status: "revoked" },
      });
      return { studentId: input.studentId, exceptionId, status: "revoked" as const, changed: true };
    },
  );
}
