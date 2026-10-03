import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain-error";
import type { ApiResult } from "@/lib/api-client";
import { parseBRLToCents } from "@/lib/money/parse";
import { decideStudentAction } from "@/modules/access/authorize";
import { applyDelta, checkLedger, MAX_BALANCE_CENTS, parseWalletState, planTransfer, transferSchema } from "@/modules/wallet/model";
import { executeWithRetry, isUncertain } from "@/modules/wallet/operation";
import type { LedgerEntryView } from "@/modules/wallet/queries";
import { applyReading, mergeEntries, syncState } from "@/modules/wallet/view";

const KEY = "chave-de-teste-1";

describe("modelo da carteira (centavos inteiros)", () => {
  it("transferência conserva o total, soma 1 na versão de cada carteira e não cria nem perde centavo", () => {
    const from = { balanceCents: 5000, version: 4 };
    const to = { balanceCents: 2001, version: 0 };
    const plan = planTransfer(from, to, 1250);
    expect(plan.from).toEqual({ balanceCents: 3750, version: 5 });
    expect(plan.to).toEqual({ balanceCents: 3251, version: 1 });
    expect(plan.from.balanceCents + plan.to.balanceCents).toBe(from.balanceCents + to.balanceCents);
  });

  it("saldo insuficiente é recusado (409 insufficient_balance) e transferir o saldo inteiro é permitido", () => {
    expect(() => planTransfer({ balanceCents: 99, version: 1 }, { balanceCents: 0, version: 0 }, 100)).toThrow(DomainError);
    try {
      applyDelta({ balanceCents: 0, version: 0 }, -1);
    } catch (error) {
      expect(error).toMatchObject({ code: "insufficient_balance", status: 409 });
    }
    expect(planTransfer({ balanceCents: 100, version: 1 }, { balanceCents: 0, version: 0 }, 100).from.balanceCents).toBe(0);
  });

  it("limite de saldo da carteira de destino e valores não inteiros nunca passam", () => {
    expect(() => applyDelta({ balanceCents: MAX_BALANCE_CENTS, version: 1 }, 1)).toThrow(DomainError);
    expect(() => applyDelta({ balanceCents: 10, version: 1 }, 0.5)).toThrow();
  });

  it("carteira corrompida não é corrigida em silêncio; documento inexistente é saldo 0, versão 0", () => {
    expect(parseWalletState(undefined)).toEqual({ balanceCents: 0, version: 0 });
    for (const bad of [{ balanceCents: -1, version: 1 }, { balanceCents: 1.5, version: 1 }, { balanceCents: "10", version: 1 }, { balanceCents: 10 }]) {
      expect(() => parseWalletState(bad)).toThrow("corrompida");
    }
  });

  it("valida o comando: origem ≠ destino, valor inteiro de 1 a 500000, chave segura", () => {
    const ok = { key: KEY, fromStudentId: "a", toStudentId: "b", amountCents: 100 };
    expect(transferSchema.parse(ok).reason).toBe("Transferência entre alunos");
    for (const bad of [{ toStudentId: "a" }, { amountCents: 0 }, { amountCents: -5 }, { amountCents: 1.5 }, { amountCents: 500_001 }, { key: "curta" }, { fromStudentId: "../x" }]) {
      expect(transferSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });

  it("reconcilia saldo × livro e acusa lacuna, saldo divergente e versão errada", () => {
    const rows = [
      { seq: 1, amountCents: 5000, balanceAfterCents: 5000 },
      { seq: 2, amountCents: -1250, balanceAfterCents: 3750 },
    ];
    expect(checkLedger({ balanceCents: 3750, version: 2 }, rows)).toEqual([]);
    expect(checkLedger({ balanceCents: 3751, version: 2 }, rows)).toHaveLength(1);
    expect(checkLedger({ balanceCents: 3750, version: 3 }, rows)).toHaveLength(1);
    expect(checkLedger({ balanceCents: 3750, version: 2 }, [rows[0]!, { ...rows[1]!, seq: 3 }]).length).toBeGreaterThan(0);
    expect(checkLedger({ balanceCents: 0, version: 0 }, [])).toEqual([]);
  });
});

describe("autorização de carteira (decisão pura com vínculo atual)", () => {
  const student = { status: "active", userUid: "alu" };
  const link = (uid: string, status = "active") => ({ guardianUid: uid, studentId: "s1", status });
  const decide = (role: "guardian" | "student" | "admin" | "cantina" | "secretaria", uid: string, action: "wallet.read" | "wallet.transfer", l?: ReturnType<typeof link>) =>
    decideStudentAction({ actor: { uid, role }, studentId: "s1", action, student, link: l, policy: undefined });

  it("transferir: só responsável vinculado ativo", () => {
    expect(decide("guardian", "g", "wallet.transfer", link("g"))).toBe(true);
    expect(decide("guardian", "g", "wallet.transfer", link("g", "revoked"))).toBe(false);
    expect(decide("guardian", "g", "wallet.transfer", link("outro"))).toBe(false);
    expect(decide("guardian", "g", "wallet.transfer")).toBe(false);
    for (const role of ["admin", "cantina", "secretaria"] as const) expect(decide(role, "x", "wallet.transfer")).toBe(false);
    expect(decide("student", "alu", "wallet.transfer")).toBe(false);
  });

  it("ler: responsável vinculado, o próprio aluno ou administração; cantina e secretaria não", () => {
    expect(decide("guardian", "g", "wallet.read", link("g"))).toBe(true);
    expect(decide("student", "alu", "wallet.read")).toBe(true);
    expect(decide("student", "outro", "wallet.read")).toBe(false);
    expect(decide("admin", "x", "wallet.read")).toBe(true);
    expect(decide("cantina", "x", "wallet.read")).toBe(false);
    expect(decide("secretaria", "x", "wallet.read")).toBe(false);
    expect(decide("guardian", "g", "wallet.read")).toBe(false);
  });
});

describe("reconciliação de leituras por versão do servidor (interface)", () => {
  it("snapshot atrasado ou resposta repetida nunca faz o saldo exibido regredir", () => {
    let view = applyReading(null, { balanceCents: 5000, version: 1, source: "read" });
    view = applyReading(view, { balanceCents: 3750, version: 2, source: "command" }); // resposta confirmada
    expect(view).toMatchObject({ balanceCents: 3750, version: 2 });
    view = applyReading(view, { balanceCents: 5000, version: 1, source: "listener" }); // snapshot antigo chega depois
    expect(view).toMatchObject({ balanceCents: 3750, version: 2 });
    view = applyReading(view, { balanceCents: 5000, version: 1, source: "read" }); // leitura antiga
    expect(view).toMatchObject({ balanceCents: 3750, version: 2 });
    view = applyReading(view, { balanceCents: 3750, version: 2, source: "command" }); // replay da mesma operação
    expect(view).toMatchObject({ balanceCents: 3750, version: 2 });
  });

  it("leitura mais nova (outra sessão) é adotada, mesmo vinda do listener antes da resposta", () => {
    let view = applyReading(null, { balanceCents: 5000, version: 1, source: "listener" });
    view = applyReading(view, { balanceCents: 2500, version: 3, source: "listener" });
    view = applyReading(view, { balanceCents: 3750, version: 2, source: "command" }); // resposta mais velha que o listener
    expect(view).toMatchObject({ balanceCents: 2500, version: 3 });
  });

  it("estado da leitura: conectando → atualizando (resposta à frente do listener) → em dia; cache não conta como listener", () => {
    let view = applyReading(null, { balanceCents: 5000, version: 1, source: "read" });
    expect(syncState(view)).toBe("connecting");
    view = applyReading(view, { balanceCents: 5000, version: 1, source: "listener", fromCache: true });
    expect(syncState(view)).toBe("connecting");
    view = applyReading(view, { balanceCents: 5000, version: 1, source: "listener" });
    expect(syncState(view)).toBe("live");
    view = applyReading(view, { balanceCents: 3750, version: 2, source: "command" });
    expect(syncState(view)).toBe("updating");
    expect(view.balanceCents).toBe(3750); // o saldo confirmado já é mostrado
    view = applyReading(view, { balanceCents: 3750, version: 2, source: "listener" });
    expect(syncState(view)).toBe("live");
  });

  it("extrato: união por ID, mais novo primeiro, sem duplicar o movimento vindo da resposta e do listener", () => {
    const entry = (seq: number, createdAt: string | null): LedgerEntryView => ({ id: `e${seq}`, seq, type: "transfer_out", amountCents: -100, balanceAfterCents: 900, counterpartStudentId: "b", reason: null, createdAt });
    const fromCommand = [entry(2, null)];
    const fromListener = [entry(2, "2026-10-02T12:00:00Z"), entry(1, "2026-10-02T11:00:00Z")];
    const merged = mergeEntries(fromCommand, fromListener);
    expect(merged.map((e) => e.seq)).toEqual([2, 1]);
    expect(merged[0]!.createdAt).toBe("2026-10-02T12:00:00Z");
    expect(mergeEntries(merged, fromCommand)[0]!.createdAt).toBe("2026-10-02T12:00:00Z");
    expect(mergeEntries([], Array.from({ length: 30 }, (_, i) => entry(i + 1, null)), 20)).toHaveLength(20);
  });
});

describe("operação financeira na interface: pendente, confirmada, recusada, incerta", () => {
  const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
  const fail = (status: number, error = "internal"): ApiResult<never> => ({ ok: false, status, error });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it("classifica incerto: rede, tempo esgotado e erro do servidor; recusa definitiva não é incerta", () => {
    for (const status of [0, 408, 429, 500, 503]) expect(isUncertain(fail(status))).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 422]) expect(isUncertain(fail(status))).toBe(false);
    expect(isUncertain(ok(1))).toBe(false);
  });

  it("resultado incerto repete a MESMA chamada até obter a resposta e confirma só então", async () => {
    let calls = 0;
    const outcome = await executeWithRetry(async () => (++calls < 3 ? fail(0, "network") : ok({ id: "t1" })), { sleep });
    expect(calls).toBe(3);
    expect(outcome).toEqual({ phase: "confirmed", data: { id: "t1" } });
  });

  it("recusa definitiva não é repetida; incerteza persistente termina como INCERTA (não como falha) após o limite", async () => {
    let calls = 0;
    expect(await executeWithRetry(async () => (calls++, fail(409, "insufficient_balance")), { sleep })).toEqual({ phase: "refused", status: 409, error: "insufficient_balance" });
    expect(calls).toBe(1);
    calls = 0;
    expect(await executeWithRetry(async () => (calls++, fail(500)), { maxAttempts: 4, sleep })).toEqual({ phase: "uncertain", attempts: 4 });
    expect(calls).toBe(4);
  });
});

describe("valor digitado em reais", () => {
  it("converte para centavos inteiros sem ponto flutuante e recusa o inválido", () => {
    expect(parseBRLToCents("12,50")).toBe(1250);
    expect(parseBRLToCents("12,5")).toBe(1250);
    expect(parseBRLToCents("12")).toBe(1200);
    expect(parseBRLToCents("1.234,56")).toBe(123456);
    expect(parseBRLToCents("R$ 0,10")).toBe(10);
    expect(parseBRLToCents("0,29")).toBe(29);
    for (const bad of ["", "0", "0,00", "-5", "1,234", "abc", "1.23", "12,5,0", "1e3", "12.50"]) expect(parseBRLToCents(bad)).toBeNull();
  });
});
