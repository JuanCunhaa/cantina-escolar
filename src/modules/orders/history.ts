import type { Firestore, Query, Timestamp } from "firebase-admin/firestore";
import type { Actor } from "@/modules/access/actor";
import { authorizeStudent } from "@/modules/access/authorize";
import { ForbiddenError } from "@/modules/access/errors";
import { invalid } from "@/lib/domain-error";
import {
  compareNewestFirst,
  listFiltersSchema,
  statusInfo,
  statusesOf,
  type OrderDetail,
  type OrderItemView,
  type OrderPage,
  type OrderView,
} from "./history-model";

import { decodeCursor, encodeCursor } from "./history-cursor";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Histórico e detalhe de pedidos (F12). SEMPRE pelo servidor autenticado: o documento `orders/{id}` contém dados internos
 * (reservas de estoque, autor, exceções, política) e as Rules autorizam documento inteiro, então o cliente não lê
 * `orders` direto (Rules fechadas). Aqui o documento vira uma VISÃO com só o que a família pode ver, e a autorização usa
 * vínculo/perfil lidos na hora (vínculo revogado = negado, mesmo com sessão ou listener abertos).
 */
const iso = (value: unknown): string | null => (value && typeof (value as Timestamp).toDate === "function" ? (value as Timestamp).toDate().toISOString() : null);

function toItem(raw: unknown): OrderItemView | null {
  const i = raw as Record<string, unknown> | null;
  if (!i || typeof i.name !== "string") return null;
  return {
    lineNo: Number(i.lineNo),
    productId: String(i.productId ?? ""),
    name: i.name,
    unit: "un",
    quantity: Number(i.quantity),
    unitPriceCents: Number(i.unitPriceCents),
    discountCents: Number(i.discountCents ?? 0),
    subtotalCents: Number(i.subtotalCents),
  };
}

/** Visão do pedido a partir do SNAPSHOT gravado na compra; nome/preço atuais do produto nunca entram. */
export function toOrderView(id: string, d: FirebaseFirestore.DocumentData, shiftNames: ReadonlyMap<string, string>): OrderView {
  const status = typeof d.status === "string" ? d.status : "paid";
  const info = statusInfo(status);
  const shiftId = String(d.shiftId ?? "");
  return {
    orderId: id,
    studentId: String(d.studentId),
    studentName: String(d.studentName ?? ""),
    consumptionDate: String(d.consumptionDate),
    shiftId,
    shiftName: shiftNames.get(shiftId) ?? null,
    channel: String(d.channel ?? "advance"),
    status,
    group: info.group,
    statusLabel: info.label,
    paymentState: info.payment,
    items: ((d.items as unknown[] | undefined) ?? []).flatMap((x) => toItem(x) ?? []),
    itemCount: Number(d.itemCount ?? 0),
    totalCents: Number(d.totalCents),
    createdAt: iso(d.createdAt),
    version: Number(d.version ?? 1),
  };
}

async function shiftNamesOf(db: Firestore, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => ID.test(id)))];
  if (unique.length === 0) return new Map();
  const snaps = await db.getAll(...unique.map((id) => db.doc(`shifts/${id}`)));
  return new Map(snaps.flatMap((s) => (s.exists && typeof s.get("name") === "string" ? [[s.id, String(s.get("name"))] as const] : [])));
}

/** Alunos que o ator pode consultar quando não informa um: vínculos ativos do responsável ou o próprio aluno. */
async function scopeStudents(db: Firestore, actor: Actor, requested: string | undefined): Promise<string[]> {
  if (!actor.role) throw new ForbiddenError("Sem perfil ativo.");
  if (requested) {
    await authorizeStudent(db, actor, requested, "orders.read");
    return [requested];
  }
  let ids: string[] = [];
  if (actor.role === "guardian") {
    const links = await db.collection("guardianStudentLinks").where("guardianUid", "==", actor.uid).where("status", "==", "active").get();
    ids = links.docs.map((l) => String(l.get("studentId")));
  } else if (actor.role === "student") {
    const own = (await db.doc(`uniquenessKeys/studentLogin_${actor.uid}`).get()).get("studentId");
    if (typeof own === "string") ids = [own];
  } else throw invalid("student_required", "Informe o aluno.");
  ids = ids.filter((id) => ID.test(id));
  // Cada aluno é reautorizado com o vínculo/perfil atuais; quem perdeu acesso entre as duas leituras sai da consulta.
  const checks = await Promise.all(
    ids.map(async (id) => {
      try {
        await authorizeStudent(db, actor, id, "orders.read");
        return true;
      } catch (error) {
        if (error instanceof ForbiddenError) return false;
        throw error;
      }
    }),
  );
  return ids.filter((_, i) => checks[i]);
}

/**
 * Uma página do histórico, mais novos primeiro (data de consumo desc, ID desc). Cursor opaco = último (data, ID) devolvido:
 * como a ordem é total e idêntica para todos os alunos, o cursor não duplica nem omite pedidos mesmo com várias consultas
 * (uma por aluno, cada uma limitada a `limit + 1`) e as fusões em memória. Filtros por aluno, situação/aba, canal, turno
 * e período são igualdades/intervalo da própria consulta (índices em firestore.indexes.json).
 */
