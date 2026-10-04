import type { Firestore, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { addDays, localDateOf } from "@/lib/dates/school-time";
import { z } from "zod";
import type { Actor } from "@/modules/access/actor";
import { authorize } from "@/modules/access/authorize";
import { normalizeName } from "@/modules/students/normalize";
import {
  OPEN_STATUSES,
  NOT_PICKED_UP,
  aggregatePreparation,
  canceledOf,
  dayQuerySchema,
  deliveredOf,
  isNotPickedUp,
  remainingOf,
  totalsOf,
  remainingValueOf,
  type DayItemView,
  type DayOrderView,
  type DayOrders,
  type Preparation,
} from "./fulfillment-model";
import { statusInfo } from "./history-model";
import type { OrderItem } from "./model";

/**
 * Consultas operacionais (F13): "Pedidos do dia" e "O que preparar". SEMPRE pelo servidor com `orders.operate`: o documento
 * do pedido traz dados internos (reservas, autor, política), então `orders` segue fechado ao cliente nas Rules. Os dias
 * são lidos por IGUALDADE em `consumptionDate` (+ turno): nenhuma consulta composta nova, e os filtros por turma/situação/
 * nome são aplicados aqui sobre no máximo `MAX_DAY_ORDERS` pedidos (escola de ~300 alunos × até 2 turnos). Passou do teto,
 * a resposta diz `truncated` em vez de fingir que a lista está completa.
 */
export const MAX_DAY_ORDERS = 1000;
export const MAX_FORECAST_ORDERS = 3000;
export const MAX_ATTENTION = 200;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Ordena alunos sem turma depois de todas as turmas. */
const LAST = "￿";

type RawOrder = { id: string; data: FirebaseFirestore.DocumentData };

const toRaw = (docs: readonly QueryDocumentSnapshot[]): RawOrder[] => docs.map((d) => ({ id: d.id, data: d.data() }));
const itemsOf = (data: FirebaseFirestore.DocumentData): OrderItem[] => (Array.isArray(data.items) ? (data.items as OrderItem[]) : []);

async function namesOf(db: Firestore, collection: "classes" | "shifts"): Promise<{ id: string; name: string }[]> {
  const snap = await db.collection(collection).where("status", "==", "active").get();
  return snap.docs.map((d) => ({ id: d.id, name: String(d.get("name") ?? d.id) })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

async function studentClasses(db: Firestore, studentIds: readonly string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(studentIds.filter((id) => ID.test(id)))];
  const out = new Map<string, string | null>();
  for (let i = 0; i < unique.length; i += 300) {
    const snaps = await db.getAll(...unique.slice(i, i + 300).map((id) => db.doc(`students/${id}`)));
    for (const s of snaps) out.set(s.id, s.exists && typeof s.get("classId") === "string" ? String(s.get("classId")) : null);
  }
  return out;
}

const dayItem = (i: OrderItem): DayItemView => ({
  lineNo: i.lineNo,
  productId: i.productId,
  name: i.name,
  quantity: i.quantity,
  deliveredQty: deliveredOf(i),
  canceledQty: canceledOf(i),
  remainingQty: remainingOf(i),
});

/** Pedidos de uma data (e turno), com turma ATUAL do aluno, filtros por turma/situação e busca por nome. */
export async function listDayOrders(db: Firestore, actor: Actor, rawQuery: unknown, clock: () => Date = () => new Date()): Promise<DayOrders> {
  authorize(actor, "orders.operate");
  const q = dayQuerySchema.parse(rawQuery);
  const today = localDateOf(clock());
  const date = q.date ?? today;

  let query: Query = db.collection("orders").where("consumptionDate", "==", date);
  if (q.shiftId) query = query.where("shiftId", "==", q.shiftId);
  const snap = await query.limit(MAX_DAY_ORDERS + 1).get();
  const truncated = snap.size > MAX_DAY_ORDERS;
  const raw = toRaw(truncated ? snap.docs.slice(0, MAX_DAY_ORDERS) : snap.docs);

  const [classes, shifts, classOf] = await Promise.all([namesOf(db, "classes"), namesOf(db, "shifts"), studentClasses(db, raw.map((o) => String(o.data.studentId)))]);
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
  const needle = q.q ? normalizeName(q.q) : "";

  const all: DayOrderView[] = raw
    .filter((o) => o.data.channel === "advance")
    .map((o) => {
      const items = itemsOf(o.data);
      const status = String(o.data.status ?? "paid");
      const classId = classOf.get(String(o.data.studentId)) ?? null;
      const totals = totalsOf(items);
      return {
        orderId: o.id,
        studentId: String(o.data.studentId),
        studentName: String(o.data.studentName ?? ""),
        classId,
        className: classId ? (className.get(classId) ?? null) : null,
        shiftId: String(o.data.shiftId ?? ""),
        shiftName: shiftName.get(String(o.data.shiftId ?? "")) ?? null,
        consumptionDate: String(o.data.consumptionDate),
        status,
        statusLabel: statusInfo(status).label,
        items: items.map(dayItem),
        totalUnits: totals.scheduled,
        remainingUnits: isNotPickedUp(status) ? 0 : totals.remaining,
        needsResolution: status === NOT_PICKED_UP,
        version: Number(o.data.version ?? 1),
      };
    })
    .filter((o) => (!q.classId || o.classId === q.classId) && (!needle || normalizeName(o.studentName).includes(needle)));

  const counts: Record<string, number> = {};
  for (const o of all) counts[o.status] = (counts[o.status] ?? 0) + 1;
  const wanted = q.status ?? "all";
  const orders = all
    .filter((o) => wanted === "all" || (wanted === "open" ? (OPEN_STATUSES as readonly string[]).includes(o.status) : o.status === wanted))
    .sort((a, b) => (a.className ?? LAST).localeCompare(b.className ?? LAST, "pt-BR") || a.studentName.localeCompare(b.studentName, "pt-BR") || a.orderId.localeCompare(b.orderId));
  return { date, today, canDeliver: date === today, orders, truncated, counts, classes, shifts };
}

/** Painel "O que preparar": totais da data/turno + previsão dos próximos sete dias + pendências de resolução. */
export async function preparationPanel(db: Firestore, actor: Actor, rawQuery: unknown, clock: () => Date = () => new Date()): Promise<Preparation> {
  authorize(actor, "orders.operate");
  const q = z.object({ date: dayQuerySchema.shape.date, shiftId: dayQuerySchema.shape.shiftId, scope: z.enum(["all", "attention"]).default("all") }).strict().parse(rawQuery);
  const today = localDateOf(clock());
  const date = q.date ?? today;
  const attentionOnly = q.scope === "attention";
  const forecastTo = addDays(today, 6);

  let dayQuery: Query = db.collection("orders").where("consumptionDate", "==", date);
  if (q.shiftId) dayQuery = dayQuery.where("shiftId", "==", q.shiftId);
  // Intervalo em UM campo, sem igualdade em outro: não exige índice composto. O turno é filtrado em memória (igualdade de turno +
  // intervalo de data pediria o composto shiftId+consumptionDate, que o emulador não cobra mas o Firestore real exige).
  const forecastQuery: Query = db.collection("orders").where("consumptionDate", ">=", today).where("consumptionDate", "<=", forecastTo);

  const [daySnap, forecastSnap, markedSnap, overdueSnap, shifts] = await Promise.all([
    // `scope=attention` (aviso da lista do dia): só as pendências, sem ler o dia nem a previsão.
    attentionOnly ? Promise.resolve(null) : dayQuery.limit(MAX_DAY_ORDERS + 1).get(),
    attentionOnly ? Promise.resolve(null) : forecastQuery.limit(MAX_FORECAST_ORDERS + 1).get(),
    db.collection("orders").where("status", "==", NOT_PICKED_UP).limit(MAX_ATTENTION + 1).get(),
    db.collection("orders").where("status", "in", [...OPEN_STATUSES]).where("consumptionDate", "<", today).limit(MAX_ATTENTION + 1).get(),
    namesOf(db, "shifts"),
  ]);
  const prepOf = (docs: readonly QueryDocumentSnapshot[]) =>
    toRaw(docs)
      .filter((o) => o.data.channel === "advance")
      .map((o) => ({ consumptionDate: String(o.data.consumptionDate), shiftId: String(o.data.shiftId ?? ""), status: String(o.data.status ?? "paid"), items: itemsOf(o.data) }));

  const forecastTruncated = (forecastSnap?.size ?? 0) > MAX_FORECAST_ORDERS;
  const advanceOnly = (d: QueryDocumentSnapshot) => d.get("channel") === "advance";
  const attention = [...markedSnap.docs.filter(advanceOnly).slice(0, MAX_ATTENTION).map((d) => ({ d, marked: true })), ...overdueSnap.docs.filter(advanceOnly).slice(0, MAX_ATTENTION).map((d) => ({ d, marked: false }))]
    .map(({ d, marked }) => {
      const items = itemsOf(d.data());
      return {
        orderId: d.id,
        studentName: String(d.get("studentName") ?? ""),
        consumptionDate: String(d.get("consumptionDate")),
        shiftId: String(d.get("shiftId") ?? ""),
        status: String(d.get("status")),
        remainingUnits: totalsOf(items).remaining,
        remainingCents: items.reduce((sum, i) => sum + remainingValueOf(i), 0),
        marked,
      };
    })
    .sort((a, b) => a.consumptionDate.localeCompare(b.consumptionDate) || a.studentName.localeCompare(b.studentName, "pt-BR"));

  return {
    date,
    today,
    shiftId: q.shiftId ?? null,
    rows: daySnap ? aggregatePreparation(prepOf(daySnap.docs.slice(0, MAX_DAY_ORDERS))) : [],
    forecast: forecastSnap ? aggregatePreparation(prepOf(forecastSnap.docs.slice(0, MAX_FORECAST_ORDERS)).filter((o) => !q.shiftId || o.shiftId === q.shiftId)) : [],
    forecastFrom: today,
    forecastTo,
    attention,
    truncated: (daySnap?.size ?? 0) > MAX_DAY_ORDERS || forecastTruncated || markedSnap.size > MAX_ATTENTION || overdueSnap.size > MAX_ATTENTION,
    shifts,
  };
}
