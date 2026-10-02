import type { Firestore, Transaction } from "firebase-admin/firestore";
import { isLocalDate } from "@/lib/dates/school-time";
import { invalid, notFound } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { decideStudentAction, studentAccessRefs } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { parseProduct, type Channel, type PublicProduct } from "@/modules/catalog/model";
import { purchaseWindow } from "@/modules/school/settings";
import { DEFAULT_MENU_RULES, overrideRef, ruleRef } from "./commands";
import {
  evaluateMenuSale,
  isDocId,
  parseDefaultRule,
  parseOverride,
  resolveMenu,
  type MenuDay,
  type MenuSellability,
  type MenuService,
  type MenuWeek,
} from "./model";

/**
 * Leitura canônica do cardápio para uma venda, DENTRO da transação do comando (checkout F11 / PDV F15): lê a exceção da
 * data/turno, as regras padrão e os produtos pedidos (IDs conhecidos, poucas leituras) e devolve, por produto, o
 * preço/versões atuais e a origem/limite, ou o motivo da recusa. Calendário e horário são do `checkPurchase` (F05).
 */
export async function readMenuForSale(
  db: Firestore,
  tx: Transaction,
  input: { date: string; shiftId: string; channel: Channel; productIds: readonly string[] },
): Promise<Map<string, MenuSellability>> {
  if (!isLocalDate(input.date)) throw invalid("invalid_date", "Data inválida.");
  if (!isDocId(input.shiftId)) throw invalid("invalid_shift", "Turno inválido.");
  const result = new Map<string, MenuSellability>();
  const ids = [...new Set(input.productIds)];
  const valid = ids.filter(isDocId);
  for (const id of ids) if (!isDocId(id)) result.set(id, { ok: false, reason: "product_not_found" });
  if (valid.length === 0) return result;
  const [overrideSnap, ...snaps] = await tx.getAll(
    overrideRef(db, input.date, input.shiftId),
    ...valid.map((id) => db.doc(`products/${id}`)),
    ...valid.map((id) => ruleRef(db, id)),
  );
  const override = overrideSnap?.exists ? parseOverride(input.date, input.shiftId, overrideSnap.data()) : null;
  valid.forEach((id, index) => {
    const productSnap = snaps[index];
    const product = productSnap?.exists ? parseProduct(id, productSnap.data()) : null;
    const rule = parseDefaultRule(id, snaps[valid.length + index]?.data());
    result.set(id, evaluateMenuSale(product, { channel: input.channel, shiftId: input.shiftId }, rule, override));
  });
  return result;
}

/* ------------------------------------------------------------------------------------------ portal (leitura) */

/**
 * Cardápio da janela de compra (hoje … hoje+7) para um aluno, resolvido no servidor: o turno vem do cadastro ATUAL do
 * aluno; a leitura exige `view` (responsável vinculado ativo, o próprio aluno ou equipe), com vínculo/perfil atuais.
 * O aluno com login pode omitir `studentId` (usa o próprio cadastro). `date` restringe a resposta a um dia e precisa
 * estar na janela. Exibição apenas: o checkout revalida tudo na própria transação.
 */
export async function getMenuWeek(
  db: Firestore,
  actor: Actor,
  input: { studentId: string | null; date: string | null },
  now: Date = new Date(),
): Promise<MenuWeek> {
  if (!actor.role) throw new ForbiddenError("Sem perfil ativo.");
  let studentId = input.studentId;
  if (!studentId) {
    if (actor.role !== "student") throw invalid("student_required", "Informe o aluno.");
    const own = (await db.doc(`uniquenessKeys/studentLogin_${actor.uid}`).get()).get("studentId");
    if (typeof own !== "string") throw notFound("student_not_found", "Nenhum aluno ligado a esta conta.");
    studentId = own;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(studentId)) throw new ForbiddenError("Aluno inválido.");

  const [studentSnap, linkSnap, policySnap] = await db.getAll(...studentAccessRefs(db, actor, studentId));
  const student = studentSnap?.data();
  const decide = (action: "view" | "purchase.site") =>
    decideStudentAction({ actor, studentId, action, student, link: linkSnap?.data(), policy: policySnap?.data() });
  if (!decide("view")) throw new ForbiddenError("Sem acesso ao aluno (view).");

  const shiftId = typeof student?.shiftId === "string" && isDocId(student.shiftId) ? student.shiftId : null;
  if (!shiftId) throw notFound("shift_unavailable", "Turno do aluno inexistente.");
  const window = await purchaseWindow(db, shiftId, now);
  const dates = window.days.map((d) => d.date);
  if (input.date !== null) {
    if (!isLocalDate(input.date)) throw invalid("invalid_date", "Data inválida.");
    if (input.date < window.today) throw invalid("past_date", "Data passada.");
    if (!dates.includes(input.date)) throw invalid("beyond_window", "Compra possível só de hoje até 7 dias à frente.");
  }

  const [shiftSnap, overrideSnaps, rulesSnap, productsSnap, categoriesSnap] = await Promise.all([
    db.doc(`shifts/${shiftId}`).get(),
    db.getAll(...dates.map((date) => overrideRef(db, date, shiftId))),
    db.collection(DEFAULT_MENU_RULES).where("shiftIds", "array-contains", shiftId).get(),
    db.collection("products").where("status", "==", "active").get(),
    db.collection("categories").get(),
  ]);
  const rules = new Map(rulesSnap.docs.map((d) => [d.id, parseDefaultRule(d.id, d.data())]));
  const products = productsSnap.docs.flatMap((d) => parseProduct(d.id, d.data()) ?? []);
  const categoryName = new Map(categoriesSnap.docs.map((d) => [d.id, String(d.get("name") ?? "")]));

  const offered = new Map<string, PublicProduct>();
  const days = window.days
    .map((day, index): MenuDay => {
      const snap = overrideSnaps[index];
      const override = snap?.exists ? parseOverride(day.date, shiftId, snap.data()) : null;
      const service: MenuService = !day.operating ? "closed" : override?.suspended ? "suspended" : "open";
      const items = service === "open" ? resolveMenu({ shiftId, products, rules, override }).items : [];
      const allowed = day.allowed && service === "open";
      return {
        date: day.date,
        operating: day.operating,
        service,
        allowed,
        reason: allowed ? null : (day.reason ?? (service === "suspended" ? "service_suspended" : null)),
        purchaseCutoffAt: allowed ? day.purchaseCutoffAt : null,
        cancelCutoffAt: allowed ? day.cancelCutoffAt : null,
        items: items.map((item) => {
          if (input.date === null || input.date === day.date) offered.set(item.product.id, item.product);
          return { productId: item.product.id, source: item.source, limited: item.limit !== null };
        }),
      };
    })
    .filter((day) => input.date === null || day.date === input.date);

  return {
    timezone: window.timezone,
    serverNow: window.serverNow,
    today: window.today,
    student: {
      id: studentId,
      name: typeof student?.name === "string" ? student.name : "",
      shiftId,
      shiftName: String(shiftSnap.get("name") ?? ""),
      active: student?.status === "active",
    },
    canPurchase: decide("purchase.site"),
    cutoffs: window.cutoffs,
    days,
    products: [...offered.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        categoryId: p.categoryId,
        categoryName: categoryName.get(p.categoryId) ?? "",
        priceCents: p.priceCents,
        priceVersion: p.priceVersion,
        photoPath: p.photoPath,
        channels: p.channels,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
  };
}
