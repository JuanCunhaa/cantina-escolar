import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { localDateOf } from "@/lib/dates/school-time";
import { conflict, notFound } from "@/lib/domain-error";
import { runIdempotentCommand } from "@/lib/firebase/command";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { can } from "@/modules/access/permissions";
import { auditInTransaction } from "@/modules/audit/log";
import { DEFAULT_SOURCE_ID, checkNewVersion, ruleSchema, seriesIdOf, sourceActiveSchema, sourceIdOf, sourceSchema, withdrawSchema, type RuleVersion } from "./fee-model";
import { isProductionEnv, parseSource, parseVersions } from "./fee-store";

/**
 * Comandos de cadastro (F20). Só a administração (`finance.manage`, relida do perfil ATUAL na transação, inclusive na repetição),
 * idempotentes por chave + payload, auditados na mesma transação. Nada aqui altera lançamento já gravado: cada recebimento guarda
 * a versão da regra que usou.
 */
const allowFinance = (p: { role: Actor["role"]; permissions: readonly string[] }) => can(p, "finance.manage");

export type SourceCommandResult = { sourceId: string; kind: string; name: string; methods: string[]; active: boolean; fictitious: boolean };

/** Cadastra um provedor online ou uma maquininha. ID determinístico pelo tipo + código (repetir = 409 `source_exists`). */
export async function createPaymentSource(db: Firestore, actor: Actor, raw: unknown): Promise<SourceCommandResult & { replayed: boolean }> {
  authorize(actor, "finance.manage");
  const input = sourceSchema.parse(raw);
  const sourceId = sourceIdOf(input.kind, input.code);
  return runIdempotentCommand(db, actor, { scope: "finance.source.create", key: input.key, payload: input, allow: allowFinance }, async ({ tx, actor: current, auditId }) => {
    if (input.fictitious && isProductionEnv()) throw conflict("fictitious_in_production", "Cadastro fictício não é aceito em produção.");
    const ref = db.doc(`paymentSources/${sourceId}`);
    const snap = await tx.get(ref);
    if (snap.exists) throw conflict("source_exists", "Já existe um cadastro com este código.", { sourceId });
    tx.create(ref, { sourceId, kind: input.kind, code: input.code, name: input.name, methods: input.methods, fictitious: input.fictitious, active: true, version: 1, createdByUid: current.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    auditInTransaction(db, tx, auditId, { action: "finance.source.create", actorUid: current.uid, actorRole: current.role ?? null, target: { type: "paymentSource", id: sourceId }, after: { kind: input.kind, name: input.name, methods: input.methods, fictitious: input.fictitious } });
    return { sourceId, kind: input.kind, name: input.name, methods: input.methods, active: true, fictitious: input.fictitious };
  });
}

/** Arquiva/reativa uma fonte (nunca apaga). Lançamentos antigos mantêm a fonte e a regra que usaram. */
export async function setPaymentSourceActive(db: Firestore, actor: Actor, raw: unknown): Promise<SourceCommandResult & { replayed: boolean }> {
  authorize(actor, "finance.manage");
  const input = sourceActiveSchema.parse(raw);
  return runIdempotentCommand(db, actor, { scope: "finance.source.active", key: input.key, payload: input, allow: allowFinance }, async ({ tx, actor: current, auditId }) => {
    if (input.sourceId === DEFAULT_SOURCE_ID) throw conflict("source_reserved", "A fonte padrão não pode ser arquivada.");
    const ref = db.doc(`paymentSources/${input.sourceId}`);
    const snap = await tx.get(ref);
    const source = parseSource(snap);
    if (!source) throw notFound("source_not_found", "Cadastro não encontrado.");
    if (source.active !== input.active) {
      tx.update(ref, { active: input.active, version: Number(snap.get("version") ?? 1) + 1, updatedAt: FieldValue.serverTimestamp() });
      auditInTransaction(db, tx, auditId, { action: "finance.source.active", actorUid: current.uid, actorRole: current.role ?? null, target: { type: "paymentSource", id: input.sourceId }, reason: input.reason, before: { active: source.active }, after: { active: input.active } });
    }
    return { sourceId: source.sourceId, kind: source.kind, name: source.name, methods: source.methods, active: input.active, fictitious: source.fictitious };
  });
}

export type RuleCommandResult = { seriesId: string; sourceId: string; method: string; version: number; effectiveFrom: string; withdrawn: boolean; versionCount: number };

/**
 * Publica uma NOVA versão da regra (fonte × meio). Nunca retroativa (vigência ≥ hoje) e sempre depois das demais; a série só
 * acrescenta. Regra fictícia é recusada em produção. O recebimento já gravado não muda.
 */
export async function publishFeeRule(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<RuleCommandResult & { replayed: boolean }> {
  authorize(actor, "finance.manage");
  const input = ruleSchema.parse(raw);
  const seriesId = seriesIdOf(input.sourceId, input.method);
  return runIdempotentCommand(db, actor, { scope: "finance.rule.publish", key: input.key, payload: input, allow: allowFinance }, async ({ tx, actor: current, auditId }) => {
    const now = clock();
    const today = localDateOf(now);
    if (input.fictitious && isProductionEnv()) throw conflict("fictitious_in_production", "Regra fictícia não é aceita em produção.");
    const seriesRef = db.doc(`feeSeries/${seriesId}`);
    const sourceRef = input.sourceId === DEFAULT_SOURCE_ID ? null : db.doc(`paymentSources/${input.sourceId}`);
    const [seriesSnap, sourceSnap] = await tx.getAll(seriesRef, ...(sourceRef ? [sourceRef] : []));
    if (sourceRef) {
      const source = parseSource(sourceSnap);
      if (!source) throw notFound("source_not_found", "Cadastro não encontrado.");
      if (!source.active) throw conflict("source_inactive", "Cadastro arquivado: reative-o antes de publicar regra.");
      if (!source.methods.includes(input.method)) throw conflict("method_not_in_source", "O cadastro não aceita este meio.");
      if (source.fictitious !== input.fictitious) throw conflict("fictitious_mismatch", "Regra e cadastro precisam ser ambos fictícios ou ambos reais.");
    }
    const versions = parseVersions(seriesSnap);
    const problem = checkNewVersion(versions, input, today);
    if (problem) throw conflict(problem.code, "Vigência inválida para a série.", problem.details);
    const version: RuleVersion = {
      n: versions.length + 1,
      effectiveFrom: input.effectiveFrom,
      enabled: input.enabled,
      percentBp: input.percentBp,
      fixedCents: input.fixedCents,
      settlementDays: input.settlementDays,
      fictitious: input.fictitious,
      reason: input.reason,
      createdByUid: current.uid,
      createdOn: today,
      createdAtIso: now.toISOString(),
      withdrawn: null,
    };
    tx.set(seriesRef, { seriesId, sourceId: input.sourceId, method: input.method, versions: [...versions, version], versionCount: version.n, updatedAt: FieldValue.serverTimestamp(), ...(seriesSnap!.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) });
    auditInTransaction(db, tx, auditId, {
      action: "finance.rule.publish",
      actorUid: current.uid,
      actorRole: current.role ?? null,
      target: { type: "feeSeries", id: seriesId },
      reason: input.reason,
      before: { versionCount: versions.length },
      after: { version: version.n, effectiveFrom: version.effectiveFrom, enabled: version.enabled, percentBp: version.percentBp, fixedCents: version.fixedCents, settlementDays: version.settlementDays, fictitious: version.fictitious },
    });
    return { seriesId, sourceId: input.sourceId, method: input.method, version: version.n, effectiveFrom: version.effectiveFrom, withdrawn: false, versionCount: version.n };
  });
}

/**
 * Retira uma versão que AINDA NÃO passou a valer (vigência futura publicada por engano). Os valores da versão não mudam —
 * só uma marca com motivo; versão já vigente (ou passada) nunca é retirada: publica-se uma nova.
 */
export async function withdrawFeeRuleVersion(db: Firestore, actor: Actor, raw: unknown, clock: () => Date = () => new Date()): Promise<RuleCommandResult & { replayed: boolean }> {
  authorize(actor, "finance.manage");
  const input = withdrawSchema.parse(raw);
  const seriesId = seriesIdOf(input.sourceId, input.method);
  return runIdempotentCommand(db, actor, { scope: "finance.rule.withdraw", key: input.key, payload: input, allow: allowFinance }, async ({ tx, actor: current, auditId }) => {
    const today = localDateOf(clock());
    const seriesRef = db.doc(`feeSeries/${seriesId}`);
    const snap = await tx.get(seriesRef);
    const versions = parseVersions(snap);
    const target = versions.find((v) => v.n === input.version);
    if (!target) throw notFound("version_not_found", "Versão não encontrada.");
    if (target.withdrawn) throw conflict("already_withdrawn", "Versão já retirada.");
    if (target.effectiveFrom <= today) throw conflict("version_in_effect", "A versão já passou a valer: publique uma nova em vez de retirá-la.", { effectiveFrom: target.effectiveFrom });
    const next = versions.map((v) => (v.n === target.n ? { ...v, withdrawn: { byUid: current.uid, on: today, reason: input.reason } } : v));
    tx.update(seriesRef, { versions: next, updatedAt: FieldValue.serverTimestamp() });
    auditInTransaction(db, tx, auditId, { action: "finance.rule.withdraw", actorUid: current.uid, actorRole: current.role ?? null, target: { type: "feeSeries", id: seriesId }, reason: input.reason, after: { version: target.n, effectiveFrom: target.effectiveFrom } });
    return { seriesId, sourceId: input.sourceId, method: input.method, version: target.n, effectiveFrom: target.effectiveFrom, withdrawn: true, versionCount: versions.length };
  });
}
