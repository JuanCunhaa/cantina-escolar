import { describe, expect, it } from "vitest";
import { addDays, isLocalDate, localDateOf, localInstant, weekdayOf } from "@/lib/dates/school-time";
import {
  DEFAULT_CUTOFFS,
  evaluatePurchase,
  isCancellationOpen,
  isOperatingDay,
  resolveCutoffs,
  snapshotPolicy,
  windowDates,
  type CalendarConfig,
} from "@/modules/school/calendar";

// America/Sao_Paulo = UTC-3 o ano todo desde 2019 (sem horário de verão). 2026-10-01 é quinta-feira.
const MORNING = DEFAULT_CUTOFFS.manha!;
const AFTERNOON = DEFAULT_CUTOFFS.tarde!;
const weekdaysOnly: CalendarConfig = { weekdays: [1, 2, 3, 4, 5], days: {} };
const at = (iso: string) => new Date(iso);

function purchase(now: string, date: string, cutoffs = MORNING, calendar = weekdaysOnly) {
  return evaluatePurchase({ now: at(now), date, shiftId: "shf_x", cutoffs, calendar });
}

describe("datas locais America/Sao_Paulo (A14: o fuso não desloca a data)", () => {
  it("23:59:59 local ainda é o mesmo dia; 00:00:00 local é o dia seguinte (UTC já virou 3 h antes)", () => {
    expect(localDateOf(at("2026-10-02T02:59:59.999Z"))).toBe("2026-10-01");
    expect(localDateOf(at("2026-10-02T03:00:00.000Z"))).toBe("2026-10-02");
    expect(localDateOf(at("2026-10-01T02:59:59Z"))).toBe("2026-09-30");
    expect(localDateOf(at("2026-12-31T23:30:00-03:00"))).toBe("2026-12-31");
    expect(localDateOf(at("2027-01-01T02:59:59Z"))).toBe("2026-12-31");
  });
  it("horário local vira instante UTC exato", () => {
    expect(localInstant("2026-10-01", "07:00").toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(localInstant("2026-10-01", "15:00").toISOString()).toBe("2026-10-01T18:00:00.000Z");
    expect(localInstant("2026-10-01", "23:59").toISOString()).toBe("2026-10-02T02:59:00.000Z");
    expect(localInstant("2026-10-01", "00:00").toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });
  it("rejeita data inexistente, formato errado e horário inválido", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "26-10-01", "2026-1-1", "", "2026-10-01T00:00"]) expect(isLocalDate(bad)).toBe(false);
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2027-02-29")).toBe(false);
    expect(() => localInstant("2026-10-01", "24:00")).toThrow();
    expect(() => localInstant("2026-10-01", "7:00")).toThrow();
    expect(() => localDateOf(new Date("x"))).toThrow();
  });
  it("soma de dias cruza mês, ano e bissexto; dia da semana", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(weekdayOf("2026-10-01")).toBe(4);
    expect(weekdayOf("2026-10-03")).toBe(6);
  });
});