export async function listOrders(db: Firestore, actor: Actor, rawFilters: unknown): Promise<OrderPage> {
  const f = listFiltersSchema.parse(rawFilters);
  const cursor = f.cursor ? decodeCursor(f.cursor) : null;
  if (f.cursor && !cursor) throw invalid("invalid_cursor", "Cursor inválido.");
  const studentIds = await scopeStudents(db, actor, f.studentId);

  const groupStatuses = statusesOf(f.group);
  // Situação detalhada que não pertence à aba escolhida não tem resultado possível.
  const statuses = f.status ? (groupStatuses && !groupStatuses.includes(f.status) ? [] : [f.status]) : groupStatuses;

  const page = async (studentId: string) => {
    if (statuses && statuses.length === 0) return [];
    let q: Query = db.collection("orders").where("studentId", "==", studentId);
    if (statuses) q = statuses.length === 1 ? q.where("status", "==", statuses[0]!) : q.where("status", "in", statuses);
    if (f.channel) q = q.where("channel", "==", f.channel);
    if (f.shiftId) q = q.where("shiftId", "==", f.shiftId);
    if (f.from) q = q.where("consumptionDate", ">=", f.from);
    if (f.to) q = q.where("consumptionDate", "<=", f.to);
    q = q.orderBy("consumptionDate", "desc").orderBy("orderId", "desc");
    if (cursor) q = q.startAfter(cursor.d, cursor.o);
    return (await q.limit(f.limit + 1).get()).docs;
  };
  const pages = await Promise.all(studentIds.map(page));
  const merged = pages.flat().sort((a, b) => compareNewestFirst({ consumptionDate: String(a.get("consumptionDate")), orderId: a.id }, { consumptionDate: String(b.get("consumptionDate")), orderId: b.id }));
  const slice = merged.slice(0, f.limit);
  const hasMore = merged.length > f.limit;

  const [names, studentSnaps, shifts] = await Promise.all([
    shiftNamesOf(db, slice.map((d) => String(d.get("shiftId")))),
    studentIds.length ? db.getAll(...studentIds.map((id) => db.doc(`students/${id}`))) : Promise.resolve([]),
    cursor ? Promise.resolve(null) : db.collection("shifts").where("status", "==", "active").get(),
  ]);
  const orders = slice.map((d) => toOrderView(d.id, d.data(), names));
  const last = orders[orders.length - 1];
  return {
    orders,
    nextCursor: hasMore && last ? encodeCursor({ d: last.consumptionDate, o: last.orderId }) : null,
    students: studentSnaps.flatMap((s) => (s.exists ? [{ id: s.id, name: String(s.get("name") ?? "") }] : [])),
    shifts: shifts ? shifts.docs.map((s) => ({ id: s.id, name: String(s.get("name") ?? s.id) })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")) : null,
  };
}

/**
 * Detalhe + recibo interno. ID inexistente e pedido de outra família respondem igual (403): quem não tem vínculo atual
 * não descobre se o pedido existe. Só campos de exibição: UID do autor, exceções, reservas e política não saem.
 */
export async function getOrderDetail(db: Firestore, actor: Actor, orderId: string): Promise<OrderDetail> {
  if (!ID.test(orderId)) throw new ForbiddenError("Pedido inválido.");
  const snap = await db.doc(`orders/${orderId}`).get();
  const d = snap.data();
  if (!d || typeof d.studentId !== "string") throw new ForbiddenError("Sem acesso ao pedido.");
  await authorizeStudent(db, actor, d.studentId, "orders.read");

  const entryId = typeof d.walletEntryId === "string" && ID.test(d.walletEntryId) ? d.walletEntryId : null;
  const [names, entry] = await Promise.all([shiftNamesOf(db, [String(d.shiftId ?? "")]), entryId ? db.doc(`wallets/${d.studentId}/entries/${entryId}`).get() : Promise.resolve(null)]);
  const view = toOrderView(snap.id, d, names);
  const role = d.createdByRole;
  const policy = (d.policy ?? {}) as { cancelCutoffAt?: unknown };
  const createdAt = view.createdAt;
  return {
    ...view,
    purchasedBy: role === "guardian" || role === "student" ? role : role ? "staff" : null,
    cancelDeadlineAt: iso(policy.cancelCutoffAt),
    timeline: [
      { kind: "created", at: createdAt, label: "Pedido criado" },
      ...(view.paymentState === "paid" ? [{ kind: "paid" as const, at: createdAt, label: "Pago com o saldo da carteira" }] : []),
    ],
    receipt: {
      walletEntryId: entryId ?? "",
      seq: entry?.exists ? Number(entry.get("seq")) : null,
      amountCents: entry?.exists ? Number(entry.get("amountCents")) : null,
      balanceAfterCents: entry?.exists ? Number(entry.get("balanceAfterCents")) : null,
      reason: entry?.exists && typeof entry.get("reason") === "string" ? String(entry.get("reason")) : null,
      createdAt: entry?.exists ? iso(entry.get("createdAt")) : null,
    },
  };
}
