import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { localDateOf, weekStartOf, type LocalDate } from "@/lib/dates/school-time";
import { invalid, notFound } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { allocateFefo, availableAt, eligibleOn, parseBalance, parseLot, type StockMode } from "@/modules/inventory/model";
import { DEFAULT_MENU_RULES, overrideRef } from "@/modules/menu/commands";
import { isDocId, parseDefaultRule, parseOverride, resolveMenu } from "@/modules/menu/model";
import { parseProduct } from "@/modules/catalog/model";
import { parseException, parsePolicy } from "@/modules/policies/model";
import { checkCounterDay } from "@/modules/school/settings";
import { parseWalletState } from "@/modules/wallet/model";

/**
 * Leituras do PDV (F15), sempre pelo servidor com `pos.operate` (a equipe não lê `students`, carteira nem estoque pelo
 * cliente). Exibição apenas: a venda revalida tudo na própria transação. Nada de custo, fornecedor, e-mail/telefone de
 * responsável ou UID de autor sai daqui.
 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Teto de alunos ativos lidos para a lista do balcão (escola de ~300 alunos); passou disso, a resposta diz `truncated`. */
export const MAX_ROSTER = 1000;

export type PosStudentRow = { id: string; name: string; enrollment: string; classId: string; className: string | null; shiftId: string; shiftName: string | null };
export type PosRoster = { students: PosStudentRow[]; truncated: boolean; today: LocalDate; /** Turnos ativos (a venda direta escolhe o turno do cardápio). */ shifts: { id: string; name: string; slug: string }[] };

async function namesOf(db: Firestore, collection: "classes" | "shifts"): Promise<Map<string, string>> {
  const snap = await db.collection(collection).get();
  return new Map(snap.docs.map((d) => [d.id, String(d.get("name") ?? d.id)] as const));
}

/**
 * Lista dos alunos ATIVOS com turma e turno (diferenciam homônimos), ordenada por nome. A busca por nome/sobrenome/trecho
 * (sem acento) roda no navegador sobre esta lista, que é carregada uma vez e atualizada sob demanda: nenhuma leitura por tecla.
 */
export async function posRoster(db: Firestore, actor: Actor, clock: () => Date = () => new Date()): Promise<PosRoster> {
  authorize(actor, "pos.operate");
  return readActiveRoster(db, clock);
}

