import type { Firestore } from "firebase-admin/firestore";
import { conflict, notFound } from "@/lib/domain-error";
import type { Actor } from "@/modules/access/actor";
import { deliveredOf, remainingOf, type PrepStage } from "./fulfillment-model";
import type { OrderItem } from "./model";

/**
 * Leitura do pedido dentro da transação e utilidades compartilhadas pelos comandos que mexem no progresso do pedido
 * (entrega, não retirada/resolução e cancelamento). Só LEITURAS: nenhuma escrita acontece aqui.
 */
export const sessionActor = (actor: Actor) => ({ uid: actor.uid, role: actor.role ?? null });

export type OrderState = {
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
  items: OrderItem[];
  status: string;
  prep: PrepStage;
  version: number;
  consumptionDate: string;
};

/**
 * `afterLoad` roda com o documento já lido e ANTES da checagem de canal: o cancelamento da família autoriza o vínculo aqui,
 * para que pedido de outra família e pedido inexistente/de outro canal não se distingam por mensagens diferentes.
 */
export async function readOrder(tx: FirebaseFirestore.Transaction, db: Firestore, orderId: string, afterLoad?: (data: FirebaseFirestore.DocumentData) => Promise<void>): Promise<OrderState> {
  const ref = db.doc(`orders/${orderId}`);
  const snap = await tx.get(ref);
  const data = snap.data();
  if (!data || typeof data.studentId !== "string" || !Array.isArray(data.items)) throw notFound("order_not_found", "Pedido não encontrado.");
  await afterLoad?.(data);
  if (data.channel !== "advance") throw conflict("channel_not_supported", "Este comando atende pedidos antecipados.");
  const prep = data.prep === "preparing" || data.prep === "ready" ? (data.prep as PrepStage) : "none";
  return { ref, data, items: data.items as OrderItem[], status: String(data.status ?? "paid"), prep, version: Number(data.version ?? 1), consumptionDate: String(data.consumptionDate) };
}

export const itemsView = (items: readonly OrderItem[]) => items.map((i) => ({ lineNo: i.lineNo, quantity: i.quantity, deliveredQty: deliveredOf(i), remainingQty: remainingOf(i) }));

/**
 * Pedidos (que não este) com reserva ativa do produto, das datas mais distantes para as mais próximas, até somar o déficit.
 * A lista do estoque não serve aqui: ela lê o estado já gravado, em que a reserva deste pedido (liberada só em memória na
 * sessão) ainda aparece ativa. Só leituras (as gravações da sessão ficam para o `commit`).
 */
export async function otherOrdersCovering(db: Firestore, tx: FirebaseFirestore.Transaction, productId: string, orderId: string, shortfall: number): Promise<string[]> {
  const snap = await tx.get(db.collection(`stockBalances/${productId}/reservations`).where("status", "==", "active").limit(500));
  const rows = snap.docs
    .map((d) => ({ orderRef: String(d.get("orderRef")), date: String(d.get("consumptionDate")), remaining: Number(d.get("quantity") ?? 0) - Number(d.get("deliveredQty") ?? 0) - Number(d.get("releasedQty") ?? 0) }))
    .filter((r) => r.orderRef !== orderId && r.remaining > 0)
    .sort((a, b) => b.date.localeCompare(a.date) || a.orderRef.localeCompare(b.orderRef));
  const out: string[] = [];
  let covered = 0;
  for (const r of rows) {
    if (covered >= shortfall) break;
    out.push(r.orderRef);
    covered += r.remaining;
  }
  return out;
}