describe("A12: horário de fechamento da compra (agora >= limite)", () => {
  it("manhã: 06:59:59.999 compra hoje; 07:00:00.000 não; amanhã sempre pode", () => {
    expect(purchase("2026-10-01T09:59:59.999Z", "2026-10-01").allowed).toBe(true);
    expect(purchase("2026-10-01T10:00:00.000Z", "2026-10-01")).toEqual({ allowed: false, reason: "after_cutoff" });
    expect(purchase("2026-10-01T10:00:00.001Z", "2026-10-01")).toEqual({ allowed: false, reason: "after_cutoff" });
    expect(purchase("2026-10-01T10:00:00.000Z", "2026-10-02").allowed).toBe(true);
  });
  it("tarde: limite 14:00; manhã e tarde têm horários independentes", () => {
    expect(purchase("2026-10-01T16:59:59.999Z", "2026-10-01", AFTERNOON).allowed).toBe(true);
    expect(purchase("2026-10-01T17:00:00.000Z", "2026-10-01", AFTERNOON)).toEqual({ allowed: false, reason: "after_cutoff" });
    // 10:30 local: manhã fechada, tarde aberta
    expect(purchase("2026-10-01T13:30:00Z", "2026-10-01", MORNING).allowed).toBe(false);
    expect(purchase("2026-10-01T13:30:00Z", "2026-10-01", AFTERNOON).allowed).toBe(true);
  });
  it("horário alterado no painel vale para a próxima avaliação", () => {
    const later = { purchaseCutoff: "08:30", cancelCutoff: "09:30" };
    expect(purchase("2026-10-01T10:00:00Z", "2026-10-01", later).allowed).toBe(true);
    expect(purchase("2026-10-01T11:30:00Z", "2026-10-01", later).allowed).toBe(false);
  });
});

describe("A13: cancelamento familiar (agora >= limite do snapshot do pedido)", () => {
  const snapshot = snapshotPolicy({ shiftId: "shf_x", date: "2026-10-01", cutoffs: MORNING, settingsVersion: 3 });
  it("08:00 e 15:00 são limites exatos", () => {
    expect(snapshot.cancelCutoffAt.toISOString()).toBe("2026-10-01T11:00:00.000Z");
    expect(isCancellationOpen(at("2026-10-01T10:59:59.999Z"), snapshot)).toBe(true);
    expect(isCancellationOpen(at("2026-10-01T11:00:00.000Z"), snapshot)).toBe(false);
    const tarde = snapshotPolicy({ shiftId: "shf_t", date: "2026-10-01", cutoffs: AFTERNOON, settingsVersion: 3 });
    expect(isCancellationOpen(at("2026-10-01T17:59:59.999Z"), tarde)).toBe(true);
    expect(isCancellationOpen(at("2026-10-01T18:00:00.000Z"), tarde)).toBe(false);
  });
  it("fechar compra (07:00) e cancelamento (08:00) são limites distintos", () => {
    const now = at("2026-10-01T10:30:00Z"); // 07:30 local
    expect(purchase(now.toISOString(), "2026-10-01").allowed).toBe(false);
    expect(isCancellationOpen(now, snapshot)).toBe(true);
  });
  it("pedido para dia futuro cancela até o limite do DIA do consumo", () => {
    const future = snapshotPolicy({ shiftId: "shf_x", date: "2026-10-05", cutoffs: MORNING, settingsVersion: 1 });
    expect(isCancellationOpen(at("2026-10-05T10:59:59Z"), future)).toBe(true);
    expect(isCancellationOpen(at("2026-10-05T11:00:00Z"), future)).toBe(false);
  });
  it("snapshot é estável: mudar o painel depois não altera o prazo já informado", () => {
    const before = snapshot.cancelCutoffAt.toISOString();
    snapshotPolicy({ shiftId: "shf_x", date: "2026-10-01", cutoffs: { purchaseCutoff: "06:00", cancelCutoff: "06:30" }, settingsVersion: 4 });
    expect(snapshot.cancelCutoffAt.toISOString()).toBe(before);
    expect(snapshot).toMatchObject({ timezone: "America/Sao_Paulo", purchaseCutoff: "07:00", cancelCutoff: "08:00", settingsVersion: 3 });
  });
});

