import type { Firestore } from "firebase-admin/firestore";
import { localDateOf } from "@/lib/dates/school-time";
import { DomainError, conflict, notFound } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { parseProduct } from "@/modules/catalog/model";
import { DEFAULT_MENU_RULES, overrideRef } from "@/modules/menu/commands";
import { parseDefaultRule, parseOverride, resolveMenu } from "@/modules/menu/model";
import { purchaseWindow } from "@/modules/school/settings";
import type { AmendOptions } from "./amend-model";
import { deliveredOf, isOpenStatus, totalsOf } from "./fulfillment-model";
import type { OrderItem } from "./model";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Opções de reagendamento/troca para a tela da EQUIPE (`orders.amend`; leitura pelo servidor, `orders` segue fechado ao cliente).
 * Exibição apenas: os comandos revalidam tudo na própria transação. Destinos = janela hoje…hoje+7 no turno ATUAL do aluno
 * (`cutoffPassed` = só com a exceção operacional explícita); produtos = cardápio do canal antecipado na data/turno DO PEDIDO.
 */
export async function amendOptions(db: Firestore, actor: Actor, orderId: string, clock: () => Date = () => new Date()): Promise<AmendOptions> {
  authorize(actor, "orders.amend");
  if (!ID.test(orderId)) throw new ForbiddenError("Pedido inválido.");
  const now = clock();
  const today = localDateOf(now);
  const snap = await db.doc(`orders/${orderId}`).get();
  const d = snap.data();
  if (!d || typeof d.studentId !== "string") throw notFound("order_not_found", "Pedido não encontrado.");
  if (d.channel !== "advance") throw conflict("channel_not_supported", "Este comando atende pedidos antecipados.");
  const items = (Array.isArray(d.items) ? d.items : []) as OrderItem[];
  const status = String(d.status ?? "paid");
  const date = String(d.consumptionDate);
  const shiftId = String(d.shiftId ?? "");
  const student = await db.doc(`students/${d.studentId}`).get();
  const studentShiftId = typeof student.get("shiftId") === "string" && ID.test(String(student.get("shiftId"))) ? String(student.get("shiftId")) : null;
  const studentActive = student.get("status") === "active";

  let destinations: AmendOptions["destinations"] = [];
  if (studentShiftId) {
    try {
      const window = await purchaseWindow(db, studentShiftId, now);
      destinations = window.days.map((day) => {
        const cutoffPassed = day.reason === "after_cutoff";
        return { date: day.date, operating: day.operating, allowed: day.allowed || cutoffPassed, cutoffPassed, reason: day.allowed || cutoffPassed ? null : day.reason };
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error; // turno arquivado/sem horário: nenhum destino oferecido
    }
  }

  let products: AmendOptions["products"] = [];
  if (date >= today && isOpenStatus(status)) {
    const [overrideSnap, rulesSnap, productsSnap, categoriesSnap] = await Promise.all([
      overrideRef(db, date, shiftId).get(),
      db.collection(DEFAULT_MENU_RULES).where("shiftIds", "array-contains", shiftId).get(),
      db.collection("products").where("status", "==", "active").get(),
      db.collection("categories").get(),
    ]);
    const override = overrideSnap.exists ? parseOverride(date, shiftId, overrideSnap.data()) : null;
    const rules = new Map(rulesSnap.docs.map((x) => [x.id, parseDefaultRule(x.id, x.data())]));
    const catalog = productsSnap.docs.flatMap((x) => parseProduct(x.id, x.data()) ?? []);
    const categoryName = new Map(categoriesSnap.docs.map((x) => [x.id, String(x.get("name") ?? "")]));
    products = resolveMenu({ shiftId, products: catalog, rules, override })
      .items.filter((i) => i.product.channels.includes("advance"))
      .map((i) => ({ id: i.product.id, name: i.product.name, priceCents: i.product.priceCents, photoPath: i.product.photoPath, categoryName: categoryName.get(i.product.categoryId) ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  const remaining = totalsOf(items).remaining;
  const anyDelivered = items.some((i) => deliveredOf(i) > 0);
  const movable = ["paid", "preparing", "ready"].includes(status) && !anyDelivered && remaining > 0;
  const exchangeable = isOpenStatus(status) && date >= today && remaining > 0;
  const blockedReason = !studentActive
    ? "Aluno inativo: só cancelar e reembolsar."
    : status === "not_picked_up"
      ? "Não retirado: a administração resolve (reagendar, reembolsar ou encerrar)."
      : anyDelivered && isOpenStatus(status)
        ? "Parte já entregue: o restante pode ser trocado, mas não reagendado."
        : !isOpenStatus(status)
          ? "Pedido encerrado."
          : null;
  return {
    orderId,
    version: Number(d.version ?? 1),
    studentId: d.studentId,
    studentName: String(d.studentName ?? ""),
    studentActive,
    consumptionDate: date,
    shiftId,
    today,
    studentShiftId,
    destinations,
    products,
    canReschedule: studentActive && movable,
    canExchange: studentActive && exchangeable,
    blockedReason,
  };
}