/** Leitura da lista de alunos ativos SEM autorização: o chamador (PDV, secretaria) autoriza antes. */
export async function readActiveRoster(db: Firestore, clock: () => Date = () => new Date()): Promise<PosRoster> {
  const [snap, classes, shiftDocs] = await Promise.all([db.collection("students").where("status", "==", "active").limit(MAX_ROSTER + 1).get(), namesOf(db, "classes"), db.collection("shifts").where("status", "==", "active").get()]);
  const shifts = new Map(shiftDocs.docs.map((d) => [d.id, String(d.get("name") ?? d.id)] as const));
  const truncated = snap.size > MAX_ROSTER;
  const students = (truncated ? snap.docs.slice(0, MAX_ROSTER) : snap.docs)
    .map((d): PosStudentRow => ({
      id: d.id,
      name: String(d.get("name") ?? ""),
      enrollment: String(d.get("enrollment") ?? ""),
      classId: String(d.get("classId") ?? ""),
      className: classes.get(String(d.get("classId") ?? "")) ?? null,
      shiftId: String(d.get("shiftId") ?? ""),
      shiftName: shifts.get(String(d.get("shiftId") ?? "")) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id));
  const activeShifts = shiftDocs.docs.map((d) => ({ id: d.id, name: String(d.get("name") ?? d.id), slug: String(d.get("nameSlug") ?? "") })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return { students, truncated, today: localDateOf(clock()), shifts: activeShifts };
}

export type PosStudent = {
  student: PosStudentRow & { status: string };
  wallet: { balanceCents: number; version: number };
  /** Permissão de compra no balcão ATUAL do aluno (o responsável a concede e revoga). */
  counterAllowed: boolean;
  restrictions: {
    dailyLimitCents: number | null;
    weeklyLimitCents: number | null;
    /** Comprometido em HOJE e na semana de hoje (pedidos antecipados ativos + entregues + balcão − reembolsos). */
    dayCommittedCents: number;
    weekCommittedCents: number;
    weekStart: LocalDate;
    /** Quanto ainda cabe hoje: o menor entre diário e semanal; `null` = sem teto parental (não é saldo infinito). */
    remainingTodayCents: number | null;
    blockedProductIds: string[];
    blockedCategoryIds: string[];
  };
  /** Exceções de uso único ativas para HOJE (autorização do responsável ou administrativa). */
  exceptions: { id: string; kind: "guardian" | "admin"; maxCents: number }[];
  today: LocalDate;
};

export const studentIdSchema = z.string().regex(ID);

/** Aluno escolhido: saldo e restrições pertinentes à venda de hoje. Aluno inexistente = 404. */
export async function posStudent(db: Firestore, actor: Actor, rawStudentId: unknown, clock: () => Date = () => new Date()): Promise<PosStudent> {
  authorize(actor, "pos.operate");
  const studentId = studentIdSchema.parse(rawStudentId);
  const today = localDateOf(clock());
  const weekStart = weekStartOf(today);
  const [student, policySnap, walletSnap, daySnap, weekSnap, exceptionsSnap, classes, shifts] = await Promise.all([
    db.doc(`students/${studentId}`).get(),
    db.doc(`studentPolicies/${studentId}`).get(),
    db.doc(`wallets/${studentId}`).get(),
    db.doc(`studentUsage/${studentId}/days/${today}`).get(),
    db.doc(`studentUsage/${studentId}/weeks/${weekStart}`).get(),
    db.collection(`studentPolicies/${studentId}/exceptions`).where("status", "==", "active").where("consumptionDate", "==", today).limit(10).get(),
    namesOf(db, "classes"),
    namesOf(db, "shifts"),
  ]);
  // Só alunos ATIVOS (como a lista do balcão): saldo e política de aluno arquivado não saem pelo PDV.
  if (!student.exists || student.get("status") !== "active") throw notFound("student_not_found", "Aluno não encontrado.");
  const policy = parsePolicy(policySnap.data());
  const wallet = parseWalletState(walletSnap.data());
  const day = Number(daySnap.get("committedCents") ?? 0);
  const week = Number(weekSnap.get("committedCents") ?? 0);
  const rooms = [policy.dailyLimitCents === null ? null : Math.max(0, policy.dailyLimitCents - day), policy.weeklyLimitCents === null ? null : Math.max(0, policy.weeklyLimitCents - week)].filter((v): v is number => v !== null);
  return {
    student: {
      id: student.id,
      name: String(student.get("name") ?? ""),
      enrollment: String(student.get("enrollment") ?? ""),
      classId: String(student.get("classId") ?? ""),
      className: classes.get(String(student.get("classId") ?? "")) ?? null,
      shiftId: String(student.get("shiftId") ?? ""),
      shiftName: shifts.get(String(student.get("shiftId") ?? "")) ?? null,
      status: String(student.get("status") ?? ""),
    },
    wallet,
    counterAllowed: policy.allowCounterPurchase,
    restrictions: {
      dailyLimitCents: policy.dailyLimitCents,
      weeklyLimitCents: policy.weeklyLimitCents,
      dayCommittedCents: day,
      weekCommittedCents: week,
      weekStart,
      remainingTodayCents: rooms.length === 0 ? null : Math.min(...rooms),
      blockedProductIds: policy.blockedProductIds,
      blockedCategoryIds: policy.blockedCategoryIds,
    },
    exceptions: exceptionsSnap.docs.flatMap((d) => {
      const e = parseException(d.id, d.data());
      return e && e.studentId === studentId && e.status === "active" && e.consumptionDate === today ? [{ id: e.id, kind: e.kind, maxCents: e.maxCents }] : [];
    }),
    today,
  };
}

export const catalogQuerySchema = z.object({ shiftId: z.string().regex(ID) }).strict();

export type PosProduct = {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  priceCents: number;
  priceVersion: number;
  photoPath: string | null;
  mode: StockMode;
  /** Unidades que o balcão pode vender agora (físico vendável − reservas de outros pedidos). */
  availableUnits: number;
};
export type PosCatalog = {
  today: LocalDate;
  shiftId: string;
  /** `closed` = hoje não é dia de funcionamento (ou o turno não existe); `suspended` = atendimento suspenso na data/turno. */
  service: "open" | "closed" | "suspended";
  products: PosProduct[];
};

async function plannedEligible(db: Firestore, productId: string, today: LocalDate): Promise<number> {
  const snap = await db.collection(`stockBalances/${productId}/lots`).orderBy("openKey").startAt(today).limit(60).get();
  const covered = allocateFefo(snap.docs.map((d) => parseLot(d.id, d.data())), Number.MAX_SAFE_INTEGER, eligibleOn(today));
  return Number.MAX_SAFE_INTEGER - covered.unmet;
}

/** Cardápio de HOJE no canal balcão para o turno, com preço atual e disponibilidade para a venda. Sem custo. */
export async function posCatalog(db: Firestore, actor: Actor, rawQuery: unknown, clock: () => Date = () => new Date()): Promise<PosCatalog> {
  authorize(actor, "pos.operate");
  const { shiftId } = catalogQuerySchema.parse(rawQuery);
  if (!isDocId(shiftId)) throw invalid("invalid_shift", "Turno inválido.");
  const today = localDateOf(clock());
  const day = await checkCounterDay(db, { shiftId, date: today });
  if (!day.allowed) return { today, shiftId, service: "closed", products: [] };

  const [overrideSnap, rulesSnap, productsSnap, categoriesSnap] = await Promise.all([
    overrideRef(db, today, shiftId).get(),
    db.collection(DEFAULT_MENU_RULES).where("shiftIds", "array-contains", shiftId).get(),
    db.collection("products").where("status", "==", "active").get(),
    db.collection("categories").get(),
  ]);
  const override = overrideSnap.exists ? parseOverride(today, shiftId, overrideSnap.data()) : null;
  const rules = new Map(rulesSnap.docs.map((d) => [d.id, parseDefaultRule(d.id, d.data())]));
  const products = productsSnap.docs.flatMap((d) => parseProduct(d.id, d.data()) ?? []).filter((p) => p.channels.includes("counter") && (p.shiftIds.length === 0 || p.shiftIds.includes(shiftId)));
  const menu = resolveMenu({ shiftId, products, rules, override });
  if (menu.suspended) return { today, shiftId, service: "suspended", products: [] };
  const offered = menu.items.filter((item) => item.product.channels.includes("counter"));
  const categoryName = new Map(categoriesSnap.docs.map((d) => [d.id, String(d.get("name") ?? "")]));
  const balances = offered.length > 0 ? await db.getAll(...offered.map((i) => db.doc(`stockBalances/${i.product.id}`))) : [];
  const rows = await Promise.all(
    offered.map(async (item, index): Promise<PosProduct> => {
      const p = item.product;
      const mode: StockMode = p.availabilityMode === "planned" ? "planned" : "physical";
      const balance = parseBalance(p.id, mode, balances[index]?.data());
      let availableUnits: number;
      if (mode === "physical") availableUnits = availableAt(balance.supplyByValidity, balance.reservedByDate, today);
      else availableUnits = balance.onHand > 0 ? Math.max(0, (await plannedEligible(db, p.id, today)) - (balance.reservedByDate[today] ?? 0)) : 0;
      return { id: p.id, name: p.name, categoryId: p.categoryId, categoryName: categoryName.get(p.categoryId) ?? "", priceCents: p.priceCents, priceVersion: p.priceVersion, photoPath: p.photoPath, mode, availableUnits };
    }),
  );
  return { today, shiftId, service: "open", products: rows };
}
