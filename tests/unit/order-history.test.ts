import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "@/modules/orders/history-cursor";
import {
  appendPage,
  compareNewestFirst,
  filtersFromParams,
  KNOWN_STATUSES,
  listFiltersSchema,
  reconcileFirstPage,
  relativeDay,
  statusesOf,
  statusInfo,
  type OrderView,
} from "@/modules/orders/history-model";

const order = (id: string, date: string, version = 1, status = "paid"): OrderView => ({
  orderId: id,
  studentId: "s1",
  studentName: "Ana",
  refundedCents: 0,
  consumptionDate: date,
  shiftId: "m",
  shiftName: "Manhã",
  channel: "advance",
  status,
  group: statusInfo(status).group,
  statusLabel: statusInfo(status).label,
  paymentState: statusInfo(status).payment,
  items: [],
  itemCount: 0,
  totalCents: 100,
  createdAt: null,
  version,
});
const ids = (list: readonly OrderView[]) => list.map((o) => o.orderId);

describe("situação do pedido (F12)", () => {
  it("distingue pago aguardando entrega de pagamento pendente, em rótulo e em campo", () => {
    expect(statusInfo("paid")).toMatchObject({ group: "pending", payment: "paid", label: "Pago · aguardando entrega" });
    expect(statusInfo("payment_pending")).toMatchObject({ group: "pending", payment: "pending", label: "Pagamento pendente" });
    expect(statusInfo("paid").label).not.toBe(statusInfo("payment_pending").label);
  });

  it("agrupa em Pendentes/Concluídos/Cancelados e trata situação futura/desconhecida sem quebrar", () => {
    expect(statusInfo("delivered").group).toBe("completed");
    expect(statusInfo("cancelled").group).toBe("cancelled");
    expect(statusInfo("algo_novo")).toMatchObject({ group: "pending", label: "Em andamento" });
    expect(statusesOf("all")).toBeNull();
    expect(statusesOf("pending")).toEqual(expect.arrayContaining(["paid", "preparing", "ready", "not_picked_up", "payment_pending"]));
    expect(statusesOf("pending")).not.toContain("delivered");
    expect([...statusesOf("pending")!, ...statusesOf("completed")!, ...statusesOf("cancelled")!].sort()).toEqual([...KNOWN_STATUSES].sort());
  });
});

describe("filtros e cursor", () => {
  it("valida filtros, ignora parâmetros vazios e recusa campos desconhecidos, datas inválidas e período invertido", () => {
    const parse = (q: string) => listFiltersSchema.safeParse(filtersFromParams(new URLSearchParams(q)));
    expect(parse("group=pending&studentId=&channel=").success).toBe(true);
    expect(parse("")).toMatchObject({ success: true, data: { group: "all", limit: 20 } });
    expect(parse("channel=pdv").success).toBe(false);
    expect(parse("status=inventado").success).toBe(false);
    expect(parse("from=2026-02-30").success).toBe(false);
    expect(parse("from=2026-10-05&to=2026-10-01").success).toBe(false);
    expect(parse("limit=0").success).toBe(false);
    expect(parse("limit=51").success).toBe(false);
    expect(parse("outro=1").success).toBe(false);
    expect(parse("studentId=../x").success).toBe(false);
  });

  it("cursor: ida e volta; lixo, JSON de outro formato e data inválida são recusados", () => {
    const cursor = { d: "2026-10-05", o: "ord_abc" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor("%%%")).toBeNull();
    expect(decodeCursor(Buffer.from('{"d":"2026-13-01","o":"x"}').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"d":"2026-10-05","o":"x","extra":1}').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("[1]").toString("base64url"))).toBeNull();
  });

  it("ordem: data e ID decrescentes, total e estável", () => {
    const list = [order("a", "2026-10-01"), order("c", "2026-10-02"), order("b", "2026-10-02")].sort(compareNewestFirst);
    expect(ids(list)).toEqual(["c", "b", "a"]);
  });

  it("destaca hoje e amanhã", () => {
    expect(relativeDay("2026-10-04", "2026-10-04", "2026-10-05")).toBe("Hoje");
    expect(relativeDay("2026-10-05", "2026-10-04", "2026-10-05")).toBe("Amanhã");
    expect(relativeDay("2026-10-06", "2026-10-04", "2026-10-05")).toBeNull();
  });
});

describe("reconciliação por versão", () => {
  it("resposta atrasada (versão menor) não faz o pedido regredir; versão maior vence", () => {
    const prev = [order("a", "2026-10-02", 3, "ready")];
    expect(reconcileFirstPage(prev, [order("a", "2026-10-02", 2, "paid")], false)[0]).toMatchObject({ version: 3, status: "ready" });
    expect(reconcileFirstPage(prev, [order("a", "2026-10-02", 4, "delivered")], false)[0]).toMatchObject({ version: 4, status: "delivered" });
  });

  it("pedido novo entra; no trecho coberto, pedido que saiu do filtro sai; páginas antigas já carregadas permanecem", () => {
    // primeira página relida cobre de 10-09 até 10-07 (há mais); a tela já tinha carregado também 10-06 e 10-05
    const prev = [order("p9", "2026-10-09"), order("p8", "2026-10-08"), order("p7", "2026-10-07"), order("p6", "2026-10-06"), order("p5", "2026-10-05")];
    const fresh = [order("novo", "2026-10-10"), order("p9", "2026-10-09"), order("p7", "2026-10-07")]; // p8 saiu do filtro
    expect(ids(reconcileFirstPage(prev, fresh, true))).toEqual(["novo", "p9", "p7", "p6", "p5"]);
    // sem mais páginas: a releitura cobre tudo e o que não veio saiu
    expect(ids(reconcileFirstPage(prev, fresh, false))).toEqual(["novo", "p9", "p7"]);
  });

  it("anexar página não duplica e ignora versão menor", () => {
    const current = [order("b", "2026-10-02", 2), order("a", "2026-10-01")];
    const next = appendPage(current, [order("a", "2026-10-01"), order("b", "2026-10-02", 1), order("z", "2026-09-30")]);
    expect(ids(next)).toEqual(["b", "a", "z"]);
    expect(next[0]!.version).toBe(2);
  });
});