describe("A14: janela hoje+7, dias sem funcionamento e fuso", () => {
  const NOW = "2026-10-01T12:00:00Z"; // quinta 09:00 local
  it("hoje+7 (quinta 08/10) permitido; hoje+8 negado; passado negado", () => {
    expect(purchase(NOW, "2026-10-08").allowed).toBe(true);
    expect(purchase(NOW, "2026-10-09")).toEqual({ allowed: false, reason: "beyond_window" });
    expect(purchase(NOW, "2026-09-30")).toEqual({ allowed: false, reason: "past_date" });
    expect(windowDates(at(NOW))).toHaveLength(8);
    expect(windowDates(at(NOW))[7]).toBe("2026-10-08");
  });
  it("às 23:30 locais (02:30Z do dia seguinte em UTC) a janela segue a data LOCAL", () => {
    const lateNight = "2026-10-02T02:30:00Z"; // quinta 01/10 23:30 local
    expect(purchase(lateNight, "2026-10-08").allowed).toBe(true);
    expect(purchase(lateNight, "2026-10-09")).toEqual({ allowed: false, reason: "beyond_window" });
    expect(purchase(lateNight, "2026-10-01")).toEqual({ allowed: false, reason: "after_cutoff" });
    expect(purchase("2026-10-02T03:00:00Z", "2026-10-01")).toEqual({ allowed: false, reason: "past_date" });
  });
  it("dia não letivo é negado e a janela NÃO vira sete dias úteis", () => {
    expect(purchase(NOW, "2026-10-03")).toEqual({ allowed: false, reason: "non_operating_day" }); // sábado
    expect(purchase(NOW, "2026-10-04")).toEqual({ allowed: false, reason: "non_operating_day" }); // domingo
    expect(purchase(NOW, "2026-10-12")).toEqual({ allowed: false, reason: "beyond_window" }); // 7º dia útil, fora dos 7 corridos
  });
  it("dia letivo extra habilita sábado; dia fechado bloqueia dia útil sem mexer na janela", () => {
    const calendar: CalendarConfig = { weekdays: [1, 2, 3, 4, 5], days: { "2026-10-03": "extra", "2026-10-07": "closed" } };
    expect(isOperatingDay(calendar, "2026-10-03")).toBe(true);
    expect(purchase(NOW, "2026-10-03", MORNING, calendar).allowed).toBe(true);
    expect(purchase(NOW, "2026-10-07", MORNING, calendar)).toEqual({ allowed: false, reason: "non_operating_day" });
    expect(purchase(NOW, "2026-10-08", MORNING, calendar).allowed).toBe(true);
    expect(purchase(NOW, "2026-10-09", MORNING, calendar).allowed).toBe(false);
  });
  it("dias da semana são configuráveis; data inválida é negada", () => {
    expect(purchase(NOW, "2026-10-03", MORNING, { weekdays: [6], days: {} }).allowed).toBe(true);
    expect(purchase(NOW, "2026-10-02", MORNING, { weekdays: [6], days: {} }).allowed).toBe(false);
    expect(purchase(NOW, "2026-02-30")).toEqual({ allowed: false, reason: "invalid_date" });
  });
  it("virada de mês e de ano na janela", () => {
    expect(purchase("2026-12-29T12:00:00Z", "2027-01-05").allowed).toBe(true);
    expect(purchase("2026-12-29T12:00:00Z", "2027-01-06")).toEqual({ allowed: false, reason: "beyond_window" });
  });
});

describe("horários por turno", () => {
  it("padrão por nome (manhã/tarde); turno desconhecido sem configuração = indisponível; configuração explícita vence", () => {
    expect(resolveCutoffs({ nameSlug: "manha" }, {}, "s1")).toEqual({ cutoffs: MORNING, source: "default" });
    expect(resolveCutoffs({ nameSlug: "tarde" }, {}, "s2")).toEqual({ cutoffs: AFTERNOON, source: "default" });
    expect(resolveCutoffs({ nameSlug: "integral" }, {}, "s3")).toBeNull();
    const custom = { purchaseCutoff: "06:30", cancelCutoff: "07:30" };
    expect(resolveCutoffs({ nameSlug: "manha" }, { s1: custom }, "s1")).toEqual({ cutoffs: custom, source: "configured" });
    expect(resolveCutoffs({ nameSlug: "integral" }, { s3: custom }, "s3")?.source).toBe("configured");
  });
});
