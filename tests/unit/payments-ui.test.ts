// Interface da recarga online e da revisão de pagamentos (F19), por RENDERIZAÇÃO no servidor (react-dom/server): sem navegador,
// sem rede, sem estado. Prova o que a família e a administração VEEM em cada estado: "em processamento" nunca aparece como
// crédito lançado; "Crédito lançado" só com a confirmação do servidor; revisão/reversão/pendência explicadas. O comportamento
// no navegador (polling, saldo por versão, carteira bloqueada) está em tests/e2e/payments-confirmation.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaymentsReviewView, type ReviewViewProps } from "@/modules/payments/components/payments-review";
import { IntentPanel } from "@/modules/payments/components/online-topup";
import type { IntentView } from "@/modules/payments/online/intent-commands";
import { STATUS_LABEL } from "@/modules/payments/online/intent-model";
import type { WalletSlot } from "@/modules/wallet/use-wallets";

const noop = () => undefined;
const money = (digits: string) => new RegExp(`R\\$\\s${digits}`);

function intent(over: Partial<IntentView> = {}): IntentView {
  const status = over.status ?? "awaiting_payment";
  return {
    intentId: "tpi_0123456789abcdef0123",
    channel: "pix",
    status,
    displayStatus: over.displayStatus ?? status,
    statusLabel: STATUS_LABEL[over.displayStatus ?? status],
    studentId: "stu_1",
    studentName: "Ana Teste",
    amountCents: 5000,
    currency: "BRL",
    providerMode: "live",
    createdAt: "2026-10-07T15:00:00.000Z",
    pix: status === "awaiting_payment" ? { copyPaste: "00020126PIXTESTE0123456789", qrImagePngBase64: "iVBORw0KGgo=", expiresAt: "2026-10-07T15:30:00.000Z" } : null,
    failure: null,
    needsReconcile: false,
    credited: false,
    credit: null,
    reversal: null,
    review: null,
    awaitingConfirmation: status === "awaiting_payment" || status === "processing",
    ...over,
  };
}
const render = (view: IntentView, wallet?: WalletSlot, checking = false) =>
  renderToStaticMarkup(createElement(IntentPanel, { intent: view, checking, copied: false, onCopy: noop, onReconcile: noop, wallet }));
const walletSlot = (balanceCents: number, version: number): WalletSlot => ({ view: { balanceCents, version, listenerVersion: version }, entries: [], sync: "live", listenerError: false, readError: false, pendingCents: 0 });

describe("recarga online: processamento × crédito lançado", () => {
  it("Pix aguardando: 'em processamento', QR e copia e cola, e NENHUMA menção a crédito lançado nem saldo", () => {
    const html = render(intent());
    expect(html).toContain("Aguardando pagamento");
    expect(html).toContain("Pagamento em processamento: nenhum crédito foi lançado ainda.");
    expect(html).toContain('data-testid="pix-copy"');
    expect(html).toContain("00020126PIXTESTE0123456789");
    expect(html).not.toContain("Crédito lançado");
    expect(html).not.toContain("topup-credited");
    expect(html).not.toContain("topup-wallet");
  });

  it("cartão em análise: 'ainda não é saldo' e nada de crédito, mesmo com saldo de carteira disponível na tela", () => {
    const html = render(intent({ channel: "card", status: "processing" }), walletSlot(5000, 3));
    expect(html).toContain("Ainda não é saldo");
    expect(html).not.toContain("Crédito lançado");
    expect(html).not.toContain("Saldo atual da carteira"); // saldo da carteira só aparece depois do crédito confirmado
  });

  it("crédito lançado: valor, saldo depois do crédito e saldo atual com a versão da carteira; Pix some", () => {
    const credit = { amountCents: 5000, walletEntryId: "tpi_0123456789abcdef0123_credit", walletSeq: 4, balanceAfterCents: 7500, confirmedAt: "2026-10-07T15:10:00.000Z", afterExpiry: false };
    const html = render(intent({ status: "confirmed", credited: true, credit, awaitingConfirmation: false }), walletSlot(7500, 4));
    expect(html).toContain("Crédito lançado");
    expect(html).toMatch(money("50,00"));
    expect(html).toMatch(money("75,00"));
    expect(html).toContain('data-wallet-seq="4"');
    expect(html).toContain('data-version="4"');
    expect(html).toContain("Saldo atual da carteira");
    expect(html).not.toContain("pix-copy");
    expect(html).not.toContain("nenhum crédito foi lançado");
  });

  it("pagamento tardio é explicado; devolução parcial mostra o valor devolvido", () => {
    const credit = { amountCents: 5000, walletEntryId: "x_credit", walletSeq: 1, balanceAfterCents: 5000, confirmedAt: "2026-10-07T15:10:00.000Z", afterExpiry: true };
    const html = render(intent({ status: "confirmed", credited: true, credit, awaitingConfirmation: false, reversal: { accountedCents: 2000, recoveredCents: 2000, pendingCents: 0, cause: "refund" } }));
    expect(html).toContain("creditado mesmo assim, uma única vez");
    expect(html).toContain("Parte do pagamento foi devolvida");
    expect(html).toMatch(money("20,00"));
    expect(html).not.toContain("Saldo atual da carteira"); // sem leitura da carteira ainda
  });

  it("revertida: reembolso × chargeback e a pendência que bloqueia novas compras", () => {
    const base = { status: "reversed" as const, credited: true, awaitingConfirmation: false };
    const refund = render(intent({ ...base, reversal: { accountedCents: 5000, recoveredCents: 5000, pendingCents: 0, cause: "refund" } }));
    expect(refund).toContain("Este pagamento foi devolvido");
    expect(refund).not.toContain("bloqueadas");
    const chargeback = render(intent({ ...base, reversal: { accountedCents: 5000, recoveredCents: 1200, pendingCents: 3800, cause: "chargeback" } }));
    expect(chargeback).toContain("Este pagamento foi contestado (chargeback)");
    expect(chargeback).toMatch(money("38,00"));
    expect(chargeback).toContain("novas compras ficam bloqueadas");
    expect(render(intent({ ...base, reversal: null }))).toContain("saiu da carteira");
  });

  it("em revisão: deixa claro que NENHUM crédito foi lançado e o motivo", () => {
    const html = render(intent({ status: "in_review", awaitingConfirmation: false, review: { reason: "amount_mismatch", label: "Valor pago diferente do valor da recarga" } }));
    expect(html).toContain("Valor pago diferente do valor da recarga");
    expect(html).toContain("Nenhum crédito foi lançado ainda.");
    expect(html).not.toContain("Crédito lançado");
    expect(render(intent({ status: "in_review", awaitingConfirmation: false, review: null }))).toContain("divergência");
  });

  it("Pix vencido: continua conferindo com o provedor; criação incerta e falha mantêm as ações e mensagens", () => {
    const expired = render(intent({ displayStatus: "expired", pix: null }));
    expect(expired).toContain("Este Pix venceu");
    expect(expired).toContain("Seguimos conferindo com o provedor");
    expect(render(intent({ status: "expired", displayStatus: "expired", awaitingConfirmation: false, pix: null }))).not.toContain("Seguimos conferindo");
    const uncertain = render(intent({ status: "creation_uncertain", pix: null, awaitingConfirmation: false, needsReconcile: true }), undefined, true);
    expect(uncertain).toContain("Conferindo…");
    expect(uncertain).toContain("Tentar gerar o mesmo Pix");
    expect(render(intent({ channel: "card", status: "creation_uncertain", pix: null, awaitingConfirmation: false }))).not.toContain("Tentar gerar o mesmo Pix");
    const failed = render(intent({ status: "failed", pix: null, awaitingConfirmation: false, failure: { code: "card_declined", message: "Pagamento recusado. Nenhum crédito foi lançado." } }));
    expect(failed).toContain("Nenhum crédito foi lançado.");
    expect(failed).not.toContain("Crédito lançado");
  });
});

describe("revisão administrativa dos pagamentos online", () => {
  const pendency = { pendencyId: "tpi_a", intentId: "tpi_a", studentId: "stu_1", studentName: "Ana Teste", cause: "chargeback" as const, status: "open" as const, openedCents: 3800, outstandingCents: 3800, recoveredCents: 0, writtenOffCents: 0, walletBalanceCents: 0, createdAt: "2026-10-07T15:00:00.000Z" };
  const review = { intentId: "tpi_b", studentId: "stu_2", studentName: "Beto Teste", amountCents: 5000, channel: "pix" as const, reason: "amount_mismatch" as const, label: "Valor pago diferente do valor da recarga", providerStatus: "processed/accredited", createdAt: "2026-10-07T14:00:00.000Z" };
  const props = (over: Partial<ReviewViewProps> = {}): ReviewViewProps => ({
    pendencies: [pendency],
    reviews: [review],
    message: null,
    uncertain: false,
    locked: false,
    sweeping: false,
    open: null,
    reason: "",
    onOpen: noop,
    onReason: noop,
    onResolve: noop,
    onReconcile: noop,
    ...over,
  });
  const html = (over: Partial<ReviewViewProps> = {}) => renderToStaticMarkup(createElement(PaymentsReviewView, props(over)));

  it("lista pendência (causa, em aberto, saldo atual, bloqueio) e divergência (motivo, sem crédito); sem saldo não desconta", () => {
    const out = html();
    expect(out).toContain("Contestação (chargeback)");
    expect(out).toMatch(money("38,00"));
    expect(out).toContain("a carteira está bloqueada para novas compras");
    expect(out).toContain("Valor pago diferente do valor da recarga");
    expect(out).toContain("nenhum crédito foi lançado");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Descontar do saldo atual/);
    expect(out).toContain("Absorver o valor");
  });

  it("com saldo habilita descontar; painel de regularização explica o efeito de cada ação e pede motivo", () => {
    const withBalance = { ...pendency, walletBalanceCents: 1500, cause: "refund" as const };
    expect(html({ pendencies: [withBalance] })).not.toMatch(/<button[^>]*disabled[^>]*>Descontar do saldo atual/);
    expect(html({ pendencies: [withBalance] })).toContain("Reembolso");
    const recover = html({ pendencies: [withBalance], open: { id: "tpi_a", action: "recover" }, reason: "Motivo escrito" });
    expect(recover).toContain("com novo lançamento no livro");
    expect(recover).toContain('value="Motivo escrito"');
    const writeOff = html({ open: { id: "tpi_a", action: "write_off" } });
    expect(writeOff).toContain("A escola absorve");
    expect(writeOff).toContain("não há lançamento no livro");
    expect(html({ open: { id: "outra", action: "recover" } })).not.toContain("payments-resolve");
  });

  it("estado vazio, mensagens, resposta perdida e bloqueio de botões durante o envio", () => {
    const empty = html({ pendencies: [], reviews: [] });
    expect(empty).toContain("Nenhuma pendência aberta.");
    expect(empty).toContain("Nenhum pagamento em revisão.");
    expect(html({ message: { kind: "error", text: "Informe o motivo" } })).toContain('role="alert"');
    expect(html({ message: { kind: "ok", text: "Valor absorvido" } })).toContain('role="status"');
    expect(html({ uncertain: true })).toContain("Sem resposta do servidor");
    const busy = html({ locked: true, sweeping: true });
    expect(busy).toContain("Conciliando…");
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Consultar de novo/);
  });
});
